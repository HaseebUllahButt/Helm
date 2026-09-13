import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HELM_DIR, KEY_FILE, SSH_DIR, HOME } from './paths.js';

const exec = promisify(execFile);

// helm only ever rewrites what is between these markers. Everything you wrote
// yourself is left exactly as it was.
const BEGIN = '# >>> helm managed >>>';
const END = '# <<< helm managed <<<';

// ssh runs ProxyCommand through /bin/sh with a bare environment, so naming the
// interpreter and script outright is the only thing that reliably works.
const PROXY = `${process.execPath} ${fileURLToPath(new URL('../bin/helm.js', import.meta.url))} proxy`;

/** Generate this machine's mesh key once. The private half never leaves. */
async function ensureKey() {
  if (existsSync(KEY_FILE)) return;
  mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
  await exec('ssh-keygen', [
    '-t', 'ed25519', '-N', '', '-q',
    '-C', `helm@${userInfo().username}`,
    '-f', KEY_FILE,
  ]);
  chmodSync(KEY_FILE, 0o600);
}

export async function sshInfo() {
  await ensureKey();
  return {
    pubkey: readFileSync(`${KEY_FILE}.pub`, 'utf8').trim(),
    sshUser: userInfo().username,
    sshPort: Number(process.env.HELM_SSH_PORT || 22),
  };
}

/** Replace helm's block in a file, leaving the rest untouched. */
function writeManagedBlock(file, body, mode = 0o600) {
  mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });

  let existing = '';
  if (existsSync(file)) {
    existing = readFileSync(file, 'utf8');
    const backup = `${file}.helm-backup`;
    if (!existsSync(backup)) copyFileSync(file, backup);
  }

  const block = `${BEGIN}\n${body.trimEnd()}\n${END}`;
  const pattern = new RegExp(
    `${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?` +
    `${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  );

  const next = pattern.test(existing)
    ? existing.replace(pattern, block)
    : (existing.trimEnd() ? existing.trimEnd() + '\n\n' : '') + block + '\n';

  if (next !== existing) writeFileSync(file, next, { mode });
  chmodSync(file, mode);
}

/**
 * Bring this machine's SSH files in line with the current mesh.
 *
 * Every peer's public key goes into authorized_keys so they can reach us, and
 * every peer gets a Host alias whose ProxyCommand rides helm's own connection
 * - which is why `ssh laptop` works from a box that has no route to it.
 */
export function applyPeers(peers) {
  const keys = peers
    .filter((p) => p.pubkey)
    .map((p) => `${p.pubkey.trim()}  # helm:${p.name}`)
    .join('\n');

  writeManagedBlock(join(SSH_DIR, 'authorized_keys'), keys || '# no peers', 0o600);

  const hosts = peers
    .map((p) =>
      [
        `Host ${p.name}`,
        `  HostName ${p.name}`,
        `  User ${p.sshUser || userInfo().username}`,
        `  Port ${p.sshPort || 22}`,
        `  IdentityFile ${KEY_FILE}`,
        `  ProxyCommand ${PROXY} %h`,
        `  StrictHostKeyChecking accept-new`,
        `  UserKnownHostsFile ${join(HELM_DIR, 'known_hosts')}`,
      ].join('\n')
    )
    .join('\n\n');

  writeManagedBlock(join(SSH_DIR, 'config'), hosts || '# no peers', 0o600);
  return { ok: true, peers: peers.length };
}
