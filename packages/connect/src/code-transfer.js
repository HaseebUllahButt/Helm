/**
 * Code-only handoff.
 *
 * The relay carries this envelope, but cannot decrypt it. Provider profiles,
 * environment variables, and the source machine's home directory never
 * enter the snapshot.
 */
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey,
  createPublicKey, createSecretKey, diffieHellman, generateKeyPairSync,
  hkdfSync, randomBytes,
} from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { HELM_DIR, expand, HOME } from './paths.js';

const KEY_FILE = join(HELM_DIR, 'code_x25519');
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const VERSION = 1;
const AAD_PREFIX = 'helm-code-v1:';

// These are intentionally conservative. A source file that happens to have
// one of these names is safer to leave behind and recreate on the target.
const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.cache', '__pycache__',
  'target', 'dist', 'build', '.next', '.turbo', 'coverage', '.venv',
  '.idea', '.vscode', '.helm',
]);

const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|secret))$/i;
const SECRET_DIR = /^(?:\.ssh|\.aws|\.azure|\.config)$/i;

const b64 = (value) => Buffer.from(value).toString('base64url');
const unb64 = (value) => Buffer.from(String(value), 'base64url');
const asB64 = (value, max = MAX_SNAPSHOT_BYTES * 2) =>
  typeof value === 'string' && value.length > 0 && value.length <= max
    && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
const safeName = (value) => String(value || 'workspace').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'workspace';

const pathExists = (path) => {
  try { lstatSync(path); return true; } catch { return false; }
};

function keyPairFromFiles() {
  if (!existsSync(KEY_FILE) || !existsSync(`${KEY_FILE}.pub`)) return null;
  try {
    const privateKey = createPrivateKey(readFileSync(KEY_FILE));
    const publicKey = createPublicKey({
      key: readFileSync(`${KEY_FILE}.pub`), type: 'spki', format: 'der',
    });
    return { privateKey, publicKey };
  } catch {
    return null;
  }
}

/** Create the target's encryption identity once; the private key never leaves it. */
export function codeKeyInfo() {
  let pair = keyPairFromFiles();
  if (!pair) {
    if (pathExists(KEY_FILE) || pathExists(`${KEY_FILE}.pub`)) {
      throw new Error('Helm code-transfer key is unreadable; remove both code_x25519 files and restart');
    }
    mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
    pair = generateKeyPairSync('x25519');
    writeFileSync(KEY_FILE, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    writeFileSync(`${KEY_FILE}.pub`, pair.publicKey.export({ type: 'spki', format: 'der' }), { mode: 0o600, flag: 'wx' });
    chmodSync(KEY_FILE, 0o600);
    chmodSync(`${KEY_FILE}.pub`, 0o600);
  }
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    codePubkey: b64(pair.publicKey.export({ type: 'spki', format: 'der' })),
  };
}

function derive(shared, salt) {
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('helm-code-transfer-v1'), 32));
}

/** Encrypt a snapshot to the target's published X25519 public key. */
export function sealCodeSnapshot(snapshot, targetCodePubkey, handoffId) {
  const target = createPublicKey({ key: unb64(targetCodePubkey), type: 'spki', format: 'der' });
  const ephemeral = generateKeyPairSync('x25519');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = derive(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: target }), salt);
  const cipher = createCipheriv('aes-256-gcm', createSecretKey(key), iv);
  cipher.setAAD(Buffer.from(`${AAD_PREFIX}${handoffId}`));
  const data = Buffer.from(JSON.stringify(snapshot));
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return {
    v: VERSION,
    alg: 'X25519-A256GCM',
    handoffId,
    epk: b64(ephemeral.publicKey.export({ type: 'spki', format: 'der' })),
    salt: b64(salt),
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    data: b64(encrypted),
  };
}

function openEnvelope(envelope, handoffId) {
  if (!envelope || envelope.v !== VERSION || envelope.alg !== 'X25519-A256GCM') {
    throw new Error('unsupported code handoff envelope');
  }
  if (envelope.handoffId !== handoffId) throw new Error('code handoff id mismatch');
  for (const name of ['epk', 'salt', 'iv', 'tag', 'data']) {
    if (!asB64(envelope[name])) throw new Error(`invalid code handoff ${name}`);
  }
  const { privateKey } = codeKeyInfo();
  const ephemeral = createPublicKey({ key: unb64(envelope.epk), type: 'spki', format: 'der' });
  const key = derive(diffieHellman({ privateKey, publicKey: ephemeral }), unb64(envelope.salt));
  const decipher = createDecipheriv('aes-256-gcm', createSecretKey(key), unb64(envelope.iv));
  decipher.setAAD(Buffer.from(`${AAD_PREFIX}${handoffId}`));
  decipher.setAuthTag(unb64(envelope.tag));
  return JSON.parse(Buffer.concat([decipher.update(unb64(envelope.data)), decipher.final()]));
}

