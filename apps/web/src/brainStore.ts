import type { Session } from './client';

/**
 * Where the brain is, remembered on this device.
 *
 * There is one brain and choosing it happens once, so opening it should land
 * in the conversation - not in the screen that offers to create one. But the
 * app only knows a brain exists after every machine has answered
 * `session.list`, and on a cold open that is a second or two during which the
 * honest answer to "is there a brain?" is "not yet". Tapping Brain in that
 * window used to show the account picker, which reads as helm having
 * forgotten the brain you already chose.
 *
 * So the device writes down where it is. The remembered record is only a
 * signpost: it carries enough of the session for the header to draw, and the
 * real record replaces it as soon as the machine's list arrives.
 */
const KEY = 'helm.brain';

export interface RememberedBrain {
  envId: string;
  session: Session;
}

export function loadBrain(): RememberedBrain | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    return raw?.envId && raw?.session?.id ? raw : null;
  } catch { return null; }
}

export function saveBrain(envId: string, session: Session) {
  try {
    // Only what a session header needs before the live record lands.
    const { id, title, cwd, engine, driver, profileId, model, status } = session;
    localStorage.setItem(KEY, JSON.stringify({
      envId, session: { id, title, cwd, engine, driver, profileId, model, status, brain: true },
    }));
  } catch { /* private window, or storage refused: the scan still finds it */ }
}

export function forgetBrain() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}
