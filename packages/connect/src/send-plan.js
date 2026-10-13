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
    try {
      if ((await git(root, ['rev-parse', '--show-toplevel'])).trim() === root) {
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
    } catch (e) { if (/linked Git/.test(e.message)) throw e; }
  }
  const add = async (full, p, inGit = false) => {
    const s = await lstat(full);
    if (s.isDirectory()) {
      if (allowed && !inGit && p && allowed.has(p)) throw new Error(`Git submodule ${p} needs a standalone copy; refusing to omit its files`);
      if (!inGit && BULK_SKIP_DIRS.includes(basename(p)) && !allowed) { leave(p, 'dependency or cache folder'); return; }
      for (const entry of await readdir(full)) await add(join(full, entry), p ? `${p}/${entry}` : entry, inGit || p === '.git');
      return;
    }
    if (!s.isFile() && !s.isSymbolicLink()) throw new Error(`cannot send special file: ${p}`);
    if (allowed && !inGit && !allowed.has(p)) { leave(p, 'ignored by Git'); return; }
    if (!inGit && ENV.test(basename(p))) {
      envFiles.push(p);
      if (!includeEnv) { leave(p, 'environment file excluded'); return; }
    }
    selected.add(p); files++; bytes += s.size;
  };
  if (kind === 'file') await add(root, basename(root));
  else if (allowed) {
    // Do not walk ignored dependency trees just to exclude them.
    await add(join(root, '.git'), '.git', true);
    for (const p of allowed) { try { await add(join(root, p), p); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    leave('(Git ignored files)', 'build output and caches ignored by Git');
  } else await add(root, '');
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