function safeRelative(root, path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(root, rel) !== path) {
    throw new Error('code handoff path escaped its workspace');
  }
  return rel.split(sep).join('/');
}

function assertNoSymlinkParent(path) {
  const home = resolve(HOME);
  let current = home;
  const parent = resolve(dirname(path));
  const rest = relative(home, parent);
  for (const part of rest ? rest.split(sep) : []) {
    current = join(current, part);
    if (!pathExists(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error('target folder cannot pass through a symbolic link');
  }
}

function skippedName(name, isDir) {
  if (isDir && SKIP_DIRS.has(name)) return true;
  return SECRET_NAME.test(name) || (isDir && SECRET_DIR.test(name));
}

/** Build a bounded file map. Symlinks are skipped to prevent outside-tree reads. */
export function createCodeSnapshot(root) {
  const source = resolve(expand(root || process.cwd()));
  const stat = lstatSync(source);
  if (!stat.isDirectory()) throw new Error(`code source is not a folder: ${source}`);
  const files = [];
  let bytes = 0;
  let skipped = 0;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skippedName(entry.name, entry.isDirectory())) { skipped += 1; continue; }
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) { skipped += 1; continue; }
      if (entry.isDirectory()) { visit(full); continue; }
      if (!entry.isFile()) { skipped += 1; continue; }
      if (files.length >= MAX_FILES) throw new Error(`code handoff exceeds ${MAX_FILES} files`);
      const info = lstatSync(full);
      if (info.size > MAX_FILE_BYTES) throw new Error(`${safeRelative(source, full)} is too large for a code handoff`);
      bytes += info.size;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(`code handoff exceeds ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB`);
      files.push({
        path: safeRelative(source, full),
        mode: info.mode & 0o111 ? 0o755 : 0o644,
        data: b64(readFileSync(full)),
      });
    }
  };
  visit(source);
  return {
    v: VERSION,
    rootName: safeName(basename(source)),
    files,
    bytes,
    skipped,
    digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.v !== VERSION || !Array.isArray(snapshot.files)) throw new Error('invalid code handoff snapshot');
  if (snapshot.files.length > MAX_FILES) throw new Error('code handoff contains too many files');
  let bytes = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0-\x1f\x7f]+$/u.test(file.path)) {
      throw new Error('invalid path in code handoff');
    }
    if (!asB64(file.data)) throw new Error(`invalid file data for ${file.path}`);
    const data = unb64(file.data);
    if (data.length > MAX_FILE_BYTES) throw new Error(`${file.path} is too large`);
    bytes += data.length;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('code handoff exceeds size limit');
  }
  return { ...snapshot, bytes };
}

/** Decrypt and atomically materialize into a new target folder. */
export function materializeCode(envelope, handoffId, requestedFolder) {
  const snapshot = validateSnapshot(openEnvelope(envelope, handoffId));
  const fallback = join(HELM_DIR, 'workspaces', `${snapshot.rootName}-${handoffId.slice(0, 8)}`);
  const destination = resolve(expand(requestedFolder || fallback));
  if (destination === resolve(HOME) || !destination.startsWith(`${resolve(HOME)}${sep}`)) {
    throw new Error('target folder must be inside the target home directory');
  }
  assertNoSymlinkParent(destination);
  if (pathExists(destination)) throw new Error(`target folder already exists: ${destination}`);

  const stage = `${destination}.helm-stage-${handoffId}`;
  if (pathExists(stage)) throw new Error('a code handoff with this id is already in progress');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  mkdirSync(stage, { mode: 0o700 });
  try {
    for (const file of snapshot.files) {
      const out = resolve(stage, file.path);
      if (!(out === stage || out.startsWith(`${stage}${sep}`))) throw new Error('code handoff path escaped staging folder');
      mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
      writeFileSync(out, unb64(file.data), { mode: file.mode === 0o755 ? 0o755 : 0o644, flag: 'wx' });
      chmodSync(out, file.mode === 0o755 ? 0o755 : 0o644);
    }
    renameSync(stage, destination);
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
  return { folder: destination, files: snapshot.files.length, bytes: snapshot.bytes, skipped: snapshot.skipped ?? 0, digest: snapshot.digest };
}

export const codeTransferLimits = { MAX_FILES, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES };
