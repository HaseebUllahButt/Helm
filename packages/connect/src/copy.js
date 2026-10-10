import { spawn, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { platform, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { requireNetwork } from '@helm/protocol/network';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
import { expand, KEY_FILE, HELM_DIR } from './paths.js';

const USAGE = 'usage: helm copy <machine> <file-or-folder> --target-folder <absolute-path> [--exclude <pattern>] [--dry-run] [--direct|--relay|--ssh] [--retries 0-5]';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
const KEY_B64 = /^[A-Za-z0-9_-]{40,512}$/;
const RETRYABLE = new Set([10, 12, 30, 35, 255]);
const STDERR_TAIL = 8 * 1024;
const PERMANENT_MARK = 'helm copy-proxy: permanent:';
const LEGACY_PERMANENT = /permission denied|host key verification failed|no matching host key type|command not found|rsync:\s*not found|unsupported option|unknown option|operation not permitted|authentication failed/i;

function checkRsyncVersion() {
  const found = spawnSync('rsync', ['--version'], { encoding: 'utf8' });
  const ver = /version (\d+)\.(\d+)\.(\d+)/.exec(found.stdout ?? '');
  if (found.error || found.status !== 0 || !ver) {
    throw new Error('helm copy: rsync 3.2.3 or newer is required on this machine - install rsync and retry');
  }
  const [maj, min, patch] = ver.slice(1).map(Number);
  if (maj < 3 || (maj === 3 && min < 2) || (maj === 3 && min === 2 && patch < 3)) {
    throw new Error(`helm copy: rsync 3.2.3 or newer is required on this machine (found ${maj}.${min}.${patch})`);
  }
}

export function parseCopyArgs(args) {
  const positional = [];
  const excludes = [];
  let targetFolder, dryRun = false, mode = null, retries = 2;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--direct' || arg === '--relay' || arg === '--ssh') {
      if (mode) throw new Error('helm copy: --direct, --relay and --ssh are mutually exclusive');
      mode = arg.slice(2);
      continue;
    }
    if (arg === '--target-folder' || arg === '--exclude' || arg === '--retries') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`helm copy: ${arg} needs a value`);
      if (arg === '--exclude') excludes.push(value);
      else if (arg === '--retries') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error('helm copy: --retries is 0..5');
        retries = n;
      } else {
        if (targetFolder !== undefined) throw new Error('helm copy: one --target-folder only');
        targetFolder = value;
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`helm copy: unknown flag ${arg}`);
    positional.push(arg);
  }
  if (positional.length !== 2 || !targetFolder) throw new Error(`helm copy: ${USAGE}`);
  if (!targetFolder.startsWith('/') || /[\u0000-\u001f\u007f]/.test(targetFolder) || resolve(targetFolder) === '/') {
    throw new Error('helm copy: --target-folder must be an absolute destination folder, not /');
  }
  return { machine: positional[0], source: positional[1], targetFolder, excludes, dryRun, mode, retries };
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function copySpec(options, net = requireNetwork()) {
  const peers = Object.values(net.machines ?? {})
    .filter((m) => m.name === options.machine || m.id === options.machine);
  if (peers.length !== 1) throw new Error(`helm copy: ${options.machine} did not match one exact machine - see helm machines`);
  const peer = peers[0];
  if (peer.id === net.self || net.revoked?.[peer.id]) {
    throw new Error('helm copy: choose another current machine from `helm machines`');
  }
  const targetFolder = resolve(options.targetFolder);
  if (targetFolder === '/') throw new Error('helm copy: --target-folder must be a folder, not the filesystem root');
  const sourcePath = resolve(expand(options.source ?? options.folder));
  let stat;
  try { stat = lstatSync(sourcePath); } catch { throw new Error(`helm copy: ${options.source} is not readable here`); }
  let source;
  if (stat.isDirectory()) source = `${sourcePath}/`;
  else if (stat.isFile()) source = sourcePath;
  else throw new Error('helm copy: the source must be a regular file or folder, not a link or special file');
  const rsyncFlags = ['-a', '--no-owner', '--no-group', '--protect-args', '--mkpath',
    '--compress', '--compress-level=1', '--partial-dir=.helm-transfer-partial',
    '--info=progress2', '--stats', '--timeout=120'];
  const excludes = options.excludes.flatMap((pattern) => ['--exclude', pattern]);
  // A send-to-machine of a big project names its files (git's view of the
  // tree plus .git); -r makes the listed .git folder travel whole.
  if (options.filesFrom) {
    if (!stat.isDirectory()) throw new Error('helm copy: a file list needs a source folder');
    excludes.unshift(`--files-from=${options.filesFrom}`, '--from0', '-r');
  }
  const dryRun = options.dryRun ? ['-n'] : [];
  if (options.mode === 'ssh') {
    if (!NAME.test(peer.name ?? '')) throw new Error(`helm copy: ${peer.id} has no usable SSH name`);
    const sshUser = peer.sshUser ?? userInfo().username;
    if (!SSH_USER.test(sshUser)) throw new Error(`helm copy: ${peer.name} has no usable SSH user`);
    const sshPort = peer.sshPort ?? 22;
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
      throw new Error(`helm copy: ${peer.name} has an invalid SSH port`);
    }
    const knownHosts = join(HELM_DIR, 'known_hosts');
    const bin = fileURLToPath(new URL('../bin/helm.js', import.meta.url));
    const proxy = `${quote(process.execPath)} ${quote(bin)} proxy %h %p`;
    const ssh = ['ssh', '-F', '/dev/null', '-i', KEY_FILE, '-p', String(sshPort),
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=30',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', `ProxyCommand=${proxy}`].map(quote).join(' ');
    return {
      command: 'rsync',
      args: [...rsyncFlags, '-e', ssh, ...dryRun, ...excludes, '--', source, `${sshUser}@${peer.name}:${targetFolder}/`],
      peer,
    };
  }
  if (!KEY_B64.test(peer.codePubkey ?? '') || !KEY_B64.test(peer.codeSignPubkey ?? '')) {
    throw new Error(`helm copy: ${peer.name || peer.id} runs an older helm without signed copy support - update it, or copy with --ssh`);
  }
  const bin = fileURLToPath(new URL('../bin/helm.js', import.meta.url));
  const remote = [
    quote(process.execPath), quote(bin), 'copy-proxy',
    '--machine', quote(peer.id),
    '--target-folder', quote(targetFolder),
    options.mode ? `--${options.mode}` : null,
    '--',
  ].filter(Boolean).join(' ');
  return {
    command: 'rsync',
    args: [...rsyncFlags, '-e', remote, ...dryRun, ...excludes, '--', source, `${peer.id}:${targetFolder}/`],
    peer,
  };
}

