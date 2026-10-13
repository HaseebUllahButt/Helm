import { readdir, stat, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { HOME, HELM_DIR, expand, collapse } from './paths.js';

const SKIP = new Set([
  'node_modules', '.git', '.cache', '__pycache__', 'target', 'dist', '.venv',
]);

/** One directory, with just enough signal to choose a place to work. */
export async function list(path = HOME) {
  const dir = expand(path);
  const entries = [];
  const contents = await readdir(dir, { withFileTypes: true });
  for (const d of contents) {
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
  noticeListing(dir, entries);
  return {
    path: collapse(dir),
    parent: dir === '/' ? null : collapse(dirname(dir)),
    entries,
    // Pickers show folders, but transfer preflight must also see ordinary
    // files and hidden entries before deciding a destination is empty.
    entryCount: contents.length,
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
  if (indexAt) {
    addToIndex({ name: clean, path: collapse(full), repo: false });
    await saveIndex();
  }
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
// A walk of a dev machine's home takes about half a second, so it is cheap
// to redo whenever a picker asks and the last one is a minute old: a folder
// made in a terminal shows up the next time the picker opens.
const INDEX_TTL = 60_000;
// How long a picker waits on that walk before answering from the last one.
const INDEX_WAIT_MS = 3000;
const INDEX_DEPTH = 10;
// ~/.config holds browser profiles thousands of cache folders deep; nobody
// starts a project in one. ~/.config/nvim/lua is as deep as it is useful.
const CONFIG_DEPTH = 2;
const INDEX_MAX = 60_000;
const INDEX_WORKERS = 16;

let indexDirs = [];
let indexAt = 0;
/** The in-flight build, so two callers share one walk rather than racing. */
let building = null;
let restoring = null;
let additions = [];
let saving = Promise.resolve();
const INDEX_FILE = join(HELM_DIR, 'folder-index.json');

// The cache is scoped to this home and schema; an old cache is still useful
// immediately while the background walk refreshes it.
function restoreIndex() {
  return restoring ??= readFile(INDEX_FILE, 'utf8').then(JSON.parse).then((cache) => {
    if (cache.version !== 1 || cache.home !== HOME || !Number.isFinite(cache.at)
        || cache.at <= 0 || cache.at > Date.now() || !Array.isArray(cache.dirs)
        || cache.dirs.length > INDEX_MAX || !cache.dirs.every((d) =>
          typeof d.name === 'string' && typeof d.path === 'string' && d.path.startsWith('~/')
          && typeof d.repo === 'boolean')) return;
    indexDirs = cache.dirs;
    indexAt = cache.at;
    stamp = null;
  }).catch(() => {});
}

function saveIndex() {
  const data = JSON.stringify({ version: 1, home: HOME, at: indexAt, dirs: indexDirs });
  saving = saving.then(async () => {
    await mkdir(HELM_DIR, { recursive: true });
    const temp = `${INDEX_FILE}.${process.pid}.tmp`;
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, INDEX_FILE);
  }).catch(() => {}); // A read-only/full disk must not prevent searching.
  return saving;
}

async function buildIndex() {
  const out = [];
  const queue = [[HOME, 0]];
  const config = join(HOME, '.config');
  // Start each batch with actual work for every worker. Starting 16 loops
  // with only HOME queued made 15 exit before HOME's first readdir returned.
  while (queue.length && out.length < INDEX_MAX) {
    await Promise.all(queue.splice(0, INDEX_WORKERS).map(async ([dir, depth]) => {
      let ents;
      try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const d of ents) {
        if (out.length >= INDEX_MAX) return;
        if (!d.isDirectory()) continue;
        if (SKIP.has(d.name)) continue;
        if (d.name.startsWith('.') && d.name !== '.config') continue;
        const full = join(dir, d.name);
        const repo = await stat(join(full, '.git')).then(() => true, () => false);
        if (out.length >= INDEX_MAX) return;
        out.push({ name: d.name, path: collapse(full), repo });
        if (depth >= INDEX_DEPTH) continue;
        if ((full === config || full.startsWith(config + '/')) && full.split('/').length - config.split('/').length >= CONFIG_DEPTH) continue;
        queue.push([full, depth + 1]);
      }
    }));
  }
  return out;
}

/**
 * Keep the index warm. Called at daemon start and on the first search that
 * finds it stale or absent; the rebuild itself happens once, in the
 * background, shared by however many callers ask while it runs.
 */
export async function warmIndex({ force = false } = {}) {
  await restoreIndex();
  if (!building && (force || Date.now() - indexAt > INDEX_TTL)) {
    additions = [];
    building = buildIndex()
      .then(async (dirs) => {
        const known = new Set(dirs.map((d) => d.path));
        indexDirs = [...dirs, ...additions.filter((d) => !known.has(d.path))];
        indexAt = Date.now();
        stamp = null;
        await saveIndex();
      })
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
  await restoreIndex();
  void warmIndex();
  // No index yet means the first-ever search: wait for the walk rather than
  // answering from nothing. Afterwards, stale results still beat no answer.
  if (!indexAt) await warmIndex();
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

/** A folder Helm has seen appear: searchable now, not after the next walk. */
function addToIndex(entry) {
  if (indexDirs.some((d) => d.path === entry.path)) return false;
  indexDirs.push(entry);
  if (building) additions.push(entry);
  stamp = null;
  return true;
}

/**
 * Browsing a folder is a free look at what is in it: folders made or
 * removed since the last walk are put right in the index at once.
 */
function noticeListing(dir, entries) {
  if (!indexAt) return;
  const at = collapse(dir);
  if (at !== '~' && !at.startsWith('~/')) return;
  const prefix = at === '~' ? '~/' : `${at}/`;
  const here = new Set(entries.filter((e) => !e.skip).map((e) => e.path));
  let changed = false;
  // Only direct children are compared; what is below a removed folder goes too.
  const gone = new Set(indexDirs.filter((d) => d.path.startsWith(prefix) && !d.path.slice(prefix.length).includes('/') && !here.has(d.path)
    && !(d.name.startsWith('.') && d.name !== '.config')).map((d) => d.path));
  if (gone.size) {
    indexDirs = indexDirs.filter((d) => !gone.has(d.path) && ![...gone].some((g) => d.path.startsWith(`${g}/`)));
    stamp = null; changed = true;
  }
  for (const e of entries) if (!e.skip && addToIndex({ name: e.name, path: e.path, repo: e.isRepo })) changed = true;
  if (changed) void saveIndex();
}

let stamp = null;
const stampOf = () => stamp ??= createHash('sha1').update(indexDirs.map((d) => `${d.repo ? '+' : ''}${d.path}`).join('\n')).digest('hex').slice(0, 16);

/**
 * The whole index, for a device to search as you type without asking the
 * machine each time. Folders are sent as a tree - each a name and the index
 * of the folder it is in (-1 for home) - which is a fraction of the size of
 * their paths. `since` is the stamp the device already holds: an unchanged
 * index answers with just the stamp. A stale index is walked again first,
 * waited on briefly, so opening a picker sees the folders as they are now.
 */
export async function folderIndex({ since = null, refresh = false } = {}) {
  await restoreIndex();
  const walk = warmIndex({ force: refresh });
  if (walk) await Promise.race([walk, new Promise((r) => setTimeout(r, INDEX_WAIT_MS).unref?.())]);
  const head = { stamp: stampOf(), at: indexAt, count: indexDirs.length, building: !!building };
  if (since && since === head.stamp) return { ...head, unchanged: true };
  const position = new Map();
  const names = [], parents = [], repos = [];
  // Parents before children: the walk is breadth first, and later additions
  // are appended, but a removed-then-readded parent could land after its
  // children, so order by depth to be sure.
  const ordered = [...indexDirs].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const d of ordered) {
    const parent = d.path.slice(0, d.path.lastIndexOf('/'));
    const p = parent === '~' ? -1 : position.get(parent);
    if (p === undefined) continue; // its parent fell out of the index
    position.set(d.path, names.length);
    if (d.repo) repos.push(names.length);
    names.push(d.name); parents.push(p);
  }
  return { ...head, names, parents, repos };
}
