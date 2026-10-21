import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  let repo = null;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'));
    if (!m) return { branch: null, repo: null };
    gitdir = resolve(dir, m[1].trim());
    // A linked worktree's git dir is `<repo>/.git/worktrees/<name>`.
    const parts = gitdir.split('/');
    const at = parts.lastIndexOf('worktrees');
    if (at >= 2 && parts[at - 1] === '.git') repo = parts.slice(0, at - 1).join('/') || '/';
  }
  const head = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  // `.invalid` is what git writes while a clone is still coming down.
  const branch = ref ? (ref[1] === '.invalid' ? null : ref[1]) : /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : null;
  return { branch, repo };
}

export function gitBranch(cwd, now = Date.now()) { return readHead(cwd, now).branch; }

/**
 * The folder in the main checkout that a linked worktree's folder stands
 * for - the same place in the repo the worktree came from - or null when
 * `cwd` is not inside a linked worktree. Written the way `cwd` was, `~` or not.
 */
export function worktreeHome(cwd, now = Date.now()) {
  const { repo, root } = readHead(cwd, now);
  if (!repo) return null;
  const home = homedir();
  const path = cwd === '~' || cwd.startsWith('~/') ? join(home, cwd.slice(1)) : cwd;
  const out = join(repo, relative(root, resolve(path)));
  return cwd.startsWith('~') && (out === home || out.startsWith(`${home}/`)) ? `~${out.slice(home.length)}` : out;
}

function readHead(cwd, now) {
  if (!cwd || typeof cwd !== 'string') return { branch: null, repo: null };
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit;
  let found = { branch: null, repo: null };
  // Detected chats keep their folder as `~/…`; a relative path would be read
  // against wherever this daemon runs and borrow that folder's branch.
  const path = cwd === '~' || cwd.startsWith('~/') ? join(homedir(), cwd.slice(1)) : cwd;
  try {
    if (!isAbsolute(path)) throw new Error('not a full path');
    for (let dir = resolve(path), i = 0; i < 40; i++) {
      const head = headOf(dir);
      if (head !== undefined) { found = { ...head, root: dir }; break; }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { found = { branch: null, repo: null }; }
  const entry = { ...found, at: now };
  cache.set(cwd, entry);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return entry;
}
