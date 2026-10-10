/**
 * Code-only handoff.
 *
 * An honest relay carries this envelope but cannot decrypt it; key pinning
 * is trust-on-first-use. Provider profiles, environment variables, and the
 * source machine's home directory never enter the snapshot.
 *
 * What gets left behind is decided by a conservative *filename* policy:
 * files whose names are conventionally secrets stay on the source. It is a
 * policy, not a guarantee - a token pasted into a source file is a line of
 * code to this module and travels like any other. The skipped list on the
 * receipt is so the caller can see what stayed behind, not a claim that the
 * rest is clean.
 */
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey,
  createPublicKey, createSecretKey, diffieHellman, generateKeyPairSync,
  hkdfSync, randomBytes, sign, timingSafeEqual, verify,
} from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, writeFileSync,
} from 'node:fs';
import {
  chmod as aChmod, lstat as aLstat, mkdir as aMkdir, readFile as aReadFile,
  rename as aRename, rm as aRm, writeFile as aWriteFile,
} from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { brotliCompressSync, brotliDecompressSync, constants as zlib } from 'node:zlib';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { HELM_DIR, expand, HOME } from './paths.js';

const KEY_FILE = join(HELM_DIR, 'code_x25519');
const SIGN_KEY_FILE = join(HELM_DIR, 'code_ed25519');
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
// The compressed envelope is already bounded at the door; this is the cap
// on what it may unpack to, so a bomb inside a small frame still cannot
// park itself in memory.
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
// Materialization writes with this many files in flight - enough to keep
// the disk fed, not enough to hold 20k promises over the loop.
const WRITE_CONCURRENCY = 16;
const VERSION = 1;
const AAD_PREFIX = 'helm-code-v1:';

// These are intentionally conservative. A source file that happens to have
// one of these names is safer to leave behind and recreate on the target.
const SKIP_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.cache', '__pycache__',
  'target', 'dist', 'build', '.next', '.turbo', 'coverage', '.venv',
  '.idea', '.vscode', '.helm',
]);

// `.env.example`, `.env.sample` and `.env.template` are documentation, not
// secrets - they name the variables without holding their values, and a
// handoff that drops them leaves the target unable to set the project up.
const SECRET_NAME = /^(?:\.env(?!\.(?:example|sample|template)$)(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.tfvars|kubeconfig|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx|jks|keystore|secret))$/i;
const SECRET_DIR = /^(?:\.ssh|\.aws|\.azure|\.config|\.docker|\.kube|\.gnupg|\.terraform)$/i;
const ENV_NAME = /^\.env(?:\..+)?$/i;

const b64 = (value) => Buffer.from(value).toString('base64url');
const unb64 = (value) => Buffer.from(String(value), 'base64url');
const asB64 = (value, max = MAX_SNAPSHOT_BYTES * 2) =>
  typeof value === 'string' && value.length > 0 && value.length <= max
    && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
const asFileData = (value, max = MAX_SNAPSHOT_BYTES * 2) =>
  typeof value === 'string' && value.length <= max
    && /^[A-Za-z0-9_-]*$/.test(value) ? value : null;
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
  }
  mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
  chmodSync(HELM_DIR, 0o700);
  chmodSync(KEY_FILE, 0o600);
  chmodSync(`${KEY_FILE}.pub`, 0o600);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    codePubkey: b64(pair.publicKey.export({ type: 'spki', format: 'der' })),
  };
}

export function createEphemeralCodeKey() {
  const pair = generateKeyPairSync('x25519');
  return {
    privateKey: pair.privateKey,
    codePubkey: b64(pair.publicKey.export({ type: 'spki', format: 'der' })),
  };
}

// ------------------------------------------------------------ signing key
//
// A second identity beside the X25519 cipher key: Ed25519, used to sign the
// digest of every handoff request this machine sends. The roster pins the
// public half (TOFU, same as codePubkey), so a target can check that the
// request it was handed was authored by the machine it claims - relay and
// hub can carry the work, but only the source can sign it.
const SIGN_PREFIX = 'helm-handoff-v1:';

function signPairFromFiles() {
  if (!existsSync(SIGN_KEY_FILE) || !existsSync(`${SIGN_KEY_FILE}.pub`)) return null;
  try {
    const privateKey = createPrivateKey(readFileSync(SIGN_KEY_FILE));
    const publicKey = createPublicKey({
      key: readFileSync(`${SIGN_KEY_FILE}.pub`), type: 'spki', format: 'der',
    });
    return { privateKey, publicKey };
  } catch {
    return null;
  }
}

