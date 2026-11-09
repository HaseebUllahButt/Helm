import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
export const TCP_RECOVERY_FILE = '/etc/sysctl.d/90-helm-tcp-mtu.conf';
const LIVE = '/proc/sys/net/ipv4/tcp_mtu_probing';

// No paths, commands or settings supplied by a peer enter this privileged
// operation. Mode 1 only reduces packet sizes after loss; mode 2, if already
// chosen by the administrator, must never be downgraded. Persist before
// applying, so a crash or reboot cannot lose the protection.
export const TCP_RECOVERY_SCRIPT = `set -eu
file=${TCP_RECOVERY_FILE}
[ ! -L "$file" ] || { echo 'refusing a symlink at the Helm sysctl file' >&2; exit 1; }
current=$(cat ${LIVE})
case "$current" in 0|1) mode=1 ;; 2) mode=2 ;; *) exit 1 ;; esac
[ "\${1:-1}" != 2 ] || mode=2
if [ -e "$file" ]; then
  saved=$(awk '
    /^[[:space:]]*(#|$)/ { next }
    { gsub(/[[:space:]]/, ""); if ($0 !~ /^net[.]ipv4[.]tcp_mtu_probing=[12]$/ || seen++) exit 1; value=substr($0,length($0),1) }
    END { if (!seen) exit 1; print value }
  ' "$file") || { echo 'preserving an unrecognized Helm sysctl file' >&2; exit 1; }
  [ "$saved" != 2 ] || mode=2
fi
temporary=$(mktemp /etc/sysctl.d/.helm-tcp-mtu.XXXXXX)
trap 'rm -f "$temporary"' EXIT
printf '# Helm: recover connections when a network silently drops larger TCP packets.\\nnet.ipv4.tcp_mtu_probing = %s\\n' "$mode" > "$temporary"
chmod 0644 "$temporary"
mv "$temporary" "$file"
sysctl -w "net.ipv4.tcp_mtu_probing=$mode"
`;

function savedMode(text) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  return lines.length === 1 ? Number(/^net\.ipv4\.tcp_mtu_probing\s*=\s*([12])$/.exec(lines[0])?.[1]) || null : null;
}

