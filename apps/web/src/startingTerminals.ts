import { errorMessage } from './errors';
import type { Client, Session } from './client';

/**
 * New terminals whose machine has not answered yet.
 *
 * On another machine a terminal is a round trip or two away, and over a slow
 * link that is seconds. The key used to do nothing until the machine
 * answered, and nothing at all if it never did. Now the terminal screen
 * opens at once and says it is opening; if it cannot, the reason shows
 * there with a way to try again. Kept outside React so leaving the screen
 * does not lose the start, like a starting chat (startingChats.ts).
 */

export interface StartingTerminal {
  id: string;
  envId: string;
  cwd: string;
  state: 'opening' | 'failed' | 'opened';
  error?: string;
  session?: Session;
  since: number;
}

/**
 * The screen that came back with the start, for the terminal that draws
 * it, so that terminal does not ask for it again. Output pushed since the
 * machine took that screen waits here with it until the terminal is drawn.
 */
export interface FirstScreen {
  watcher: string;
  text: string;
  position?: number;
  cols: number;
  rows: number;
  later: { text: string; reset: boolean; position?: number }[];
}

const terminals = new Map<string, StartingTerminal>();
const listeners = new Set<(t: StartingTerminal) => void>();
const screens = new Map<string, FirstScreen & { stop: () => void }>();
let seq = 0;

const notify = (t: StartingTerminal) => { for (const l of listeners) l(t); };

export function startingTerminal(id: string): StartingTerminal | undefined { return terminals.get(id); }

export function onStartingTerminal(listener: (t: StartingTerminal) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The first screen of a terminal that just opened, once. */
export function takeFirstScreen(sessionId: string): FirstScreen | undefined {
  const screen = screens.get(sessionId);
  if (!screen) return undefined;
  screens.delete(sessionId);
  screen.stop();
  return screen;
}

/**
 * About the size the terminal will draw at (13px JetBrains Mono, see
 * Terminal.tsx), so the shell starts close to it. The exact size follows
 * once it is drawn.
 */
function likelySize() {
  const sidebar = window.innerWidth >= 900 ? 290 : 0;
  return {
    cols: Math.max(20, Math.floor((window.innerWidth - sidebar - 40) / 7.8)),
    rows: Math.max(8, Math.floor((window.innerHeight - 150) / 15)),
  };
}

/** Open a terminal and keep its first screen for whoever draws it. */
export async function openTerminal(client: Client, envId: string, cwd: string): Promise<Session> {
  const watcher = globalThis.crypto?.randomUUID?.() ?? `terminal-${Date.now()}-${Math.random()}`;
  const size = likelySize();
  // The machine pushes output from the moment it takes the screen, and a
  // push can arrive before the reply does. Listen first; keep this
  // terminal's pieces once its id is known.
  let early: { id: string; text: string; reset: boolean; position?: number }[] = [];
  let mine: string | null = null;
  const off = client.on((e, kind, payload) => {
    if (e !== envId || kind !== 'session.data' || !payload?.id || (mine && payload.id !== mine)) return;
    early.push({ id: payload.id, text: payload.text ?? '', reset: !!payload.reset, position: payload.position });
  });
  let r: { session: Session; attach?: { text: string | null; position?: number } };
  try {
    r = await client.rpc(envId, 'session.start', { cwd, profileId: 'shell', attach: { ...size, watcher } }, 45_000);
  } catch (e) { off(); throw e; }
  if (!r?.session) { off(); throw new Error('The machine did not open a terminal. Try again.'); }
  // An older machine does not send the screen; the terminal then asks for it.
  if (!r.attach) { off(); return r.session; }
  const id = mine = r.session.id;
  // Pieces still on their way join these until the terminal takes them.
  early = early.filter((piece) => piece.id === id);
  // Not drawn soon - the person went somewhere else - and the terminal asks
  // for its screen itself when it is opened later.
  const expiry = setTimeout(() => { if (screens.get(id)?.watcher === watcher) screens.delete(id); off(); }, 30_000);
  screens.set(id, {
    watcher, text: r.attach.text ?? '', position: r.attach.position, ...size,
    get later() { return early.map(({ text, reset, position }) => ({ text, reset, position })); },
    stop: () => { clearTimeout(expiry); off(); },
  });
  return r.session;
}

/** Start a terminal in the background and return its placeholder at once. */
export function beginTerminal(client: Client, envId: string, cwd: string, done: (t: StartingTerminal) => void): StartingTerminal {
  const t: StartingTerminal = { id: `term-${Date.now().toString(36)}-${++seq}`, envId, cwd, state: 'opening', since: Date.now() };
  terminals.set(t.id, t);
  attempt(client, t, done);
  return t;
}

const finishers = new Map<string, (t: StartingTerminal) => void>();

function attempt(client: Client, t: StartingTerminal, done: (t: StartingTerminal) => void) {
  finishers.set(t.id, done);
  t.state = 'opening'; t.error = undefined; t.since = Date.now();
  notify(t);
  openTerminal(client, t.envId, t.cwd).then(
    (session) => {
      t.session = session;
      t.state = 'opened';
      finishers.delete(t.id);
      notify(t);
      done(t);
      terminals.delete(t.id);
    },
    (e) => { t.state = 'failed'; t.error = errorMessage(e); notify(t); },
  );
}

export function retryTerminal(client: Client, id: string) {
  const t = terminals.get(id);
  const done = finishers.get(id);
  if (t?.state === 'failed' && done) attempt(client, t, done);
}

export function forgetTerminal(id: string) {
  terminals.delete(id);
  finishers.delete(id);
}
