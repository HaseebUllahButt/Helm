import { readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
  return { path: collapse(full) };
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
