/**
 * A chat lives in a folder, and the folder must not kill it.
 *
 * Folders move: a symlink is removed, a project is renamed, a repo is
 * cloned again somewhere else. A chat keeps what it needs to find its
 * folder again: the real path (symlinks resolved) and two marks of
 * identity, read when it starts there. The folder's inode stays the same
 * through a rename or a move on the same disk, so Helm writes no tag file
 * into the owner's folder. The git identity (first commit, remotes) finds
 * a fresh clone of the same repo.
 *
 * The AI's own history is the other half. Claude files a conversation
 * under its folder's path and `--resume` looks only there, so a chat that
 * runs somewhere new gets a hard link of its conversation in the new
 * folder's place: both names write to one file. Codex resumes by id from
 * any folder.
 */
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readSync, readdirSync,
  realpathSync, statSync, symlinkSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { HELM_DIR } from './paths.js';
import { sameProject } from './project-key.js';

/** Claude names a project folder after its path, every other character a dash. */
export const claudeKey = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** The folder itself, not the symlink that led to it. */
export function realFolder(path) {
  try { return realpathSync(path); } catch { return path; }
}

/** Same on every path that reaches the folder, kept through a rename. */
export function folderStamp(path) {
  try { const s = statSync(path); return s.isDirectory() ? `${s.dev}:${s.ino}` : null; } catch { return null; }
}

/** Where a chat waits while its folder is missing: empty, and Helm's own. */
export const waitingFolder = (id) => join(HELM_DIR, 'folder-missing', id);

/** Claude's conversation file for `id`, under any folder it was filed in. */
export function claudeTranscript(home, id) {
  if (!home || !id) return null;
  const projects = join(home, 'projects');
  let dirs = [];
  try { dirs = readdirSync(projects, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = join(projects, d.name, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Make Claude's conversation `id` resumable from `cwd`. A hard link, so
 * the old and new places stay one file; a copy where a link cannot be made.
 * The folder of its helpers' and tools' files goes along as a symlink.
 * Answers 'here', 'linked', 'copied' or null when Claude has no such file.
 */
export function linkClaudeHistory(home, id, cwd) {
  if (!home || !id || !cwd) return null;
  const place = join(home, 'projects', claudeKey(realFolder(cwd)));
  const target = join(place, `${id}.jsonl`);
  if (existsSync(target)) return 'here';
  const source = claudeTranscript(home, id);
  if (!source) return null;
  mkdirSync(place, { recursive: true });
  let how = 'linked';
  try { linkSync(source, target); }
  catch { copyFileSync(source, target); how = 'copied'; }
  const extra = join(dirname(source), id);
  if (isDir(extra) && !existsSync(join(place, id))) {
    try { symlinkSync(extra, join(place, id)); } catch { /* the conversation itself is enough to resume */ }
  }
  return how;
}

/** The end of a file, where the newest lines are. */
function tail(file, bytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

/** The start of a file, where Codex writes its session header. */
function head(file, bytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The folder the AI itself says it last ran in. Claude writes `cwd` on
 * every line, resolved; Codex writes it in its session header and in each
 * turn's context. A symlink the chat was started through is gone from it.
 */
export function recordedFolder(engine, file) {
  if (!file) return null;
  if (engine === 'claude') {
    const found = [...tail(file, 256 * 1024).matchAll(/"cwd":("(?:[^"\\]|\\.)*")/g)].pop();
    try { return found ? JSON.parse(found[1]) : null; } catch { return null; }
  }
  if (engine === 'codex') {
    let cwd = null;
    for (const line of head(file, 64 * 1024).split('\n')) {
      try {
        const row = JSON.parse(line);
        if ((row.type === 'session_meta' || row.type === 'turn_context') && typeof row.payload?.cwd === 'string') cwd = row.payload.cwd;
      } catch { /* a cut line */ }
    }
    const last = [...tail(file, 256 * 1024).matchAll(/"type":"turn_context","payload":\{[^}]*?"cwd":("(?:[^"\\]|\\.)*")/g)].pop();
    try { return last ? JSON.parse(last[1]) : cwd; } catch { return cwd; }
  }
  return null;
}

/** Folders next to the missing one, or next to the nearest parent still there. */
async function nearby(missing) {
  let dir = dirname(missing);
  while (dir !== dirname(dir) && !isDir(dir)) dir = dirname(dir);
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => ({ path: join(dir, e.name), repo: isDir(join(dir, e.name, '.git')) || existsSync(join(dir, e.name, '.git')) }));
}

/**
 * Where a missing folder went. In order: the folder the AI recorded, the
 * same folder by inode (renamed or moved), then one repo with the same git
 * identity. More than one repo match is a choice for the owner: they come
 * back as `candidates`, and nothing is picked.
 *
 * `folders()` lists the folders to look in ({ path, repo }), `keysOf`
 * reads git identities, as `projectKeysFor` does.
 */
export async function findMovedFolder({ missing, stamp = null, keys = null, recorded = [], folders = async () => [], keysOf }) {
  for (const path of recorded) {
    if (path && path !== missing && isDir(path)) return { found: path, how: 'recorded', candidates: [] };
  }
  const seen = new Set([missing]);
  const list = [];
  for (const f of [...await nearby(missing), ...await folders().catch(() => [])]) {
    if (!f?.path || seen.has(f.path)) continue;
    seen.add(f.path);
    list.push(f);
  }
  if (stamp) {
    for (let i = 0; i < list.length; i += 64) {
      const batch = list.slice(i, i + 64);
      const stamps = await Promise.all(batch.map((f) => stat(f.path).then((s) => `${s.dev}:${s.ino}`, () => null)));
      const at = stamps.indexOf(stamp);
      if (at >= 0) return { found: batch[at].path, how: 'same', candidates: [] };
    }
  }
  if (!keys?.length || !keysOf) return { found: null, how: null, candidates: [] };
  const repos = list.filter((f) => f.repo).map((f) => f.path);
  const all = await keysOf(repos);
  let matches = repos.filter((path) => sameProject(keys, all[path]));
  const named = matches.filter((path) => basename(path) === basename(missing));
  if (named.length === 1) return { found: named[0], how: 'repo', candidates: [] };
  if (matches.length === 1) return { found: matches[0], how: 'repo', candidates: [] };
  if (named.length) matches = [...named, ...matches.filter((path) => !named.includes(path))];
  return { found: null, how: null, candidates: matches.slice(0, 5) };
}

/** `path` under `from`, moved under `to`; null when it is not under `from`. */
export function movedPath(path, from, to) {
  if (path === from) return to;
  if (path?.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}
