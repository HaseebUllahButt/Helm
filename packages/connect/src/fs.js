import { readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { HOME, expand, collapse } from './paths.js';

const SKIP = new Set([
  'node_modules', '.git', '.cache', '__pycache__', 'target', 'dist', '.venv',
]);

/** One directory, with just enough signal to choose a place to work. */
export async function list(path = HOME) {
  const dir = expand(path);
  const entries = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.') && d.name !== '.config') continue;
    if (!d.isDirectory()) continue;
    const full = join(dir, d.name);
    entries.push({
      name: d.name,
      path: collapse(full),
      isRepo: existsSync(join(full, '.git')),
      skip: SKIP.has(d.name),
    });
  }
  entries.sort(
    (a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name)
  );
  return {
    path: collapse(dir),
    parent: dir === '/' ? null : collapse(dirname(dir)),
    entries,
  };
}

/**
 * Create a directory inside `path`.
 *
 * The name is a single segment: allowing separators here would let a phone
 * write anywhere on the machine by passing `../..`, which is not what
 * "new folder" should mean.
 */
export async function makeDir({ path, name }) {
  const clean = String(name ?? '').trim();
  if (!clean || clean === '.' || clean === '..') throw new Error('invalid folder name');
  if (/[/\\]/.test(clean)) throw new Error('folder name cannot contain a path separator');

  const parent = expand(path);
  const full = join(parent, clean);
  if (!full.startsWith(parent + '/')) throw new Error('refusing to escape the parent directory');

  await mkdir(full, { recursive: false, mode: 0o755 });
  // A folder made through the picker should be searchable at once, not after
  // the index's next scheduled walk.
  if (indexAt) indexDirs.push({ name: clean, path: collapse(full), repo: false });
  return { path: collapse(full) };
}

export function projectPath(path) {
  return collapse(resolve(expand(path)));
}

export async function project(path) {
  const normalized = projectPath(path);
  const full = expand(normalized);
  const info = await stat(full);
  if (!info.isDirectory()) throw new Error('a project must be a directory');
  return { path: normalized, title: basename(full) || full };
}

/**
 * Sensible starting points, so the phone opens on somewhere useful instead of
 * making you walk down from $HOME every time.
 */
export async function roots() {
  const candidates = [HOME, join(HOME, 'dev'), join(HOME, 'work'), join(HOME, 'Projects')];
  const out = [];
  for (const c of candidates) {
    try {
      const s = await stat(c);
      if (s.isDirectory()) out.push({ name: c === HOME ? '~' : c.split('/').pop(), path: collapse(c) });
    } catch { /* not every machine has every one of these */ }
  }
  return { roots: out };
}

// ------------------------------------------------------------- the index

/**
 * Every directory under $HOME, walked once and kept in memory.
 *
 * A folder picker that searches is only quick if the walking is already
 * done: a dev machine holds tens of thousands of directories, and reading
 * them per keystroke would take seconds each time and burn the disk for a
 * list that changes slowly. So the walk runs once in the background and is
 * redone when the index is older than `INDEX_TTL` - staleness costs a new
 * folder not matching for a few minutes, which `fs.mkdir` patches directly
 * for the folders helm itself makes.
 *
 * The pruning mirrors `list()`: hidden directories are out (except
 * `.config`), and containers like `node_modules` are not descended into -
 * nor indexed at all, because "node_modules" is a name nobody searches for
 * to pick a place to work.
 */
const INDEX_TTL = 10 * 60_000;
const INDEX_DEPTH = 10;
const INDEX_MAX = 60_000;
const INDEX_WORKERS = 16;

let indexDirs = [];
let indexAt = 0;
/** The in-flight build, so two callers share one walk rather than racing. */
let building = null;

async function buildIndex() {
  const out = [];
  const queue = [[HOME, 0]];
  const worker = async () => {
    while (queue.length && out.length < INDEX_MAX) {
      const [dir, depth] = queue.shift();
      let ents;
      try { ents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of ents) {
        if (out.length >= INDEX_MAX) return;
        if (!d.isDirectory()) continue;
        if (SKIP.has(d.name)) continue;
        if (d.name.startsWith('.') && d.name !== '.config') continue;
        const full = join(dir, d.name);
        out.push({ name: d.name, path: collapse(full), repo: existsSync(join(full, '.git')) });
        if (depth < INDEX_DEPTH) queue.push([full, depth + 1]);
      }
    }
  };
  await Promise.all(Array.from({ length: INDEX_WORKERS }, worker));
  return out;
}

/**
 * Keep the index warm. Called at daemon start and on the first search that
 * finds it stale or absent; the rebuild itself happens once, in the
 * background, shared by however many callers ask while it runs.
 */
export function warmIndex() {
  if (!building && (Date.now() - indexAt > INDEX_TTL)) {
    building = buildIndex()
      .then((dirs) => { indexDirs = dirs; indexAt = Date.now(); })
      .catch(() => { /* a half-read tree still beats refusing to search */ })
      .finally(() => { building = null; });
  }
  return building;
}

/**
 * Match `query` against every indexed directory.
 *
 * Every whitespace-separated word must appear in the path, so "dev helm"
 * finds `~/dev/me/github/helm` without knowing how the path is punctuated.
 * Ranking favours what a picker is for: an exact or prefix name hit beats a
 * substring, a git repo beats a plain folder, and the shorter path wins
 * ties because `~/dev/x` is likelier to be the project than `~/dev/x/a/b`.
 */
export async function search(query, { limit = 30 } = {}) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { results: [], indexed: indexDirs.length };
  warmIndex();
  // No index yet means the first-ever search: wait for the walk rather than
  // answering from nothing. Afterwards, stale results still beat no answer.
  if (!indexDirs.length && building) await building;
  const q = words.join(' ');
  const scored = [];
  for (const d of indexDirs) {
    const path = d.path.toLowerCase();
    if (!words.every((w) => path.includes(w))) continue;
    const name = d.name.toLowerCase();
    const rank = name === q ? 0 : name.startsWith(words[0]) ? 1 : name.includes(words[0]) ? 2 : 3;
    scored.push({ name: d.name, path: d.path, repo: d.repo, score: rank - (d.repo ? 0.5 : 0) });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return { results: scored.slice(0, Math.max(1, Math.min(limit, 100))), indexed: indexDirs.length };
}
