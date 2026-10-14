import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Raw bytes, rather than Git clean/smudge filters: preserve staged and unstaged
// edits independently, and never run project code while making a checkpoint.
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 15_000,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' },
});
const contains = (a, b) => { const p = relative(a, b); return !p || !isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`); };
const present = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export const overlaps = (a, b) => contains(a, b) || contains(b, a);

export function workspace(cwd) {
  const root = realpathSync(git(cwd, 'rev-parse', '--show-toplevel').trim());
  const dir = realpathSync(git(root, 'rev-parse', '--absolute-git-dir').trim());
  const common = realpathSync(resolve(root, git(root, 'rev-parse', '--git-common-dir').trim()));
  if (dir === common) throw new Error('File restore requires an isolated Git worktree; the main checkout cannot be restored.');
  if (realpathSync(cwd) !== root) throw new Error('File restore requires the worktree root.');
  if (git(root, 'ls-files', '--stage').split('\n').some(line => line.startsWith('160000 '))) throw new Error('File restore does not support nested repositories or submodules.');
  if (git(root, 'ls-files', '-t').split('\n').some(line => line.startsWith('S '))) throw new Error('File restore does not support sparse worktrees.');
  if (git(root, 'rev-parse', '--shared-index-path').trim()) throw new Error('File restore does not support split Git indexes.');
  return { root, dir, head: git(root, 'rev-parse', 'HEAD').trim() };
}

function safePath(root, name) {
  if (!name || isAbsolute(name) || name.split('/').some(p => p === '..' || p === '.git' || !p)) throw new Error('Unsafe checkpoint path.');
  const file = join(root, name);
  let parent = dirname(file);
  while (parent !== root) {
    if (present(parent) && (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())) throw new Error(`Unsafe checkpoint parent: ${name}`);
    parent = dirname(parent);
  }
  return file;
}
function paths(root) {
  return [...new Set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
}

export function captureFiles(cwd, destination, { blobDir = null } = {}) {
  const ws = workspace(cwd);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const files = [];
  const fingerprints = new Map();
  const names = paths(ws.root);
  const fingerprint = st => [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode].join(':');
  let size = 0;
  for (const name of names) {
    const file = safePath(ws.root, name);
    let st;
    try { st = lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (st.isDirectory()) throw new Error('File restore does not support nested repositories.');
    if (!st.isFile() && !st.isSymbolicLink()) throw new Error('Unsupported checkpoint file type.');
    fingerprints.set(name, fingerprint(st));
    size += st.size;
    if (size > 256 * 1024 * 1024 || files.length >= 50_000) throw new Error('Workspace is too large to checkpoint safely.');
    const entry = { name, mode: st.mode & 0o777, blob: String(files.length) };
    if (st.isSymbolicLink()) entry.link = readlinkSync(file);
    else {
      const bytes = readFileSync(file);
      entry.sha = createHash('sha256').update(bytes).digest('hex');
      if (blobDir) {
        mkdirSync(blobDir, { recursive: true, mode: 0o700 });
        const blob = join(blobDir, entry.sha);
        if (!existsSync(blob)) writeFileSync(blob, bytes, { mode: 0o600, flag: 'wx' });
        linkSync(blob, join(destination, entry.blob));
      } else writeFileSync(join(destination, entry.blob), bytes, { mode: 0o600 });
    }
    files.push(entry);
  }
  const index = join(ws.dir, 'index');
  const indexBytes = existsSync(index) ? readFileSync(index) : null;
  if (indexBytes) writeFileSync(join(destination, 'index'), indexBytes, { mode: 0o600 });
  if (JSON.stringify(paths(ws.root)) !== JSON.stringify(names) || git(ws.root, 'rev-parse', 'HEAD').trim() !== ws.head) throw new Error('The workspace changed during file capture.');
  for (const name of names) {
    let st;
    try { st = lstatSync(safePath(ws.root, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if ((st ? fingerprint(st) : undefined) !== fingerprints.get(name)) throw new Error('The workspace changed during file capture.');
  }
  if (indexBytes && !readFileSync(index).equals(indexBytes) || !indexBytes && existsSync(index)) throw new Error('The Git index changed during file capture.');
  const snapshot = { ...ws, files, index: existsSync(index) };
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(snapshot), { mode: 0o600 });
  return snapshot;
}

export function readSnapshot(directory) { return JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')); }

export function validateRestore(cwd, directory, { owned = [], lockToken = null } = {}) {
  const saved = readSnapshot(directory), ws = workspace(cwd);
  if (saved.root !== ws.root || saved.dir !== ws.dir || saved.head !== ws.head) throw new Error('The worktree or HEAD changed since this checkpoint. Rewind without restoring files.');
  const lock = join(ws.dir, 'index.lock');
  if (existsSync(lock) && (!lockToken || readFileSync(lock, 'utf8') !== `helm-rewind:${lockToken}\n`)) throw new Error('Git is updating this worktree; try again when it finishes.');
  const current = [...new Set([...paths(ws.root), ...owned])];
  const managed = new Set(current);
  for (const entry of saved.files) {
    const path = safePath(ws.root, entry.name);
    // An ignored path that appeared since capture belongs to the owner too.
    if (present(path) && !managed.has(entry.name)) throw new Error(`File restore would overwrite an ignored file: ${entry.name}`);
    if (present(path) && lstatSync(path).isDirectory()) throw new Error(`File restore would replace a directory: ${entry.name}`);
    if (entry.link == null) {
      const bytes = readFileSync(join(directory, entry.blob));
      if (entry.sha && createHash('sha256').update(bytes).digest('hex') !== entry.sha) throw new Error(`Checkpoint file is damaged: ${entry.name}`);
    }
  }
  for (const name of current) {
    const file = safePath(ws.root, name);
    if (present(file) && lstatSync(file).isDirectory()) throw new Error(`File restore would replace a directory: ${name}`);
  }
  if (saved.index) readFileSync(join(directory, 'index'));
  return { saved, current };
}

export function restoreFiles(cwd, directory, options) {
  const { saved, current } = validateRestore(cwd, directory, options);
  // Every path is checked before the first mutation. The transaction caller
  // keeps a second snapshot and restores it if any subsequent write fails.
  const index = join(saved.dir, 'index');
  const lock = `${index}.lock`;
  const token = options?.lockToken ?? randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Invalid recovery lock token.');
  // A persisted journal may release only the lock whose private token it
  // owns. Ordinary Git locks are never removed for recovery.
  if (existsSync(lock) && readFileSync(lock, 'utf8') === `helm-rewind:${token}\n`) rmSync(lock);
  const fd = openSync(lock, 'wx', 0o600);
  const temporaryIndex = `${index}.helm-rewind-${token}`;
  try {
    writeFileSync(fd, `helm-rewind:${token}\n`);
    for (const name of current) rmSync(safePath(saved.root, name), { force: true });
    for (const entry of saved.files) {
      const file = safePath(saved.root, entry.name);
      mkdirSync(dirname(file), { recursive: true });
      if (entry.link != null) symlinkSync(entry.link, file);
      else writeFileSync(file, readFileSync(join(directory, entry.blob)), { mode: entry.mode });
    }
    if (saved.index) {
      writeFileSync(temporaryIndex, readFileSync(join(directory, 'index')), { mode: 0o600 });
      renameSync(temporaryIndex, index);
    } else rmSync(index, { force: true });
  } finally { closeSync(fd); rmSync(lock, { force: true }); rmSync(temporaryIndex, { force: true }); }
}
