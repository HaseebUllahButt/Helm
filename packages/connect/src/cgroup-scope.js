import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { HELM_DIR } from './paths.js';

/**
 * One memory group (a systemd scope) per terminal, agent process and Codex
 * daemon.
 *
 * On 2026-11-11 the Laptop ran out of memory. systemd-oomd stops a whole
 * group, and the native terminal host held every terminal, every build
 * started in them and the Codex daemon in one group: it stopped 3440
 * processes at once, three working Codex helpers with them. With a group
 * each, oomd stops only the one that uses the most.
 *
 * Only grouping changes here: no memory limits, no waits. A scope is not a
 * child of the host's unit, so it outlives Helm restarts as before. Linux
 * with a systemd user manager only; anywhere else, or when systemd-run is
 * missing or refuses, processes start exactly as before.
 */

const TAG = createHash('sha256').update(HELM_DIR).digest('hex').slice(0, 10);
const CGROUP_ROOT = '/sys/fs/cgroup';
/** systemd's message ids: oomd stopped a unit; the kernel's OOM killer hit one. */
const OOMD_KILL = 'd989611b15e44c9dbf31e3c81256e4ed';
const KERNEL_OOM = 'fe6faa94e7774663a0da52717891d8ef';

/** Plain words for a stop by the memory guard. */
export const MEMORY_STOP = 'The computer ran out of memory, and its memory guard stopped this program to free memory. Other programs kept running.';

let probe = null;

function onPath(name, path = process.env.PATH) {
  for (const dir of String(path || '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch { /* not here */ }
  }
  return null;
}

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

function enabled() {
  if (process.platform !== 'linux' || !process.env.XDG_RUNTIME_DIR) return false;
  if (process.env.HELM_SCOPES === '1') return true;
  // Tests run hosts as plain children; they ask for scopes by name.
  return !process.env.HELM_NO_SCOPES && !process.env.HELM_NO_SYSTEMD_RUN;
}

/**
 * Whether scopes work here: the path to systemd-run, or null. Checked once
 * per process with a real scope, because a user manager can be missing or
 * refuse (no D-Bus, a container) even where the binary exists.
 */
export function scopesReady() {
  if (probe) return probe;
  probe = (async () => {
    if (!enabled()) return null;
    const bin = onPath('systemd-run');
    if (!bin) return null;
    const ok = await run(bin, ['--user', '--scope', '--quiet', '--collect', `--unit=${unitName('probe', String(process.pid))}`, '--', 'true']);
    return ok === null ? null : bin;
  })();
  return probe;
}

/** For tests: forget the cached answer. */
export function resetScopes() { probe = null; }

/** A unit name of this Helm's own: a test copy never reuses a real one. */
export function unitName(kind, id) {
  return `${scopePrefix(kind, id)}${randomBytes(3).toString('hex')}.scope`;
}

/**
 * The start of every scope name one id gets. The end is random: a stray
 * process left in an old scope must not block the next start. Any Helm
 * process can rebuild this from the id alone, after a restart too.
 */
export function scopePrefix(kind, id) {
  return `helm-${kind}-${TAG}-${String(id).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40)}-`;
}

/**
 * The command that starts `cmd` in a scope of its own, or null to start it
 * as before. systemd-run execs the command in place: same pid, same pty,
 * same pipes and environment. A command that cannot be found is left
 * alone, so the caller still sees "not found" rather than a quick exit.
 */
export async function scopeCommand(kind, id, cmd, args = [], env = process.env) {
  const bin = await scopesReady();
  if (!bin || !cmd) return null;
  const file = isAbsolute(cmd) ? cmd : (cmd.includes('/') ? null : onPath(cmd, env?.PATH ?? process.env.PATH));
  if (!file) return null;
  try { accessSync(file, constants.X_OK); } catch { return null; }
  const unit = unitName(kind, id);
  return { cmd: bin, args: ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', file, ...args], unit };
}

/**
 * systemd-run finds the user manager through these. A pty started with an
 * exact environment may not carry them; add only what is missing.
 */
export function scopeEnv(env) {
  const out = { ...env };
  for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (!out[k] && process.env[k]) out[k] = process.env[k];
  return out;
}

/**
 * Units the memory guard (systemd-oomd) or the kernel stopped for memory
 * since a time, read from the user journal. Empty when there is no journal.
 */
export async function memoryStops(sinceMs) {
  if (process.platform !== 'linux') return [];
  const out = await run('journalctl', ['--user', '-q', '--no-pager', '-o', 'json', `--since=@${Math.floor(sinceMs / 1000)}`,
    `MESSAGE_ID=${OOMD_KILL}`, `MESSAGE_ID=${KERNEL_OOM}`]);
  if (!out) return [];
  const units = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e.USER_UNIT || e.UNIT) units.push(e.USER_UNIT || e.UNIT); } catch { /* torn */ }
  }
  return units;
}

