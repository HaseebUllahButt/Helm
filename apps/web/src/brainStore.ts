import type { Session } from './client';

/**
 * A signpost to the VM conversation while its session list is loading.
 * Keep old per-machine records readable for paired devices; the shell only
 * uses the chosen VM's record. Other machines' chats are preserved.
 */
const KEY = 'helm.brains';
/** An older paired device may still use this key. */
const LEGACY = 'helm.brain';

export interface RememberedBrain {
  envId: string;
  session: Session;
}

const ok = (x: any): x is RememberedBrain => !!x?.envId && !!x?.session?.id;

export function loadBrains(): RememberedBrain[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (Array.isArray(raw)) return raw.filter(ok);
  } catch { /* unreadable: fall through to the legacy key */ }
  try {
    // A device that was paired before brains were per machine remembers one.
    // It belongs to whichever machine it was on, so it survives the change.
    const old = JSON.parse(localStorage.getItem(LEGACY) || 'null');
    localStorage.removeItem(LEGACY);
    if (ok(old)) { localStorage.setItem(KEY, JSON.stringify([old])); return [old]; }
  } catch { /* private window, or storage refused: the scan still finds them */ }
  return [];
}

export function saveBrain(envId: string, session: Session) {
  try {
    // Only what a session header needs before the live record lands.
    const { id, title, cwd, engine, driver, profileId, model, status } = session;
    const rest = loadBrains().filter((b) => b.envId !== envId);
    localStorage.setItem(KEY, JSON.stringify([
      ...rest,
      { envId, session: { id, title, cwd, engine, driver, profileId, model, status, brain: true } },
    ]));
  } catch { /* private window, or storage refused: the scan still finds it */ }
}

export function forgetBrain(envId: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadBrains().filter((b) => b.envId !== envId)));
  } catch { /* nothing to do */ }
}
