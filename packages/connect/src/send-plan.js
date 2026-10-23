import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, basename, dirname } from 'node:path';
import { BULK_SKIP_DIRS } from './bulk-transfer.js';
import { expand } from './paths.js';
const exec = promisify(execFile);
const ENV = /^\.env/i;
const git = async (root, args) => (await exec('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: Infinity })).stdout;

/** Enumerate metadata once, never read or hash file bodies. No file/byte limit. */
export async function scanSend(path, { includeEnv = true, filterFile } = {}) {
  const root = resolve(expand(path)); const stat = await lstat(root);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('send a regular file or folder');
  const kind = stat.isDirectory() ? 'folder' : 'file';
  const envFiles = [], left = [], selected = new Set(); let files = 0, bytes = 0, repository = null;
  let allowed = null;
  const leave = (path, why) => { if (left.length < 40) left.push({ path, why }); };
  if (kind === 'folder') {
    let top;
    try { top = (await git(root, ['rev-parse', '--show-toplevel'])).trim(); }
    catch (error) {
      // A broken repository must not expose ignored files through fallback.
      const marker = await lstat(join(root, '.git')).catch(e => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (marker) throw error;
    }
    if (top === root) {
      const gs = await lstat(join(root, '.git'));
      if (!gs.isDirectory()) throw new Error('linked Git worktrees need a standalone clone before sending');
      allowed = new Set((await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean));
      // Ignored env files are intentionally included through the encrypted lane.
      for (const p of (await git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'])).split('\0')) {
        if (ENV.test(basename(p)) && !p.split('/').some(n => BULK_SKIP_DIRS.includes(n))) allowed.add(p);
      }
      const [branch, dirty] = await Promise.all([git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => 'HEAD'), git(root, ['status', '--porcelain'])]);
      repository = { branch: branch.trim(), dirty: !!dirty.trim() };
    }
  }
  // Each scan owns its filesystem workers. Keep results in traversal order,
  // independent of the order in which metadata reads finish.
  const roots = kind === 'file' ? [{ full: root, p: basename(root) }]
    : allowed ? [{ full: root, p: '', rootOnly: true },
      { full: join(root, '.git'), p: '.git', inGit: true },
      ...[...allowed].map(p => ({ full: join(root, p), p }))]
    : [{ full: root, p: '' }];
  const pending = [...roots]; let next = 0, active = 0;
  const inspect = async node => {
    const { full, p, inGit = false } = node;
    // Directory entries can go stale while waiting for a worker. Never use
    // their type to descend into a directory that became a symbolic link.
    const s = await lstat(full);
    if (full === root && (kind === 'folder' ? !s.isDirectory() : !s.isFile())) {
      throw new Error('The source changed. Choose the file or folder again.');
    }
    if (node.rootOnly) return;
    if (s.isDirectory()) {
      if (allowed && !inGit && p && allowed.has(p)) throw new Error(`Git submodule ${p} needs a standalone copy; refusing to omit its files`);
      if (!inGit && BULK_SKIP_DIRS.includes(basename(p)) && !allowed) { node.skipped = true; return; }
      node.children = (await readdir(full, { withFileTypes: true })).map(entry => ({
        full: join(full, entry.name), p: p ? `${p}/${entry.name}` : entry.name,
        inGit: inGit || p === '.git',
      }));
      for (const child of node.children) pending.push(child);
      return;
    }
    if (!s.isFile() && !s.isSymbolicLink()) throw new Error(`cannot send special file: ${p}`);
    node.size = s.size;
  };
  await new Promise(done => {
    const pump = () => {
      while (active < 32 && next < pending.length) {
        const node = pending[next++]; active++;
        inspect(node).catch(error => { node.error = error; }).finally(() => { active--; pump(); });
      }
      if (!active) done();
    };
    pump();
  });
  const add = node => {
    const { p, inGit = false } = node;
    if (node.error) throw node.error;
    if (node.rootOnly) return;
    if (node.skipped) { leave(p, 'dependency or cache folder'); return; }
    if (node.children) { for (const child of node.children) add(child); return; }
    if (allowed && !inGit && !allowed.has(p)) { leave(p, 'ignored by Git'); return; }
    if (!inGit && ENV.test(basename(p))) {
      envFiles.push(p);
      if (!includeEnv) { leave(p, 'environment file excluded'); return; }
    }
    selected.add(p); files++; bytes += node.size;
  };
  for (const node of roots) {
    try { add(node); } catch (e) { if (!allowed || node.inGit || node.rootOnly || e.code !== 'ENOENT') throw e; }
  }
  if (allowed) leave('(Git ignored files)', 'build output and caches ignored by Git');
  const excludes = allowed ? [] : [...BULK_SKIP_DIRS.map(n => `${n}/`), ...(!includeEnv ? ['.[eE][nN][vV]*'] : [])];
  if (allowed && filterFile) {
    // Literal rsync filter paths (escape wildcard syntax), with parent traversal.
    const literal = p => p.replace(/[\\*?\[\]]/g, '\\$&');
    const dirs = new Set();
    for (const p of selected) { let d = dirname(p); while (d !== '.') { dirs.add(d); d = dirname(d); } }
    await mkdir(dirname(filterFile), { recursive: true, mode: 0o700 });
    await writeFile(filterFile, [...[...dirs].sort().map(p => `+ /${literal(p)}/`), ...[...selected].sort().map(p => `+ /${literal(p)}`), '- *', ''].join('\0'), { mode: 0o600 });
  }
  return { path: root, name: basename(root), kind, git: repository, files, bytes, envFiles, left, excludes, filterFile: allowed ? filterFile : null };
}
