import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, realpathSync, existsSync, linkSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { REVIEW_FILE } from './restore-guard.js';

const MAGIC = Buffer.from('HELMBK01');
const fail = message => { throw new Error(message); };
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
const key = (password, salt) => {
  if (!Buffer.isBuffer(password) || password.length < 12) fail('Use a secret with at least 12 bytes. Pass it in memory, not in command arguments.');
  return scryptSync(password, salt, 32);
};
function snapshot(root, prefix = '') {
  const entries = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const full = join(root, path), stat = lstatSync(full);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('Use an offline folder with only regular files and folders.');
    if (name === REVIEW_FILE) fail('Do not back up restored data before review.');
    if (stat.isDirectory()) entries.push({ path, kind: 'folder' }, ...snapshot(root, path));
    else entries.push({ path, kind: 'file', data: readFileSync(full).toString('base64') });
  }
  return entries;
}

/** Caller must stop all writers first. Never stop the owner's services here. */
export function createBackup({ source, destination, password, offline = false, write = writeFileSync }) {
  if (!offline) fail('Stop all writers and confirm that this backup source is offline.');
  source = realpathSync(source); destination = resolve(destination);
  if (inside(source, realpathSync(dirname(destination)))) fail('Save the backup outside the source folder.');
  if (!lstatSync(source).isDirectory()) fail('Choose an offline source folder.');
  const entries = snapshot(source);
  if (JSON.stringify(entries) !== JSON.stringify(snapshot(source))) fail('The source changed during backup. Stop all writers first.');
  const salt = randomBytes(16), iv = randomBytes(12), derived = key(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', derived, iv);
    cipher.setAAD(MAGIC);
    const body = Buffer.from(JSON.stringify({ format: 1, entries }));
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    const temp = `${destination}.partial-${randomBytes(12).toString('hex')}`;
    try {
      write(temp, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600, flush: true });
      // A hard link publishes a complete file without replacing any existing file.
      linkSync(temp, destination);
    } finally { rmSync(temp, { force: true }); }
    return { files: entries.filter(e => e.kind === 'file').length, bytes: body.length };
  } finally { derived.fill(0); }
}

function canonicalNew(path) {
  path = resolve(path);
  return join(realpathSync(dirname(path)), path.split(sep).at(-1));
}

/** No activation option. All records, including removals and receipts, stay inert. */
export function restoreBackup({ archive, destination, password }) {
  destination = canonicalNew(destination);
  const production = existsSync(join(homedir(), '.helm')) ? realpathSync(join(homedir(), '.helm')) : join(realpathSync(homedir()), '.helm');
  if (inside(production, destination)) fail('Restore only to a new offline folder outside production Helm.');
  if (existsSync(destination)) fail('Restore only to a new empty destination. Choose a folder that does not exist.');
  const bytes = readFileSync(archive);
  if (bytes.length < 53 || !bytes.subarray(0, 8).equals(MAGIC)) fail('This is not a supported Helm backup.');
  const derived = key(password, bytes.subarray(8, 24));
  let data;
  try {
    const decipher = createDecipheriv('aes-256-gcm', derived, bytes.subarray(24, 36));
    decipher.setAAD(MAGIC); decipher.setAuthTag(bytes.subarray(36, 52));
    data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(52)), decipher.final()]).toString('utf8'));
  } catch { fail('Cannot open this backup. Check the secret and the backup file.'); }
  finally { derived.fill(0); }
  if (data?.format !== 1 || !Array.isArray(data.entries)) fail('The backup description is not supported.');
  const seen = new Set();
  for (const e of data.entries) {
    if (!e || typeof e.path !== 'string' || !e.path || e.path.includes('\\') || e.path.includes('\0')
      || e.path.split('/').some(p => !p || p === '.' || p === '..' || p === REVIEW_FILE)
      || !['file', 'folder'].includes(e.kind) || seen.has(e.path)
      || (e.kind === 'file' && (typeof e.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.data)))) fail('The backup contains an unsafe file record.');
    seen.add(e.path);
  }
  const stage = `${destination}.partial-${randomBytes(12).toString('hex')}`;
  mkdirSync(stage, { mode: 0o700 });
  try {
    const root = join(stage, 'data'); mkdirSync(root, { mode: 0o700 });
    const marker = JSON.stringify({ format: 1, blocked: true, reason: 'Review current trusted removals and completed actions. Do not replay saved work.' });
    writeFileSync(join(stage, REVIEW_FILE), marker, { mode: 0o600 });
    writeFileSync(join(root, REVIEW_FILE), marker, { mode: 0o600 });
    for (const e of data.entries) {
      const file = join(root, e.path);
      if (e.kind === 'folder') mkdirSync(file, { recursive: true, mode: 0o700 });
      else { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, Buffer.from(e.data, 'base64'), { flag: 'wx', mode: 0o600 }); }
    }
    // mkdir claims the destination without overwriting a concurrent restore.
    mkdirSync(destination, { mode: 0o700 });
    try {
      renameSync(join(stage, REVIEW_FILE), join(destination, REVIEW_FILE));
      renameSync(root, join(destination, 'data'));
    } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
    return { directory: destination, data: join(destination, 'data'), blocked: true };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
