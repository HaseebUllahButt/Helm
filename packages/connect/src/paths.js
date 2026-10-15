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
  return abs === HOME || abs.startsWith(HOME + '/') ? '~' + abs.slice(HOME.length) : abs;
};

/**
 * Where a chat with no folder runs. Every CLI needs a working directory, so a
 * "quick chat" gets an empty one of its own, named by its session id, that
 * lives and dies with the chat.
 */
export const QUICK_DIR = join(HELM_DIR, 'quick');
export const quickDir = (id) => join(QUICK_DIR, id);
/** Whether a path is one of those scratch folders (or inside one). */
export const isQuickDir = (p) => {
  const full = typeof p === 'string' ? resolve(expand(p)) : '';
  return full.startsWith(QUICK_DIR + '/') && full.length > QUICK_DIR.length + 1;
};