/** The machine's signing identity; the private key never leaves it. */
export function codeSigningInfo() {
  let pair = signPairFromFiles();
  if (!pair) {
    if (pathExists(SIGN_KEY_FILE) || pathExists(`${SIGN_KEY_FILE}.pub`)) {
      throw new Error('Helm code-transfer signing key is unreadable; remove both code_ed25519 files and restart');
    }
    mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
    pair = generateKeyPairSync('ed25519');
    writeFileSync(SIGN_KEY_FILE, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    writeFileSync(`${SIGN_KEY_FILE}.pub`, pair.publicKey.export({ type: 'spki', format: 'der' }), { mode: 0o600, flag: 'wx' });
  }
  mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
  chmodSync(HELM_DIR, 0o700);
  chmodSync(SIGN_KEY_FILE, 0o600);
  chmodSync(`${SIGN_KEY_FILE}.pub`, 0o600);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    codeSignPubkey: b64(pair.publicKey.export({ type: 'spki', format: 'der' })),
  };
}

/**
 * Sign the request digest of a handoff this machine authored. The digest is
 * the whole immutable request, so the signature carries its honesty.
 */
export function signHandoffDigest(digest) {
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('invalid handoff digest');
  }
  return sign(null, Buffer.from(`${SIGN_PREFIX}${digest}`), codeSigningInfo().privateKey)
    .toString('base64url');
}

/**
 * Whether `signature` is `digest` signed by the holder of `codeSignPubkey`.
 * Never throws: anything that is not a well-formed SPKI key, 64-hex digest
 * and base64url signature is simply not a signature.
 */
export function verifyHandoffSignature(codeSignPubkey, digest, signature) {
  if (!asB64(codeSignPubkey, 512) || typeof digest !== 'string'
      || !/^[a-f0-9]{64}$/.test(digest) || !asB64(signature, 512)) {
    return false;
  }
  try {
    const key = createPublicKey({ key: unb64(codeSignPubkey), type: 'spki', format: 'der' });
    return verify(null, Buffer.from(`${SIGN_PREFIX}${digest}`), key, unb64(signature));
  } catch {
    return false;
  }
}

function derive(shared, salt) {
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('helm-code-transfer-v1'), 32));
}

// ------------------------------------------------------- key possession proof
//
// Before anything is encrypted to a roster's `codePubkey`, the target proves
// it holds the private half. The source offers a fresh ephemeral key and a
// nonce; the target can only produce the HMAC of that nonce by completing
// the same Diffie-Hellman - so a relay that learned a roster key cannot
// answer for the machine, and an old answer cannot be replayed: the nonce is
// bound to the shared secret it was minted with, kept on this side of the
// wire.
const PROOF_PREFIX = 'helm-code-key-proof-v1:';
const PROOF_NONCE_BYTES = 32;
const proofNonce = new WeakMap();

/**
 * The source's half of the challenge. `request` goes to the target; `secret`
 * is the raw 32-byte shared secret and stays here - it is what the answer is
 * verified against.
 */
export function beginCodeKeyProof(targetCodePubkey) {
  const target = createPublicKey({ key: unb64(targetCodePubkey), type: 'spki', format: 'der' });
  const ephemeral = generateKeyPairSync('x25519');
  const nonce = randomBytes(PROOF_NONCE_BYTES);
  const secret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: target });
  proofNonce.set(secret, nonce);
  return {
    request: {
      epk: b64(ephemeral.publicKey.export({ type: 'spki', format: 'der' })),
      nonce: b64(nonce),
    },
    secret,
  };
}

/** The target's answer, computed with the private key that never leaves it. */
export function answerCodeKeyProof(request) {
  const epk = request && asB64(request.epk, 4096);
  const nonceField = request && asB64(request.nonce, 128);
  if (!epk || !nonceField) throw new Error('invalid code key proof request');
  const nonce = unb64(nonceField);
  if (nonce.length !== PROOF_NONCE_BYTES) throw new Error('invalid code key proof nonce');
  const { privateKey, codePubkey } = codeKeyInfo();
  let secret;
  try {
    const ephemeral = createPublicKey({ key: unb64(epk), type: 'spki', format: 'der' });
    secret = diffieHellman({ privateKey, publicKey: ephemeral });
  } catch {
    throw new Error('invalid code key proof ephemeral key');
  }
  const proof = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(PROOF_PREFIX), nonce]))
    .digest('base64url');
  return { codePubkey, proof };
}

