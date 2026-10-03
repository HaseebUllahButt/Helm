import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo, platform } from 'node:os';
import { requireNetwork } from '@helm/protocol/network';
import { expand, KEY_FILE, HELM_DIR } from './paths.js';

const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseCopyArgs(args) {
  const positional = [], excludes = [];
  let targetFolder, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--target-folder' || arg === '--exclude') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--exclude') excludes.push(value);
      else {
        if (targetFolder !== undefined) throw new Error('--target-folder was given more than once');
        targetFolder = value;
      }
    } else if (arg.startsWith('-')) throw new Error(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 2 || !targetFolder) {
    throw new Error('usage: helm copy <machine> <folder> --target-folder <absolute-path> [--exclude <pattern>] [--dry-run]');
  }
  if (!targetFolder.startsWith('/') || /[\x00-\x1f\x7f]/.test(targetFolder) || targetFolder === '/') {
    throw new Error('--target-folder must name an absolute destination folder, not /');
  }
  return { machine: positional[0], folder: positional[1], targetFolder, excludes, dryRun };
}

export function copySpec(options, net = requireNetwork()) {
  const peers = Object.values(net.machines ?? {}).filter(m => m.name === options.machine || m.id === options.machine);
  if (peers.length !== 1) throw new Error('copy needs one exact machine name or ID');
  const peer = peers[0];
  if (peer.id === net.self || net.revoked?.[peer.id]) throw new Error('copy needs another current machine in this network');
  if (!NAME.test(peer.name)) throw new Error('target machine has no valid SSH name');
  const user = peer.sshUser ?? userInfo().username;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(user)) throw new Error('invalid target SSH user');
  const port = peer.sshPort ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid target SSH port');
  const folder = resolve(expand(options.folder));
  if (!statSync(folder).isDirectory()) throw new Error('copy source must be a folder');
  const bin = fileURLToPath(new URL('../bin/helm.js', import.meta.url));
  const proxy = `${quote(process.execPath)} ${quote(bin)} proxy %h`;
  const ssh = ['ssh', '-F', '/dev/null', '-i', KEY_FILE, '-p', String(port),
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=30',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(HELM_DIR, 'known_hosts')}`,
    '-o', `ProxyCommand=${proxy}`].map(quote).join(' ');
  const args = ['-a', '--no-owner', '--no-group', '--protect-args', '--mkpath',
    '--compress', '--compress-level=1', '--partial-dir=.helm-transfer-partial',
    '--info=progress2', '--stats', '-e', ssh];
  if (options.dryRun) args.push('--dry-run');
  for (const pattern of options.excludes) args.push(`--exclude=${pattern}`);
  args.push('--', `${folder}/`, `${user}@${peer.name}:${options.targetFolder.replace(/\/+$/, '')}/`);
  return { command: 'rsync', args, peer };
}

/** Streaming compression and rsync's delta resume; no temporary ZIP or whole-tree buffer. */
export async function copyFolder(args) {
  const options = parseCopyArgs(args);
  const spec = copySpec(options);
  console.log(`Copying to ${spec.peer.name}:${options.targetFolder}${options.dryRun ? ' (dry run)' : ''}`);
  console.log('Includes hidden files; existing matching files may be replaced. No destination files are deleted.');
  return new Promise((resolve, reject) => {
    const child = platform() === 'win32'
      ? spawn(spec.command, spec.args, { stdio: 'inherit' })
      : spawn('nice', ['-n', '10', spec.command, ...spec.args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve(0);
      else reject(new Error(`copy stopped (${signal || code}); rerun the same command to resume. Both machines need rsync and SSH access.`));
    });
  });
}
