import {
  existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';
import { ROOTS_FILE, expand } from './paths.js';

/**
 * The folders this machine has agreed to serve media from.
 *
 * This list is the whole security boundary of the NAS role: the media server
 * resolves every request underneath one of these folders and refuses
 * everything else, so what is not here does not exist as far as a phone is
 * concerned. Nothing is shared by default - an absent file and an empty one
 * mean the same thing, which is no folders.
 *
 * What is stored is the *resolved* path, not the path as typed. A root that
 * is itself a symlink is pinned to what it pointed at when it was added, so
 * retargeting the link later does not quietly redirect the share.
 */

const load = (file) => {
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, 'utf8')).roots ?? []; }
  catch { return []; }
};

const save = (roots, file) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ roots }, null, 2), { mode: 0o600 });
};

/** The configured roots, in the order they were added. */
export function mediaRoots({ file = ROOTS_FILE } = {}) {
  return load(file).map((path, id) => ({ id, name: basename(path) || path, path }));
}

/**
 * Share a folder.
 *
 * The path must exist and be a directory: anything weaker would let a typo
 * on a phone register a file - or nothing - as a source of media. Adding
 * what is already shared is a no-op, so the list stays a set.
 */
export function addMediaRoot(input, { file = ROOTS_FILE } = {}) {
  const dir = resolvePath(expand(String(input ?? '').trim()));
  let real;
  try { real = realpathSync(dir); }
  catch { throw new Error(`no such folder: ${input}`); }
  if (!statSync(real).isDirectory()) throw new Error(`not a folder: ${input}`);

  const roots = load(file);
  if (!roots.includes(real)) {
    roots.push(real);
    save(roots, file);
  }
  return mediaRoots({ file });
}

/**
 * Stop sharing a folder. Removal is best-effort about resolution: a root
 * whose folder has since been deleted must still be removable, so the stored
 * real path is compared against both the resolved and the literal input.
 */
export function removeMediaRoot(input, { file = ROOTS_FILE } = {}) {
  const wanted = resolvePath(expand(String(input ?? '').trim()));
  let real;
  try { real = realpathSync(wanted); } catch { real = wanted; }
  const roots = load(file).filter((p) => p !== real && p !== wanted);
  save(roots, file);
  return mediaRoots({ file });
}