/** Check the answer against what this challenge can accept. Throws on any miss. */
export function verifyCodeKeyProof(targetCodePubkey, secret, response) {
  const nonce = Buffer.isBuffer(secret) ? proofNonce.get(secret) : undefined;
  if (!nonce) throw new Error('unrecognized code key proof challenge');
  proofNonce.delete(secret);
  if (!response || response.codePubkey !== targetCodePubkey) {
    throw new Error('the code-transfer key answered is not the one the roster pins');
  }
  const given = asB64(response.proof, 128);
  if (!given || unb64(given).length !== 32) throw new Error('invalid code key proof');
  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(PROOF_PREFIX), nonce]))
    .digest();
  if (!timingSafeEqual(unb64(given), expected)) {
    throw new Error('the machine did not prove it holds the pinned code key');
  }
  return true;
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
  // The file map is a wall of base64 - packed once with Brotli it stops
  // paying for its own encoding twice on the wire.
  const data = brotliCompressSync(
    Buffer.from(JSON.stringify(snapshot)),
    { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } }
  );
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return {
    v: VERSION,
    alg: 'X25519-A256GCM',
    zip: 'br',
    handoffId,
    epk: b64(ephemeral.publicKey.export({ type: 'spki', format: 'der' })),
    salt: b64(salt),
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    data: b64(encrypted),
  };
}

export function openTaskPrompt(envelope, handoffId) {
  const task = openEnvelope(envelope, handoffId);
  if (task?.type !== 'task-prompt' || typeof task.prompt !== 'string'
      || !task.prompt.length || task.prompt.length > 64_000) throw new Error('invalid encrypted task prompt');
  return task.prompt;
}

export function openCodeSnapshot(envelope, handoffId) {
  return validateSnapshot(openEnvelope(envelope, handoffId));
}

