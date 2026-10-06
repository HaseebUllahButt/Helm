import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';

/**
 * Terminals helm owns.
 *
 * The alternative, and what this replaces, was to let herdr own every
 * terminal and read its *rendered screen* back on a timer. That cost a full
 * screen read every 120ms, and because a full-screen program repaints rather
 * than appends, the common case was the whole screen crossing the network
 * several times a second. It also meant two emulators in series: herdr's
 * renderer, then xterm in the browser, which would answer control queries
 * (device attributes, cursor position) that were never addressed to it and
 * send those answers back as keystrokes - the junk that appeared at the
 * prompt before anyone had typed.
 *
 * A pty is the thing xterm was built to talk to. Bytes out, bytes in, and a
 * size that can actually change. herdr keeps the panes you start at the
 * keyboard; this is for the terminal inside the app.
 */

/** Output is gathered for this long before being sent, to make one frame of many writes. */
const FLUSH_MS = 16;
/** Output arriving after this long a gap is treated as an echo, not a stream. */
const QUIET_MS = 60;
/** ...unless this much piles up first, so a big paste is not held back. */
const MAX_PENDING = 64 * 1024;
/** What a reconnecting viewer gets replayed. */
const RING_BYTES = 256 * 1024;
/** A viewer renews while it is open; this is how long a vanished one keeps costing. */
const VIEW_TTL_MS = 60_000;

let ptyModule;
let ptyError = null;

/**
 * node-pty is a compiled addon. It ships prebuilt binaries for common Node
 * versions and builds from source otherwise, so on a machine with neither it
 * is simply absent - which must not stop the daemon from running, only from
 * offering its own terminals.
 */
export async function loadPty() {
  if (ptyModule || ptyError) return ptyModule;
  try {
    const m = await import('@homebridge/node-pty-prebuilt-multiarch');
    ptyModule = m.default ?? m;
  } catch (err) {
    ptyError = err;
  }
  return ptyModule;
}

export const ptyUnavailable = () => ptyError && ptyError.message;

export class Terminals extends EventEmitter {
  /** id -> { pty, ring, pending, timer, viewUntil, cols, rows } */
  #live = new Map();

