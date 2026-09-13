import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const HOME = homedir();
export const HELM_DIR = process.env.HELM_DIR || join(HOME, '.helm');
export const CONFIG_FILE = join(HELM_DIR, 'config.json');
export const PROFILES_FILE = join(HELM_DIR, 'profiles.json');
export const SECRETS_FILE = join(HELM_DIR, 'secrets.env');
export const KEY_FILE = join(HELM_DIR, 'id_ed25519');
// Overridable so tests (and anyone auditing helm) can point the SSH mesh at a
// throwaway directory instead of the real one.
export const SSH_DIR = process.env.HELM_SSH_DIR || join(HOME, '.ssh');

/** Expand a leading ~ so profiles can stay portable between machines. */
export const expand = (p) =>
  typeof p === 'string' && p.startsWith('~')
    ? join(HOME, p.slice(1))
    : p;

/** Collapse an absolute path back to ~ form for display and storage. */
export const collapse = (p) => {
  if (typeof p !== 'string' || !p) return p;
  if (p.startsWith('~')) return p;          // already collapsed
  if (!p.startsWith('/')) return p;         // not a path at all
  const abs = resolve(p);
  return abs.startsWith(HOME) ? '~' + abs.slice(HOME.length) : abs;
};
