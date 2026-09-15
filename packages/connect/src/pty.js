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

  async open(id, { cwd, cols = 80, rows = 24, env = {}, shell } = {}) {
    if (this.#live.has(id)) return this.#live.get(id);
    const pty = await loadPty();
    if (!pty) throw new Error(`no pty support on this machine: ${ptyError?.message}`);

    const file = shell || process.env.SHELL || '/bin/bash';
    const child = pty.spawn(file, ['-l'], {
      name: 'xterm-256color',
      cols, rows,
      cwd: cwd || homedir(),
      env: { ...process.env, ...env, TERM: 'xterm-256color' },
    });

    const t = { pty: child, ring: '', pending: '', timer: null, viewUntil: 0, cols, rows };
    this.#live.set(id, t);

    child.onData((chunk) => {
      // The ring is kept whether or not anyone is looking, so that opening the
      // terminal shows what happened while you were away.
      t.ring = trim(t.ring + chunk);
      if (!this.#viewed(t)) return;
      t.pending += chunk;
      if (t.pending.length >= MAX_PENDING) this.#flush(id);
      else if (!t.timer) {
        t.timer = setTimeout(() => this.#flush(id), FLUSH_MS);
        t.timer.unref?.();
      }
    });

    child.onExit(({ exitCode }) => {
      this.#flush(id);
      this.#live.delete(id);
      this.emit('exit', { id, code: exitCode });
    });

    return t;
  }

  #viewed(t) { return Date.now() < t.viewUntil; }

  #flush(id) {
    const t = this.#live.get(id);
    if (!t) return;
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    if (!t.pending) return;
    const text = t.pending;
    t.pending = '';
    this.emit('data', { id, text });
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
  view(id, { cols, rows } = {}) {
    const ring = this.scrollback(id);
    this.#live.get(id).viewUntil = Date.now() + VIEW_TTL_MS;
    if (cols && rows) this.resize(id, cols, rows);
    return ring;
  }

  /** Still watching, nothing to redraw. */
  renew(id) {
    const t = this.#live.get(id);
    if (!t) throw new Error('that terminal has ended');
    t.viewUntil = Date.now() + VIEW_TTL_MS;
    return { ok: true };
  }

  unview(id) {
    const t = this.#live.get(id);
    if (t) t.viewUntil = 0;
  }

  write(id, data) {
    const t = this.#live.get(id);
    if (!t) throw new Error('that terminal has ended');
    t.pty.write(data);
  }

  /**
   * The size the viewer is actually drawing at. Without this the program
   * renders for 80 columns and the phone reflows the result, which is why
   * anything that draws a box used to arrive in pieces.
   */
  resize(id, cols, rows) {
    const t = this.#live.get(id);
    if (!t) return;
    if (!cols || !rows || (t.cols === cols && t.rows === rows)) return;
    t.cols = cols; t.rows = rows;
    try { t.pty.resize(cols, rows); } catch { /* it exited between the check and here */ }
  }

  close(id) {
    const t = this.#live.get(id);
    if (!t) return;
    if (t.timer) clearTimeout(t.timer);
    this.#live.delete(id);
    try { t.pty.kill(); } catch { /* already gone */ }
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
