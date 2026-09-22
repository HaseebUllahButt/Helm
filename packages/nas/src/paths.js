import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
// Duplicated from @helm/protocol rather than imported: the media server must
// come up on a machine whose network file it may not be able to read, and a
// package that needs one directory should not have to load the roster to
// find it.
export const HELM_DIR = process.env.HELM_DIR || join(HOME, '.helm');
export const ROOTS_FILE = join(HELM_DIR, 'nas-roots.json');

/** Expand a leading ~ so a root survives being typed on another machine. */
export const expand = (p) =>
  typeof p === 'string' && p.startsWith('~')
    ? join(HOME, p.slice(1))
    : p;