  has(id) { return this.#live.has(id); }

  /** Which terminals are still running - what a reconnecting daemon asks. */
  list() { return [...this.#live.keys()]; }

  async open(id, { cwd, cols = 80, rows = 24, env = {}, shell, cmd, args, exactEnv = false } = {}) {
    if (this.#live.has(id)) return this.#live.get(id);
    const pty = await loadPty();
    if (!pty) throw new Error(`no pty support on this machine: ${ptyError?.message}`);

    const file = cmd || shell || process.env.SHELL || '/bin/bash';
    const child = pty.spawn(file, cmd ? (args ?? []) : ['-l'], {
      name: 'xterm-256color',
      cols, rows,
      cwd: cwd || homedir(),
      env: { ...(exactEnv ? {} : process.env), ...env, TERM: env.TERM || 'xterm-256color' },
    });

    const t = { pty: child, ring: '', pending: '', timer: null, views: new Map(), sizes: new Map(), lead: null, lastOut: 0, lastData: Date.now(), cols, rows };
    this.#live.set(id, t);

    child.onData((chunk) => {
      // The ring is kept whether or not anyone is looking, so that opening the
      // terminal shows what happened while you were away.
      t.ring = trim(t.ring + chunk);
      t.lastData = Date.now();
      if (!this.#viewed(t)) return;
      t.pending += chunk;

      // Coalescing exists for `cat`ing a big file, where sixty frames a
      // second is plenty and one frame per write would flood the channel.
      // It should not apply to the echo of a keystroke: that is one small
      // chunk after a quiet moment, and holding it for up to 16ms to see if
      // a friend shows up is 16ms added to the one number anybody feels.
      //
      // So: the first chunk after a pause goes out now, and only a stream
      // that is genuinely streaming gets batched.
      const now = Date.now();
      const quiet = now - t.lastOut > QUIET_MS;
      t.lastOut = now;
      if (quiet || t.pending.length >= MAX_PENDING) this.#flush(id);
      else if (!t.timer) {
        t.timer = setTimeout(() => this.#flush(id), FLUSH_MS);
        t.timer.unref?.();
      }
    });

    child.onExit(({ exitCode }) => {
      if (t.closed) return; // close() already said so
      this.#flush(id);
      this.#live.delete(id);
      this.emit('exit', { id, code: exitCode });
    });

    return t;
  }

  #viewed(t) {
    const now = Date.now();
    for (const [viewer, until] of t.views) if (until <= now) t.views.delete(viewer);
    return t.views.size > 0;
  }

  #flush(id) {
    const t = this.#live.get(id);
    if (!t) return;
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    if (!t.pending) return;
    const text = t.pending;
    t.pending = '';
    this.emit('data', { id, text });
  }

  /** How long it has drawn nothing, with nobody looking; 0 while watched. */
  unwatchedQuiet(id) {
    const t = this.#live.get(id);
    if (!t || this.#viewed(t)) return 0;
    return Date.now() - t.lastData;
  }

  /** Everything worth drawing, without claiming to be watching it. */
  scrollback(id) {
    const t = this.#live.get(id);
    if (!t) throw new Error('that terminal has ended');
    return t.ring;
  }

  /**
   * Say that somebody is watching, and hand back everything worth drawing.
   * The caller clears its screen and writes this, so a reconnect cannot show
   * the same bytes twice.
   */
  view(id, { cols, rows, viewer = 'legacy', persistent = false } = {}) {
    const ring = this.scrollback(id);
    const t = this.#live.get(id);
    t.views.set(viewer, persistent ? Infinity : Date.now() + VIEW_TTL_MS);
    // Looking does not take the size from somebody already using it: a phone
    // opening the laptop's CLI would otherwise leave the laptop 45 columns wide.
    if (cols && rows) this.resize(id, cols, rows, viewer);
    return ring;
  }

  /** Still watching, nothing to redraw. */
  renew(id, viewer = 'legacy') {
    const t = this.#live.get(id);
    if (!t) throw new Error('that terminal has ended');
    if (t.views.get(viewer) !== Infinity) t.views.set(viewer, Date.now() + VIEW_TTL_MS);
    return { ok: true };
  }

  unview(id, viewer = 'legacy') {
    const t = this.#live.get(id);
    if (!t) return;
    t.views.delete(viewer);
    t.sizes.delete(viewer);
    if (t.lead !== viewer) return;
    // Hand the size to whoever is still looking.
    t.lead = null;
    const [next] = [...t.sizes.keys()].filter((v) => t.views.has(v));
    if (next) this.#lead(t, next);
  }

  /** Typing is what makes a viewer the one the program draws for. */
  write(id, data, viewer = 'legacy') {
    const t = this.#live.get(id);
    if (!t) throw new Error('that terminal has ended');
    if (t.lead !== viewer && t.sizes.has(viewer)) this.#lead(t, viewer);
    t.pty.write(data);
  }

  /**
   * The size the viewer is actually drawing at. Without this the program
   * renders for 80 columns and the phone reflows the result, which is why
   * anything that draws a box used to arrive in pieces.
   */
  resize(id, cols, rows, viewer = 'legacy') {
    const t = this.#live.get(id);
    if (!t || !cols || !rows) return;
    t.sizes.set(viewer, { cols, rows });
    const leading = t.lead && t.lead !== viewer && t.views.has(t.lead) && t.sizes.has(t.lead);
    if (!leading) this.#lead(t, viewer);
  }

  #lead(t, viewer) {
    t.lead = viewer;
    const { cols, rows } = t.sizes.get(viewer);
    if (t.cols === cols && t.rows === rows) return;
    t.cols = cols; t.rows = rows;
    try { t.pty.resize(cols, rows); } catch { /* it exited between the check and here */ }
  }

  close(id) {
    const t = this.#live.get(id);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    this.#live.delete(id);
    // Say it ended now, once: a program that ignores the hangup may take
    // its time, and nobody can reach this terminal any more anyway.
    t.closed = true;
    try { t.pty.kill(); } catch { /* already gone */ }
    this.emit('exit', { id, code: null });
  }

  closeAll() { for (const id of [...this.#live.keys()]) this.close(id); }
}

/**
 * Keep the tail. A hard cut can land inside an escape sequence, so prefer the
 * first line break after the cut - xterm resynchronises either way, but this
 * way the replay usually starts on a clean line.
 */
function trim(s) {
  if (s.length <= RING_BYTES) return s;
  const cut = s.length - RING_BYTES;
  const nl = s.indexOf('\n', cut);
  return s.slice(nl !== -1 && nl - cut < 4096 ? nl + 1 : cut);
}