/**
 * Whether one of these units (exact names, or prefixes ending in '-') was
 * stopped for memory. The manager writes its line just after the kill, so
 * a SIGKILL that is not in the journal yet is asked about twice more.
 */
export async function stoppedForMemory(units, { since, killed = true, waits = [1000, 2000], stops = memoryStops } = {}) {
  const wanted = units.filter(Boolean);
  if (!wanted.length) return false;
  const match = (u) => wanted.some((w) => (w.endsWith('-') ? u.startsWith(w) : u === w));
  for (let i = 0; ; i++) {
    if ((await stops(since - 5000)).some(match)) return true;
    if (!killed || i >= waits.length) return false;
    await new Promise((r) => setTimeout(r, waits[i]));
  }
}

/** Prefix of the scopes this Helm gives Codex daemons. */
export const CODEX_SCOPE_PREFIX = `helm-codex-${TAG}-`;

let mainOf = null;
/** Whether this process is the main process of its own Helm unit. */
async function mainOfUnit(unit, pattern) {
  if (!pattern.test(unit)) return false;
  mainOf ??= run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit]).then((out) => Number(out?.trim()) === process.pid);
  return mainOf;
}

function ownCgroup() {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
    return line ? line.slice(3) : null;
  } catch { return null; }
}

const readPids = (dir) => {
  try { return readFileSync(join(dir, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
};
const parentOf = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch { return 0; }
};
const isCodexDaemon = (pid) => {
  try {
    if (!readFileSync(`/proc/${pid}/comm`, 'utf8').startsWith('codex')) return false;
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return argv.includes('app-server') && (argv.includes('--managed-daemon') || argv.includes('pid-update-loop'));
  } catch { return false; }
};

/**
 * Give each Codex daemon found in this process's own group, or in this
 * Helm's scopes, a scope of its own. Codex starts its shared daemon itself,
 * from whichever command ran first, so it lands in that program's group:
 * on 2026-11-11 it sat in the native terminal host and died with it.
 * Only this Helm's groups are read; a test copy never moves the owner's.
 */
export async function adoptCodexDaemons({ includeOwn = true, includeScopes = true } = {}) {
  if (!(await scopesReady())) return [];
  const own = ownCgroup();
  if (!own || own === '/') return [];
  const parent = own.slice(0, own.lastIndexOf('/'));
  const dirs = [];
  // Helm's units (the daemon and the hosts systemd-run started) only when
  // this process is the main process of one: the real units carry no
  // per-copy name, and a test copy started by an agent sits inside them.
  const helmUnit = /^helm-.*\.service$/;
  const real = includeOwn && await mainOfUnit(own.slice(own.lastIndexOf('/') + 1), helmUnit);
  try {
    for (const name of readdirSync(join(CGROUP_ROOT, parent))) {
      if (real && helmUnit.test(name)) dirs.push(join(CGROUP_ROOT, parent, name));
      else if (includeScopes && name.includes(`-${TAG}-`) && name.endsWith('.scope') && !name.startsWith(CODEX_SCOPE_PREFIX)) dirs.push(join(CGROUP_ROOT, parent, name));
    }
  } catch { /* no cgroup tree */ }
  const moved = [];
  for (const dir of dirs) {
    const pids = readPids(dir);
    if (!pids.length) continue;
    const roots = pids.filter(isCodexDaemon);
    if (!roots.length) continue;
    const parents = new Map(pids.map((p) => [p, parentOf(p)]));
    for (const root of roots) {
      const tree = [root];
      for (const p of pids) {
        for (let up = parents.get(p), hops = 0; up && hops < 64; up = parents.get(up), hops++) {
          if (up === root) { tree.push(p); break; }
        }
      }
      const unit = `${CODEX_SCOPE_PREFIX}${root}.scope`;
      const ok = await run('busctl', ['--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))', unit, 'fail', '3',
        'PIDs', 'au', String(tree.length), ...tree.map(String),
        'CollectMode', 's', 'inactive-or-failed',
        'Description', 's', 'Codex daemon (own memory group, Helm)', '0']);
      if (ok !== null) moved.push({ unit, pids: tree });
    }
  }
  return moved;
}

/** Look for Codex daemons now and then. Returns a stop function. */
export function watchCodexDaemons({ every = 20_000, includeOwn = true, includeScopes = true } = {}) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await adoptCodexDaemons({ includeOwn, includeScopes }); } catch { /* best effort */ } finally { busy = false; }
  };
  const timer = setInterval(tick, every);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