/** Respect existing distribution/admin policy, not just Helm's own file. */
export async function configuredTcpRecovery({ read = readFile, list = readdir } = {}) {
  const files = new Map();
  // A higher-priority directory replaces the same basename; the resulting
  // files are applied by basename. procps then reads /etc/sysctl.conf last.
  for (const directory of ['/lib/sysctl.d', '/usr/lib/sysctl.d', '/usr/local/lib/sysctl.d', '/run/sysctl.d', '/etc/sysctl.d']) {
    for (const name of await list(directory).catch(() => [])) {
      if (name.endsWith('.conf')) files.set(name, join(directory, name));
    }
  }
  const paths = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, path]) => path);
  const texts = await Promise.all([...paths, '/etc/sysctl.conf'].map(path => read(path, 'utf8').catch(() => '')));
  let mode = null;
  for (const text of texts) for (const line of String(text).split('\n')) {
    const match = /^\s*-?net[./]ipv4[./]tcp_mtu_probing\s*=\s*([012])\s*(?:[#;].*)?$/.exec(line);
    if (match) mode = Number(match[1]);
  }
  return mode;
}

/** Best effort without password prompts in services. Tests never change the OS. */
export async function ensureTcpRecovery({
  os = platform(), env = process.env, uid = process.getuid?.(), interactive = false,
  read = readFile, run = exec, configured = configuredTcpRecovery,
} = {}) {
  if (os !== 'linux' || env.HELM_NO_SERVICE === '1' || env.NODE_TEST_CONTEXT) return { supported: false };
  const inspect = async () => {
    const [live, saved, configuredMode] = await Promise.all([
      read(LIVE, 'utf8').catch(() => ''), read(TCP_RECOVERY_FILE, 'utf8').catch(() => ''),
      configured().catch(() => null),
    ]);
    const mode = /^[012]$/.test(String(live).trim()) ? Number(String(live).trim()) : null;
    const persistentMode = configuredMode ?? savedMode(saved);
    return { supported: mode !== null, enabled: mode === 1 || mode === 2,
      persistent: persistentMode === 1 || persistentMode === 2, mode, persistentMode };
  };
  let status = await inspect();
  if (!status.supported || (status.enabled && status.persistent && status.persistentMode >= status.mode)) return status;
  try {
    const args = ['-c', TCP_RECOVERY_SCRIPT, 'helm-network-repair', status.persistentMode === 2 ? '2' : '1'];
    await run(uid === 0 ? '/bin/sh' : 'sudo',
      uid === 0 ? args : [...(interactive ? [] : ['-n']), '/bin/sh', ...args],
      { timeout: interactive ? 120_000 : 5000, maxBuffer: 16 * 1024 });
    status = await inspect();
  } catch (error) {
    status = await inspect();
    status.reason = String(error.stderr || error.message || error).trim().slice(0, 500);
  }
  if (!status.enabled || !status.persistent || status.persistentMode < status.mode) {
    status.repair = 'helm network-repair';
    status.reason ||= 'TCP packet-size recovery is not enabled and saved.';
  }
  return status;
}

export const FAST_TCP_FILE = '/etc/sysctl.d/90-helm-bbr.conf';
const LIVE_CONTROL = '/proc/sys/net/ipv4/tcp_congestion_control';
const AVAILABLE_CONTROL = '/proc/sys/net/ipv4/tcp_available_congestion_control';

// The Linux default (cubic) slows down at each lost packet. On a lossy link
// it sent 21-33 KB/s from the VM to why; BBR sent 173-296 KB/s on the same
// link (2026-11-09). It changes only how this machine sends. The script
// takes nothing from a peer, persists before it applies, and leaves a
// symlink or another file at Helm's path alone.
export const FAST_TCP_SCRIPT = `set -eu
file=${FAST_TCP_FILE}
[ ! -L "$file" ] || { echo 'refusing a symlink at the Helm sysctl file' >&2; exit 1; }
modprobe tcp_bbr 2>/dev/null || true
grep -qw bbr ${AVAILABLE_CONTROL} || { echo 'this kernel has no BBR' >&2; exit 1; }
temporary=$(mktemp /etc/sysctl.d/.helm-bbr.XXXXXX)
trap 'rm -f "$temporary"' EXIT
printf '# Helm: keep sending fast on links that lose packets.\\nnet.core.default_qdisc = fq\\nnet.ipv4.tcp_congestion_control = bbr\\n' > "$temporary"
chmod 0644 "$temporary"
mv "$temporary" "$file"
if [ -d /etc/modules-load.d ]; then printf 'tcp_bbr\\n' > /etc/modules-load.d/helm-bbr.conf; fi
sysctl -w net.core.default_qdisc=fq >/dev/null || true
sysctl -w net.ipv4.tcp_congestion_control=bbr
`;

/** A congestion control an administrator chose in a file of their own, or null. */
export async function configuredCongestion({ read = readFile, list = readdir } = {}) {
  const files = new Map();
  for (const directory of ['/lib/sysctl.d', '/usr/lib/sysctl.d', '/usr/local/lib/sysctl.d', '/run/sysctl.d', '/etc/sysctl.d']) {
    for (const name of await list(directory).catch(() => [])) {
      if (name.endsWith('.conf')) files.set(name, join(directory, name));
    }
  }
  const paths = [...files].filter(([name]) => join('/etc/sysctl.d', name) !== FAST_TCP_FILE)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, path]) => path);
  const texts = await Promise.all([...paths, '/etc/sysctl.conf'].map(path => read(path, 'utf8').catch(() => '')));
  let chosen = null;
  for (const text of texts) for (const line of String(text).split('\n')) {
    const match = /^\s*-?net[./]ipv4[./]tcp_congestion_control\s*=\s*([\w-]+)\s*(?:[#;].*)?$/.exec(line);
    if (match) chosen = match[1];
  }
  return chosen;
}

/** Turn on BBR when Linux still uses its default. Best effort, as ensureTcpRecovery. */
export async function ensureFastTcp({
  os = platform(), env = process.env, uid = process.getuid?.(), interactive = false,
  read = readFile, run = exec, configured = configuredCongestion,
} = {}) {
  if (os !== 'linux' || env.HELM_NO_SERVICE === '1' || env.NODE_TEST_CONTEXT) return { supported: false };
  const inspect = async () => {
    const [live, saved, chosen] = await Promise.all([
      read(LIVE_CONTROL, 'utf8').catch(() => ''), read(FAST_TCP_FILE, 'utf8').catch(() => ''),
      configured().catch(() => null),
    ]);
    const control = String(live).trim() || null;
    return { supported: !!control, control, enabled: control === 'bbr',
      persistent: /^\s*net\.ipv4\.tcp_congestion_control\s*=\s*bbr\s*$/m.test(String(saved)), chosen };
  };
  let status = await inspect();
  // Someone chose a congestion control on purpose; that is theirs to keep.
  if (!status.supported || (status.chosen && status.chosen !== 'bbr')) return status;
  if (status.enabled && (status.persistent || status.chosen === 'bbr')) return status;
  try {
    const args = ['-c', FAST_TCP_SCRIPT, 'helm-network-repair'];
    await run(uid === 0 ? '/bin/sh' : 'sudo',
      uid === 0 ? args : [...(interactive ? [] : ['-n']), '/bin/sh', ...args],
      { timeout: interactive ? 120_000 : 5000, maxBuffer: 16 * 1024 });
    status = await inspect();
  } catch (error) {
    status = await inspect();
    status.reason = String(error.stderr || error.message || error).trim().slice(0, 500);
  }
  if (!status.enabled || !(status.persistent || status.chosen === 'bbr')) {
    status.repair = 'helm network-repair';
    status.reason ||= 'Fast sending on lossy links (BBR) is not on and saved.';
  }
  return status;
}
