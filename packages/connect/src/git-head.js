import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * The branch a folder is on, read from git's own files - no `git` process,
 * so a list of fifty threads costs fifty small reads, not fifty spawns.
 * A worktree's `.git` is a file naming its real git dir; a detached HEAD
 * reads as the short commit. Remembered briefly, since the list asks often.
 */
const cache = new Map();
const TTL_MS = 10_000;

function headOf(dir) {
  const dotgit = join(dir, '.git');
  let st;
  try { st = statSync(dotgit); } catch { return undefined; }
  let gitdir = dotgit;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'));
    if (!m) return null;
    gitdir = resolve(dir, m[1].trim());
  }
  const head = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return ref ? ref[1] : /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : null;
}

export function gitBranch(cwd, now = Date.now()) {
  if (!cwd || typeof cwd !== 'string') return null;
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit.branch;
  let branch = null;
  // Detected chats keep their folder as `~/…`; a relative path would be read
  // against wherever this daemon runs and borrow that folder's branch.
  const path = cwd === '~' || cwd.startsWith('~/') ? join(homedir(), cwd.slice(1)) : cwd;
  try {
    if (!isAbsolute(path)) throw new Error('not a full path');
    for (let dir = resolve(path), i = 0; i < 40; i++) {
      const found = headOf(dir);
      if (found !== undefined) { branch = found; break; }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { branch = null; }
  cache.set(cwd, { branch, at: now });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return branch;
}