export function openTaskDelta(envelope, handoffId, baseline) {
  const delta = openEnvelope(envelope, handoffId);
  if (delta?.type !== 'task-delta' || !Array.isArray(delta.files) || !Array.isArray(delta.deleted)
      || delta.deleted.length > MAX_FILES || delta.files.length > MAX_FILES) throw new Error('invalid task delta');
  const changed = new Set();
  const files = new Map(baseline.files.map((file) => [file.path, file]));
  for (const path of delta.deleted) {
    if (typeof path !== 'string' || !files.has(path) || changed.has(path)) throw new Error('invalid deleted path in task delta');
    files.delete(path);
    changed.add(path);
  }
  for (const file of delta.files) {
    if (!file || changed.has(file.path)) throw new Error('duplicate changed path in task delta');
    files.set(file.path, file);
    changed.add(file.path);
  }
  const snapshot = { v: VERSION, rootName: delta.rootName, files: [...files.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    skipped: delta.skipped, skippedEntries: delta.skippedEntries, git: delta.git };
  snapshot.digest = snapshotDigest(snapshot);
  return validateSnapshot(snapshot);
}

export function canonicalSnapshot(snapshot) {
  const canonical = { ...snapshot, files: [...snapshot.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) };
  canonical.digest = snapshotDigest(canonical);
  return canonical;
}

function openEnvelope(envelope, handoffId, privateKey = null) {
  if (!envelope || envelope.v !== VERSION || envelope.alg !== 'X25519-A256GCM'
      || envelope.zip !== 'br') {
    throw new Error('unsupported code handoff envelope');
  }
  if (envelope.handoffId !== handoffId) throw new Error('code handoff id mismatch');
  for (const name of ['epk', 'salt', 'iv', 'tag', 'data']) {
    if (!asB64(envelope[name])) throw new Error(`invalid code handoff ${name}`);
  }
  const opening = privateKey ?? codeKeyInfo().privateKey;
  const ephemeral = createPublicKey({ key: unb64(envelope.epk), type: 'spki', format: 'der' });
  const key = derive(diffieHellman({ privateKey: opening, publicKey: ephemeral }), unb64(envelope.salt));
  const decipher = createDecipheriv('aes-256-gcm', createSecretKey(key), unb64(envelope.iv));
  decipher.setAAD(Buffer.from(`${AAD_PREFIX}${handoffId}`));
  decipher.setAuthTag(unb64(envelope.tag));
  const packed = Buffer.concat([decipher.update(unb64(envelope.data)), decipher.final()]);
  const json = brotliDecompressSync(packed, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  return JSON.parse(json);
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

// Why an entry stayed behind, so the receipt can say more than a count.
// `skippedEntries` is capped - a tree can hold thousands of credential
// files and links nobody reads one by one - while `skipped` keeps counting
// everything.
const MAX_SKIPPED_ENTRIES = 200;

function skipReason(name, isDir) {
  if (isDir && SKIP_DIRS.has(name)) return 'generated';
  if (SECRET_NAME.test(name)) return 'secret-name';
  if (isDir && SECRET_DIR.test(name)) return 'secret-dir';
  return null;
}

// ------------------------------------------------------ git provenance
//
// When the source folder is exactly a worktree root, the snapshot carries
// where it came from - commit, branch, a fetchable remote - so the target
// can lay the code down on real history instead of a bare directory. All
// of it is inside the encrypted envelope; the hub never sees it.

const GIT_COMMIT = /^[a-f0-9]{40,64}$/;
const GIT_TIMEOUT = 5_000;

/**
 * Whether a remote URL may be handed to a target's git: http(s)/ssh/git
 * scheme URLs and the SCP-like `user@host:path` spelling - never a
 * credential embedded in userinfo, a `file:` URL, or anything that
 * resolves locally.
 */
function isSafeGitRemote(url) {
  if (typeof url !== 'string' || !url.length || url.length > 2048) return false;
  if (url.startsWith('-') || /[\x00-\x20\x7f]/.test(url)) return false;
  const scheme = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (!['https', 'http', 'ssh', 'git'].includes(name)) return false;
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    // A bare origin plus path: no query, no fragment, and a host the
    // parser actually found. http(s) and git carry no userinfo at all -
    // a bare `https://token@host` is a credential as surely as
    // `user:password@host` is. ssh may name a user (`git@host`) but
    // never a password.
    if (!parsed.hostname || parsed.search || parsed.hash) return false;
    if (name === 'ssh') return !parsed.password;
    return !parsed.username && !parsed.password;
  }
  // No scheme: a Windows drive or a leading slash/dot is a local path, not
  // an SCP address. What remains must spell [user@]host:path.
  if (/^[A-Za-z]:[\\/]/.test(url)) return false;
  return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*:[^\x00-\x20\x7f]+$/.test(url);
}

/** Commit/branch/remote of a worktree root, or null for any other folder. */
function gitMetadata(source) {
  const run = (args) => {
    try {
      return execFileSync('git', ['-C', source, ...args], {
        timeout: GIT_TIMEOUT, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return null; }
  };
  // Only a folder that *is* the worktree root claims provenance - a folder
  // inside a repo would otherwise rewrite another worktree's history.
  const toplevel = run(['rev-parse', '--show-toplevel']);
  if (!toplevel || resolve(toplevel) !== source) return null;
  const commit = run(['rev-parse', 'HEAD']);
  const git = commit && GIT_COMMIT.test(commit) ? { commit } : {};
  const branch = run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch && branch.length <= 200 && /^[^\x00-\x1f\x7f]+$/.test(branch)) git.branch = branch;
  const remote = run(['remote', 'get-url', 'origin']);
  if (remote && isSafeGitRemote(remote)) git.remote = remote;
  return git.commit || git.remote ? git : null;
}

/** Configure only origin in a freshly transferred folder; never fetch or reset files. */
export async function configureGitOrigin(folder, git, { exec = promisify(execFile) } = {}) {
  if (!isSafeGitRemote(git?.remote)) return null;
  const remote = git.remote;
  const run = (args) => exec('git', ['-C', folder, ...args], {
    timeout: GIT_TIMEOUT, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  try {
    // On an identical retry the repository may already be configured. Leave
    // existing metadata alone, including a fetch the owner did meanwhile.
    if (await aExists(join(folder, '.git'))) {
      const { stdout } = await run(['remote', 'get-url', 'origin']);
      if (stdout.trim() !== remote) throw new Error('the target origin differs from the sent origin');
    } else {
      await run(['init', '--template=', ...(git.branch ? [`--initial-branch=${git.branch}`] : [])]);
      await run(['remote', 'add', 'origin', remote]);
    }
    return { remote, configured: true };
  } catch {
    // Keep the URL available even on machines without git. Do not expose
    // process stderr, which can contain local configuration or credentials.
    return { remote, configured: false, error: 'Origin could not be configured; add it on the target before pulling.' };
  }
}

/**
 * Lay `git init` + fetch underneath a freshly materialized handoff folder
 * so the code arrives carrying its real history. Called only on a folder
 * this handoff itself materialized: an existing `.git` inside is at most a
 * half-written restore from a crashed attempt, so removing it is repair,
 * not destruction - it is never run on an arbitrary directory.
 *
 * Never throws for a git problem: a remote that will not fetch or a commit
 * that is not on it leaves the folder intact minus `.git`, reported in
 * `error`. Fields are re-validated here before any child process runs -
 * the envelope is signed, but the check is cheap and the signature proves
 * what was sent, not what should be run.
 */
export async function restoreGitMetadata(folder, git, { exec = promisify(execFile) } = {}) {
  if (!git || typeof git.commit !== 'string' || !GIT_COMMIT.test(git.commit)) {
    return { restored: false };
  }
  const commit = git.commit;
  const branch = typeof git.branch === 'string' && git.branch.length <= 200
    && /^[^\x00-\x1f\x7f]+$/.test(git.branch) && !git.branch.startsWith('-') ? git.branch : null;
  const remote = isSafeGitRemote(git.remote) ? git.remote : null;
  const run = (args) => exec('git', ['-C', folder, ...args], {
    timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  const cleanup = async () => {
    await aRm(join(folder, '.git'), { recursive: true, force: true }).catch(() => {});
  };
  try {
    // A retry after a crash may find the .git a previous attempt made.
    await cleanup();
    await run(['init']);
    if (!remote) {
      return { restored: true, fetched: false, commit, ...(branch ? { branch } : {}) };
    }
    await run(['remote', 'add', 'origin', remote]);
    await run(['fetch', '--depth=1', 'origin', commit]);
    await run(['reset', '--mixed', 'FETCH_HEAD']);
    if (branch) await run(['branch', '-M', branch]);
    return { restored: true, fetched: true, remote, commit, ...(branch ? { branch } : {}) };
  } catch (err) {
    await cleanup();
    return { restored: false, error: String(err?.stderr || err?.message || err).slice(0, 500) };
  }
}

/** Build a bounded file map. Symlinks are skipped to prevent outside-tree reads. */
export function createCodeSnapshot(root, { includeEnv = false } = {}) {
  const source = resolve(expand(root || process.cwd()));
  const stat = lstatSync(source);
  if (!stat.isDirectory()) throw new Error(`code source is not a folder: ${source}`);
  const files = [];
  const skippedEntries = [];
  let bytes = 0;
  let skipped = 0;
  const note = (path, reason) => {
    skipped += 1;
    if (skippedEntries.length < MAX_SKIPPED_ENTRIES) skippedEntries.push({ path, reason });
  };
  const addFile = (full, secret) => {
    if (files.length >= MAX_FILES) throw new Error(`code handoff exceeds ${MAX_FILES} files`);
    const info = lstatSync(full);
    if (info.size > MAX_FILE_BYTES) throw new Error(`${safeRelative(source, full)} is too large for a code handoff`);
    bytes += info.size;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(`code handoff exceeds ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB`);
    files.push({
      path: safeRelative(source, full),
      mode: info.mode & 0o111 ? 0o755 : 0o644,
      data: b64(readFileSync(full)),
      ...(secret ? { secret: true } : {}),
    });
  };
  const visit = (dir, envOnly = false) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (envOnly) {
        if (entry.isDirectory()) {
          const reason = skipReason(entry.name, true);
          if (!reason || reason === 'secret-dir') visit(full, true);
        } else if (entry.isFile() && ENV_NAME.test(entry.name)) {
          addFile(full, true);
        }
        continue;
      }
      const envFile = includeEnv && !entry.isDirectory() && ENV_NAME.test(entry.name);
      const reason = skipReason(entry.name, entry.isDirectory());
      if (reason && !envFile) {
        note(safeRelative(source, full), reason);
        if (includeEnv && reason === 'secret-dir' && entry.isDirectory()) visit(full, true);
        continue;
      }
      if (entry.isSymbolicLink()) { note(safeRelative(source, full), 'symlink'); continue; }
      if (entry.isDirectory()) { visit(full); continue; }
      if (!entry.isFile()) { note(safeRelative(source, full), 'special'); continue; }
      addFile(full, envFile);
    }
  };
  visit(source);
  const snapshot = {
    v: VERSION,
    rootName: safeName(basename(source)),
    files,
    bytes,
    skipped,
    skippedEntries,
    git: gitMetadata(source) ?? undefined,
  };
  return { ...snapshot, digest: snapshotDigest(snapshot) };
}

/**
 * The fingerprint of everything a snapshot carries. The digest is what the
 * signed handoff request binds, so it covers the whole artifact - the file
 * map, the name it will land under, the manifest of what stayed behind and
 * any git provenance - not just the file bytes.
 */
const snapshotDigest = (snapshot) => createHash('sha256').update(JSON.stringify({
  v: snapshot.v,
  rootName: snapshot.rootName,
  files: snapshot.files,
  skipped: snapshot.skipped,
  skippedEntries: snapshot.skippedEntries,
  git: snapshot.git ?? null,
})).digest('hex');

// The only reasons skipReason ever writes; a manifest naming anything else
// was not produced by a snapshot.
const SKIP_REASONS = new Set(['secret-name', 'generated', 'secret-dir', 'symlink', 'special']);

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.v !== VERSION || !Array.isArray(snapshot.files)) throw new Error('invalid code handoff snapshot');
  if (snapshot.files.length > MAX_FILES) throw new Error('code handoff contains too many files');
  // The metadata the digest binds is validated strictly rather than
  // normalized: a field that does not read clean is not the snapshot its
  // digest describes, so it is refused outright instead of trimmed.
  if (!Number.isInteger(snapshot.skipped) || snapshot.skipped < 0) {
    throw new Error('invalid skipped count in code handoff');
  }
  if (snapshot.skippedEntries !== undefined
      && (!Array.isArray(snapshot.skippedEntries)
        || snapshot.skippedEntries.length > MAX_SKIPPED_ENTRIES
        || snapshot.skippedEntries.some((e) => !e
          || typeof e.path !== 'string' || !e.path.length || e.path.length > 1024
          || /[\x00-\x1f\x7f]/.test(e.path)
          || !SKIP_REASONS.has(e.reason)))) {
    throw new Error('invalid skipped manifest in code handoff');
  }
  if (snapshot.git != null) {
    const git = snapshot.git;
    const provenance = typeof git === 'object'
      && (git.commit === undefined ? isSafeGitRemote(git.remote) : GIT_COMMIT.test(git.commit))
      && (git.branch === undefined || (typeof git.branch === 'string'
        && git.branch.length <= 200 && /^[^\x00-\x1f\x7f]+$/.test(git.branch)
        && !git.branch.startsWith('-')))
      && (git.remote === undefined || isSafeGitRemote(git.remote));
    if (!provenance) throw new Error('invalid git provenance in code handoff');
  }
  // rootName becomes part of the default target folder, so it is held to
  // the same normalization the sender claims to have applied.
  if (safeName(snapshot.rootName) !== snapshot.rootName) throw new Error('invalid rootName in code handoff');
  // The digest is what the source says it packed - files, name, skipped
  // manifest and provenance together. Recomputing rather than trusting it
  // is what makes the value meaningful in the parent link and the receipt.
  const digest = snapshotDigest(snapshot);
  if (snapshot.digest !== digest) {
    throw new Error('code handoff digest does not match its contents');
  }
  const seen = new Set();
  let bytes = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0-\x1f\x7f]+$/u.test(file.path)) {
      throw new Error('invalid path in code handoff');
    }
    if (seen.has(file.path)) throw new Error(`duplicate path in code handoff: ${file.path}`);
    seen.add(file.path);
    if (file.secret !== undefined && file.secret !== true) {
      throw new Error('invalid secret flag in code handoff');
    }
    if (asFileData(file.data) === null) throw new Error(`invalid file data for ${file.path}`);
    const data = unb64(file.data);
    if (data.length > MAX_FILE_BYTES) throw new Error(`${file.path} is too large`);
    bytes += data.length;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('code handoff exceeds size limit');
  }
  return {
    ...snapshot, digest, bytes,
    skippedEntries: snapshot.skippedEntries ?? [],
    git: snapshot.git ?? undefined,
  };
}

