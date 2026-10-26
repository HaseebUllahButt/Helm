/** How long counter-only changes to one chat wait to share a frame. */
export const UPDATE_WINDOW_MS = 500;

/**
 * Fields that move many times in a turn and that nobody waits on. A change
 * to only these waits for the chat's window; any other change goes at once.
 */
const QUIET = new Set(['lastSeq', 'seenAt', 'updatedAt', 'context', 'lastUsage', 'costUsd', 'costTotalUsd', 'turns', 'prompts', 'hasInput']);

const same = (a, b) => a === b || (!!a && !!b && typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));

/**
 * The chat updates sent to devices, without the ones that change nothing.
 *
 * Devices merge each update into the chat they hold (useWorkspaceData.js).
 * Most updates the service made changed nothing there: one change was
 * announced by two or three code paths, a restart announced every chat
 * several times, and a busy chat moved its event counter on each event.
 * Each frame still went to every device, and some screens reload on each
 * one. So this keeps what the devices hold, drops an update that changes
 * nothing, sends status and every other real change at once, and lets
 * counter-only changes share one frame per chat per window.
 *
 * An update that names a transition or a question, or that deletes or
 * moves the chat, always goes. A plain update made in the same tick as one
 * of those rides in it instead of going first on its own.
 */
export class SessionUpdates {
  #send;
  #windowMs;
  /** Chat id -> the chat as devices hold it, every frame sent merged in. */
  #shown = new Map();
  /** Chat id -> an update waiting for the chat's window to end. */
  #held = new Map();
  /** Chat id -> an update going out at the end of this tick. */
  #soon = new Map();
  /** Chat id -> the timer of its open window. */
  #windows = new Map();
  #flushing = false;

  constructor({ send, windowMs = UPDATE_WINDOW_MS }) {
    this.#send = send;
    this.#windowMs = windowMs;
  }

  push(payload) {
    const s = payload?.session;
    if (!s?.id) { this.#send(payload); return; }
    const id = s.id;
    const waiting = this.#soon.get(id) ?? this.#held.get(id);
    const next = waiting ? { ...waiting, ...payload, session: { ...waiting.session, ...s, recovery: s.recovery } } : payload;
    const special = !!(next.transition || next.asked || next.session.deleted || next.session.movedTo);
    const changed = this.#changed(id, next.session);
    if (!special && !changed.length) {
      this.#held.delete(id);
      this.#soon.delete(id);
      return;
    }
    if (special || this.#soon.has(id) || !this.#windows.has(id) || changed.some((key) => !QUIET.has(key))) {
      this.#held.delete(id);
      this.#soon.set(id, next);
      this.#flushSoon();
    } else this.#held.set(id, next);
  }

  stop() {
    for (const timer of this.#windows.values()) clearTimeout(timer);
    this.#windows.clear();
    this.#held.clear();
    this.#soon.clear();
  }

  /** Keys whose value the devices do not hold yet. */
  #changed(id, s) {
    const shown = this.#shown.get(id);
    if (!shown) return ['*'];
    const keys = Object.keys(s).filter((key) => key !== 'recovery' && !same(shown[key], s[key]));
    // Devices take `recovery` as sent, even when it is missing.
    if (!same(shown.recovery, s.recovery)) keys.push('recovery');
    return keys;
  }

  #flushSoon() {
    if (this.#flushing) return;
    this.#flushing = true;
    queueMicrotask(() => {
      this.#flushing = false;
      const due = [...this.#soon.values()];
      this.#soon.clear();
      for (const payload of due) this.#deliver(payload);
    });
  }

  #deliver(payload) {
    const id = payload.session.id;
    this.#send(payload);
    if (payload.session.deleted) {
      clearTimeout(this.#windows.get(id));
      this.#windows.delete(id);
      this.#held.delete(id);
      this.#shown.delete(id);
      return;
    }
    this.#shown.set(id, { ...this.#shown.get(id), ...payload.session, recovery: payload.session.recovery });
    clearTimeout(this.#windows.get(id));
    const timer = setTimeout(() => {
      this.#windows.delete(id);
      const held = this.#held.get(id);
      this.#held.delete(id);
      if (held && this.#changed(id, held.session).length) this.#deliver(held);
    }, this.#windowMs);
    timer.unref?.();
    this.#windows.set(id, timer);
  }
}
