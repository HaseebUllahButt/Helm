import type { Session } from './client';

/**
 * Where the brains are, remembered on this device.
 *
 * There is one brain per machine and choosing it happens once per machine, so
 * opening one should land in the conversation - not in the screen that offers
 * to create it. But the app only knows a machine has a brain after that
 * machine has answered `session.list`, and on a cold open that is a second or
 * two during which the honest answer to "is there a brain here?" is "not yet".
 * Tapping a brain in that window used to show the account picker, which reads
 * as helm having forgotten the brain you already chose.
 *
 * So the device writes them down, keyed by machine. A remembered record is
 * only a signpost: it carries enough of the session for the header to draw,
 * and the real record replaces it as soon as the machine's list arrives - or
 * removes it, if that list has no brain in it any more.
 */
const KEY = 'helm.brains';
/** The one-brain-per-network key this replaced. Read once, then folded in. */
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