const runOnce = (spec, spawnProcess, stdout, stderr) => new Promise((resolveRun, rejectRun) => {
  const child = spawnProcess(spec.command, spec.args);
  let tail = '';
  child.stdout.on('data', (chunk) => { try { stdout.write(chunk); } catch {} });
  child.stderr.on('data', (chunk) => {
    try { stderr.write(chunk); } catch {}
    tail = (tail + chunk).slice(-STDERR_TAIL);
  });
  child.on('error', rejectRun);
  child.on('close', (code, signal) => resolveRun({ code, signal, tail }));
});

/** Streaming compression and rsync's delta resume; no temporary ZIP or whole-tree buffer. */
export async function copyFolder(args, deps = {}) {
  return runCopy(parseCopyArgs(args), deps);
}

/** The copy itself, for callers that build options rather than argv. */
export async function runCopy(options, deps = {}) {
  options = { excludes: [], dryRun: false, mode: null, retries: 2, ...options };
  const net = deps.network ? (typeof deps.network === 'function' ? deps.network() : deps.network) : requireNetwork();
  const spec = copySpec(options, net);
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const checkRsync = deps.checkRsync ?? checkRsyncVersion;
  const spawnProcess = deps.spawnProcess ?? ((command, argv) => (platform() === 'win32'
    ? spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('nice', ['-n', '10', command, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })));
  const release = beginTransferActivity();
  try {
    checkRsync();
    const who = options.mode === 'ssh' ? `${spec.peer.name} over SSH` : `${spec.peer.name} over Helm`;
    stdout.write(`Copying ${options.source} to ${who}:${options.targetFolder}...\n`);
    stdout.write('Includes hidden files; existing matching files may be replaced. No destination files are deleted.\n');
    const attempts = 1 + options.retries;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { code, signal, tail } = await runOnce(spec, spawnProcess, stdout, stderr);
      if (code === 0) return 0;
      const at = tail.lastIndexOf(PERMANENT_MARK);
      const permanent = at !== -1
        ? tail.slice(at + PERMANENT_MARK.length).split('\n')[0].trim()
        : tail.match(LEGACY_PERMANENT)?.[0];
      if (signal || permanent || !RETRYABLE.has(code) || attempt === attempts - 1) {
        if (permanent) throw new Error(`helm copy: ${permanent}`);
        const hint = /rsync.*(not found|no such file|not available)|command not found/i.test(tail)
          ? ' - rsync 3.2.3+ is required on both machines'
          : '';
        throw new Error(`helm copy: copy stopped (${signal || `exit ${code}`})${hint}; rerun the same command to resume from its partial state`);
      }
      stderr.write(`helm copy: connection dropped (rsync ${code}); resuming attempt ${attempt + 2} of ${attempts}\n`);
      await sleep(1000 * Math.min(attempt + 1, 2));
    }
    return 0;
  } finally {
    release();
  }
}
