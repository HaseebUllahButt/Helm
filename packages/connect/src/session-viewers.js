import { stat } from 'node:fs/promises';
import { getProfiles } from './profiles.js';
import { locate, messages as readMessages } from './transcript.js';
import { ENGINES } from './engines.js';
import { withVisualMessages } from './visual.js';
import { wire } from './session-wire.js';

// A pane read costs the runtime ~90ms, so this is close to as fast as the
// screen can be sampled without the reads piling up on each other.
const WATCH_POLL_MS = 120;
const TRANSCRIPT_POLL_MS = 400;
// Viewers renew while they are open; this is how long a vanished one costs.
const WATCH_TTL_MS = 60_000;

/**
 * Whoever is looking at a session: which views are open, the terminal
 * screen pushed to them, and the CLI's transcript watched for changes.
 */
export class SessionViewers {
  #sessions;
  #core;
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  /** sessionId -> (view identity -> expiry), independent leases per device/tab */
  #watching = new Map();

  /** Say that somebody is looking at this session; pushes flow while renewed. */
  watch(id, watcher = 'legacy') {
    const session = this.#sessions.get(id);
    this.#sessions.watching(id); // expire old views before renewing this one
    const viewers = this.#watching.get(id) ?? new Map();
    viewers.set(watcher, Date.now() + WATCH_TTL_MS);
    this.#watching.set(id, viewers);
    if (session.nativeChat) this.#sessions.nativeTerminals.renew(id).catch(() => {});
    return { ok: true, last: this.#sessions.events.last(id), status: session.status };
  }

  unwatch(id, watcher = 'legacy') {
    const viewers = this.#watching.get(id);
    viewers?.delete(watcher);
    if (!viewers?.size) this.#watching.delete(id);
    return { ok: true };
  }

  watching(id) {
    const viewers = this.#watching.get(id);
    if (!viewers) return false;
    const now = Date.now();
    for (const [watcher, until] of viewers) if (now > until) viewers.delete(watcher);
    if (!viewers.size) this.#watching.delete(id);
    return viewers.size > 0;
  }

  /**
   * The session as a conversation.
   *
   * Falls back to nothing rather than to terminal text: a caller that wants
   * the raw screen asks for it explicitly, and silently returning scrollback
   * here would make the chat view lie about what it is showing.
   */
  async messages(id, { limit = 120 } = {}) {
    const s = this.#sessions.get(id);
    if (s.driver) return { messages: [], source: 'events' };
    // A launched native process must be linked by process identity, never
    // by the newest file in a folder where several CLIs may be running.
    if (s.nativeCli && !s.transcript) return { messages: withVisualMessages([], this.#sessions.events.tail(id, 0)), status: s.status, source: null };
    if (!s.transcript) {
      const profiles = await getProfiles();
      const profile = profiles.find((p) => p.id === s.profileId);
      const engine = ENGINES[s.engine];
      if (!engine || engine.plain) return { messages: [], source: null };

      // A session helm started knows its account. One it adopted from the
      // keyboard does not - `claudeaa` in a pane looks the same as `claude` -
      // so try every account home this engine has here and take the newest
      // transcript that matches the directory.
      const homes = profile
        ? [profile.env?.[engine.homeEnv] ?? engine.defaultHome]
        : [...new Set([
            engine.defaultHome,
            ...profiles.filter((p) => p.engine === s.engine).map((p) => p.env?.[engine.homeEnv]).filter(Boolean),
          ])];
      let best = null;
      for (const home of homes) {
        const path = await locate({ engine: s.engine, home, cwd: s.cwd, startedAt: s.createdAt ?? 0 });
        if (!path) continue;
        const mtime = await stat(path).then((st) => st.mtimeMs).catch(() => 0);
        if (!best || mtime > best.mtime) best = { path, mtime };
      }
      s.transcript = best?.path ?? null;
      if (s.transcript && this.#core.index.has(id)) this.#core.save();
    }
    // Asking for messages is how a chat view says it is watching.
    this.watchTranscript(id, s.transcript);
    const messages = await readMessages({ engine: s.engine, path: s.transcript, sessionId: s.engineSessionId, limit });
    if (s.nativeChat) {
      const images = new Map(this.#sessions.events.tail(id, 0).filter(event => event.type === 'native.images')
        .map(event => [event.prompt, event]));
      for (const message of messages) {
        const saved = message.role === 'user' && images.get(message.text);
        if (!saved) continue;
        message.text = saved.text;
        message.attachments = saved.attachments.map(image => ({ ...image, data: this.#sessions.events.attachment(id, image.ref) }));
      }
    }
    return {
      messages: withVisualMessages(messages, this.#sessions.events.tail(id, 0)),
      status: s.status,
      source: s.transcript,
    };
  }

  async read(id, { lines = 200, source = 'recent', ansi = false } = {}) {
    const s = this.#sessions.get(id);
    if (s.driver) throw new Error('a headless session has no terminal');
    if (s.pty) return { text: await this.#core.terminal(s).view(id), session: wire(s) };
    const res = await this.#sessions.runtime.read(this.#core.handle(s), { lines, source, ansi });
    return { text: res.text, session: s };
  }

  // ------------------------------------------------------------- streaming

  /** id -> { timer, last, expires, lines, ansi } for terminals being watched */
  #watchers = new Map();
  /** id -> { expires, path, poll } for transcripts being watched */
  #transcripts = new Map();

  /**
   * Start pushing a session's screen to whoever is looking at it.
   *
   * The runtime hands back rendered text, not a byte stream, and it does not
   * tell us when a pane's output changes - so somebody has to poll it. Doing
   * that here, next to the runtime's own socket, costs one local read; doing
   * it from the phone (which is what used to happen) cost the same read plus
   * two trips through the hub every time, which on a distant VM is most of a
   * second per redraw. Only the difference travels, and only when there is one.
   *
   * A watch lives as long as viewers keep renewing it; a phone that vanishes
   * mid-session stops costing anything within a minute.
   */
  async attach(id, { lines = 400, ansi = true, cols, rows, renew = false, watcher = 'legacy' } = {}) {
    const s = this.#sessions.get(id);
    if (s.driver) throw new Error('a headless session has no terminal');
    // helm's own terminal needs no polling: the pty pushes as it writes. The
    // reply is everything worth drawing, and the viewer replaces its screen
    // with it, so a reconnect cannot paint the same bytes twice - which is
    // also why a renewal deliberately returns nothing to draw.
    if (s.pty) {
      this.#sessions.watch(id, watcher);
      const text = renew
        ? (await this.#core.terminal(s).renew(id), null)
        : await this.#core.terminal(s).view(id, { cols, rows });
      return { text, pty: true, session: wire(s) };
    }
    const existing = this.#watchers.get(id);
    if (existing) {
      existing.expires = Date.now() + WATCH_TTL_MS;
      const res = await this.#sessions.runtime.read(this.#core.handle(s), { lines, source: 'recent', ansi });
      existing.last = res.text ?? '';
      return { text: existing.last, session: s };
    }

    const w = { last: '', expires: Date.now() + WATCH_TTL_MS, lines, ansi, busy: false, timer: null };
    this.#watchers.set(id, w);
    const res = await this.#sessions.runtime.read(this.#core.handle(s), { lines, source: 'recent', ansi });
    w.last = res.text ?? '';

    const tick = async () => {
      if (!this.#watchers.has(id)) return;
      if (Date.now() > w.expires) { this.#sessions.detach(id); return; }
      if (!w.busy) {
        w.busy = true;
        try {
          const r = await this.#sessions.runtime.read(this.#core.handle(s), { lines, source: 'recent', ansi });
          const text = r.text ?? '';
          if (text !== w.last) {
            const delta = text.startsWith(w.last)
              ? { id, text: text.slice(w.last.length), reset: false }
              : { id, text, reset: true };
            w.last = text;
            this.#sessions.emit('data', delta);
          }
        } catch { /* pane may have gone away; the next tick or expiry handles it */ }
        w.busy = false;
      }
      w.timer = setTimeout(tick, WATCH_POLL_MS);
      w.timer.unref?.();
    };
    w.timer = setTimeout(tick, WATCH_POLL_MS);
    w.timer.unref?.();
    return { text: w.last, session: s };
  }

  detach(id, watcher = 'legacy') {
    this.#sessions.unwatch(id, watcher);
    if (!this.#sessions.watching(id)) this.#core.terminal(this.#core.index.get(id) ?? {}).unview(id);
    const w = this.#watchers.get(id);
    if (!w) return { ok: true };
    clearTimeout(w.timer);
    this.#watchers.delete(id);
    return { ok: true };
  }

  /**
   * Tell chat views when the transcript grows, so they re-read it at once
   * instead of on their next poll. Polls the file's size: cheap, and it works
   * on every filesystem, which fs.watch does not.
   */
  watchTranscript(id, path) {
    if (!path) return;
    const existing = this.#transcripts.get(id);
    if (existing) {
      existing.expires = Date.now() + WATCH_TTL_MS;
      if (existing.path === path) return;
      clearInterval(existing.poll);
      this.#transcripts.delete(id);
    }
    const t = { path, expires: Date.now() + WATCH_TTL_MS, size: -1, poll: null, busy: false, rest: 0 };
    t.poll = setInterval(async () => {
      if (Date.now() > t.expires) {
        clearInterval(t.poll);
        this.#transcripts.delete(id);
        return;
      }
      // One tick at a time, and a slow import earns a rest: re-reading a
      // 64MB transcript is ~0.7s of CPU, and a CLI writing to it changes it
      // every tick - unguarded that was a core spent for as long as it ran.
      // Resting 3x the import caps it near a quarter of one.
      if (t.busy || Date.now() < t.rest) return;
      t.busy = true;
      try {
        const { size, mtimeMs } = await stat(path);
        // SQLite writes live updates to a WAL while another CLI is open.
        // Watching only the main database makes OpenCode/Devin appear frozen
        // until their process checkpoints or exits.
        const wal = await stat(`${path}-wal`).catch(() => null);
        const stamp = `${size}:${mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
        if (t.size !== -1 && stamp !== t.size) {
          this.#sessions.emit('transcript', { id });
          // A Task call lands here first; pick its subagent up at once.
          const session = this.#core.index.get(id);
          if (session) void this.#core.subagents.refreshNative(session);
        }
        if (t.size !== -1 && stamp !== t.size) {
          const session = this.#core.index.get(id);
          if (session?.external && session.driver) {
            const began = Date.now();
            await this.#core.importExternalTranscript(session);
            const took = Date.now() - began;
            if (took > TRANSCRIPT_POLL_MS / 2) t.rest = Date.now() + took * 3;
          }
        }
        const monitored = this.#core.index.get(id);
        if (monitored?.external) await this.#core.refreshExternalActivity(monitored);
        t.size = stamp;
      } catch { /* transcript not written yet */ } finally { t.busy = false; }
    }, TRANSCRIPT_POLL_MS);
    t.poll.unref?.();
    this.#transcripts.set(id, t);
  }
}