const aExists = async (path) => {
  try { await aLstat(path); return true; } catch { return false; }
};

/** The receipt a finished folder parks inside itself, or null. */
async function readHandoffMarker(destination) {
  try {
    return JSON.parse(await aReadFile(join(destination, '.helm', 'handoff.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Decrypt and atomically materialize into a new target folder. Everything
 * past validation is async: a workspace is thousands of writes, and a
 * daemon that stops answering heartbeats for its whole duration is a daemon
 * that looks dead while a handoff lands.
 */
export async function materializeCode(envelope, handoffId, requestedFolder, { privateKey = null, expectedDigest = null } = {}) {
  const snapshot = validateSnapshot(openEnvelope(envelope, handoffId, privateKey));
  if (expectedDigest !== null && expectedDigest !== snapshot.digest) {
    throw new Error('snapshot digest does not match the request');
  }
  const fallback = join(HELM_DIR, 'workspaces', `${snapshot.rootName}-${handoffId.slice(0, 8)}`);
  const destination = resolve(expand(requestedFolder || fallback));
  if (destination === resolve(HOME) || !destination.startsWith(`${resolve(HOME)}${sep}`)) {
    throw new Error('target folder must be inside the target home directory');
  }
  assertNoSymlinkParent(destination);
  if (await aExists(destination)) {
    // A crash between the rename below and the caller recording the
    // receipt leaves a finished folder behind. Its marker says which
    // handoff made it and what was inside: the identical request may
    // claim the folder, anything else is the pre-existing folder it has
    // always been.
    const marker = await readHandoffMarker(destination);
    if (marker?.version === 1 && marker.handoffId === handoffId
      && marker.folder === destination && marker.digest === snapshot.digest) {
      return {
        folder: marker.folder, files: marker.files, bytes: marker.bytes,
        skipped: marker.skipped, skippedEntries: marker.skippedEntries,
        digest: marker.digest, ...(marker.git ? { git: marker.git } : {}),
      };
    }
    throw new Error(`target folder already exists: ${destination}`);
  }

  const stage = `${destination}.helm-stage-${handoffId}`;
  if (await aExists(stage)) throw new Error('a code handoff with this id is already in progress');
  await aMkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await aMkdir(stage, { mode: 0o700 });
  try {
    // Every directory the files need, plus .helm, made before any file
    // lands - shallowest first so a parent always precedes its children.
    const dirs = new Set([stage, join(stage, '.helm')]);
    for (const file of snapshot.files) {
      const out = resolve(stage, file.path);
      if (!(out === stage || out.startsWith(`${stage}${sep}`))) throw new Error('code handoff path escaped staging folder');
      let d = dirname(out);
      while (d !== stage && !dirs.has(d)) { dirs.add(d); d = dirname(d); }
    }
    const byDepth = (a, b) => a.split(sep).length - b.split(sep).length;
    for (const d of [...dirs].sort(byDepth)) {
      await aMkdir(d, { recursive: true, mode: 0o700 });
    }
    // Bounded in flight: enough workers to keep the disk fed, never a
    // 20,000-promise burst. A shared index, not a shift - the walk is
    // O(n), not O(n²) at twenty thousand files.
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= snapshot.files.length) return;
        const file = snapshot.files[i];
        const out = resolve(stage, file.path);
        const secret = file.secret === true || ENV_NAME.test(basename(file.path));
        const mode = secret ? 0o600 : file.mode === 0o755 ? 0o755 : 0o644;
        await aWriteFile(out, unb64(file.data), { mode, flag: 'wx' });
        await aChmod(out, mode);
      }
    };
    await Promise.all(Array.from({ length: WRITE_CONCURRENCY }, worker));
    // The receipt goes in before the rename so the crash window between
    // the folder landing and the caller writing it down still knows which
    // handoff made it. It is Helm's own metadata and stays put - snapshot
    // creation already refuses `.helm` directories, and ours is written
    // last so a snapshot path could never impersonate it.
    await aWriteFile(join(stage, '.helm', 'handoff.json'), JSON.stringify({
      version: 1, handoffId,
      folder: destination, files: snapshot.files.length, bytes: snapshot.bytes,
      skipped: snapshot.skipped, skippedEntries: snapshot.skippedEntries,
      digest: snapshot.digest, ...(snapshot.git ? { git: snapshot.git } : {}),
    }, null, 2), { mode: 0o600 });
    await aRename(stage, destination);
  } catch (err) {
    await aRm(stage, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return {
    folder: destination, files: snapshot.files.length, bytes: snapshot.bytes,
    skipped: snapshot.skipped, skippedEntries: snapshot.skippedEntries,
    digest: snapshot.digest, ...(snapshot.git ? { git: snapshot.git } : {}),
  };
}

