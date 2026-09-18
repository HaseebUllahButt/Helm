import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export const HOME = homedir();

// Renamed from helm: fresh installs get ~/.con, but an existing ~/.helm still
// holds the keys, pairings and logs of a helm install, so keep reading it
// rather than make every machine start over.
const homeDir = () => {
  const fresh = join(HOME, '.con');
  const legacy = join(HOME, '.helm');
  return existsSync(fresh) || !existsSync(legacy) ? fresh : legacy;
};

export const CON_DIR = process.env.CON_DIR || process.env.HELM_DIR || homeDir();
export const CONFIG_FILE = join(CON_DIR, 'config.json');
export const PROFILES_FILE = join(CON_DIR, 'profiles.json');
export const SECRETS_FILE = join(CON_DIR, 'secrets.env');
export const KEY_FILE = join(CON_DIR, 'id_ed25519');
// Overridable so tests (and anyone auditing con) can point the SSH mesh at a
// throwaway directory instead of the real one.
export const SSH_DIR = process.env.CON_SSH_DIR || process.env.HELM_SSH_DIR || join(HOME, '.ssh');

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
