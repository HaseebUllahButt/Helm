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

// ------------------------------------------------- what may become a line
//
// A peer record reaches here from the roster, which reaches the roster from
// the network. Both files written below are line-oriented and read by ssh
// with far more authority than "a list of names": one stray newline in a peer
// name is a second authorized_keys entry, or a ProxyCommand that ssh will run
// - and ssh takes the *first* value it sees for a keyword, so an injected one
// wins over helm's own further down the block.
//
// `mergeRoster` already refuses to store a record that could do this. These
// checks are the second half of the same rule, applied where the damage would
// actually be done, so that a peer list reaching here by some other path in
// future is still held to it.

/** OpenSSH key types, and nothing that merely looks like one. */
const PUBKEY =
  /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?: .*)?$/;

/**
 * The key reduced to type and blob.
 *
 * The comment a key arrived with is dropped rather than checked: it is the
 * free-text tail of an authorized_keys line, so re-emitting only the two
 * fields that mean something leaves nothing to carry an option or a second
 * key even if this is ever pointed at laxer input.
 */
const pubkeyOf = (value) => {
  if (typeof value !== 'string' || value.length > 1024) return null;
  const m = PUBKEY.exec(value.trim());
  return m ? `${m[1]} ${m[2]}` : null;
};

/**
 * A name usable as an ssh Host alias.
 *
 * Restricted to what a hostname can hold, which is a no-op for every real
 * machine name and leaves nothing that could open a second directive. A name
 * that survives this is also the name the hub resolves back to an id when the
 * tunnel opens (`ws.js routeTunnel`), so `ssh <alias>` still finds its way.
 */
const aliasOf = (value) => {
  const clean = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  return clean && clean !== '.' && clean !== '..' ? clean.slice(0, 64) : null;
};

const userOf = (value) =>
  (typeof value === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/i.test(value) ? value : null);

const portOf = (value) =>
  (Number.isInteger(value) && value > 0 && value < 65536 ? value : 22);

/**
 * Bring this machine's SSH files in line with the current mesh.
 *
 * Every peer's public key goes into authorized_keys so they can reach us, and
 * every peer gets a Host alias whose ProxyCommand rides helm's own connection
 * - which is why `ssh laptop` works from a box that has no route to it.
 *
 * A peer that does not survive the checks above is skipped, not repaired: it
 * is either a machine describing itself in a way no machine describes itself,
 * or something trying to write a file it should not be able to write.
 */
export function applyPeers(peers) {
  const safe = [];
  for (const p of Array.isArray(peers) ? peers : []) {
    const alias = aliasOf(p?.name);
    if (!alias) continue;
    safe.push({ alias, pubkey: pubkeyOf(p?.pubkey), user: userOf(p?.sshUser), port: portOf(p?.sshPort) });
  }

  const keys = safe
    .filter((p) => p.pubkey)
    .map((p) => `${p.pubkey}  # helm:${p.alias}`)
    .join('\n');

  writeManagedBlock(join(SSH_DIR, 'authorized_keys'), keys || '# no peers', 0o600);

  const hosts = safe
    .map((p) =>
      [
        `Host ${p.alias}`,
        `  HostName ${p.alias}`,
        `  User ${p.user || userInfo().username}`,
        `  Port ${p.port}`,
        `  IdentityFile ${KEY_FILE}`,
        `  ProxyCommand ${PROXY} %h`,
        `  StrictHostKeyChecking accept-new`,
        `  UserKnownHostsFile ${join(HELM_DIR, 'known_hosts')}`,
      ].join('\n')
    )
    .join('\n\n');

  writeManagedBlock(join(SSH_DIR, 'config'), hosts || '# no peers', 0o600);
  return { ok: true, peers: safe.length };
}
