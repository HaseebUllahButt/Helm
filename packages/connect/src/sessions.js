import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HELM_DIR, expand } from './paths.js';
import { getProfiles, materialize } from './profiles.js';
import { locate, messages as readMessages } from './transcript.js';
import { ENGINES } from './engines.js';
import { optionArgs, supportsImages } from './models.js';
import { available as usageAvailable, usage as fetchUsage } from './usage.js';
import { EventLog } from './events.js';
import { ClaudeDriver } from './drivers/claude.js';
import { CodexDriver } from './drivers/codex.js';
import { OpencodeDriver } from './drivers/opencode.js';
import { DevinDriver } from './drivers/devin.js';
import { defaultMode, modeFromAuto } from './modes.js';
import { TerminalHost } from './terminals.js';

const INDEX_FILE = join(HELM_DIR, 'sessions.json');

// A pane read costs the runtime ~90ms, so this is close to as fast as the
// screen can be sampled without the reads piling up on each other.
const WATCH_POLL_MS = 120;
const TRANSCRIPT_POLL_MS = 400;
// Viewers renew while they are open; this is how long a vanished one costs.
const WATCH_TTL_MS = 60_000;
// A headless agent that has been idle this long is closed; the next message
// resumes the same conversation, so nothing is lost but the warm process.
const IDLE_REAP_MS = 30 * 60_000;

const DRIVERS = { claude: ClaudeDriver, codex: CodexDriver, opencode: OpencodeDriver, devin: DevinDriver };

/**
 * The quick keys above the phone keyboard, as the bytes a terminal expects.
 * herdr takes these by name; a pty takes what a keyboard would have sent.
 */
const NAMED_KEYS = {
  Enter: '\r', Escape: '\x1b', Tab: '\t', Backspace: '\x7f', Space: ' ',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D',
  Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
};

const KEY_BYTES = (key) => {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  const ctrl = /^C-([a-z@[\]\\^_])$/i.exec(key);
  if (ctrl) return String.fromCharCode(ctrl[1].toLowerCase().charCodeAt(0) & 0x1f);
  return key;
};

/** herdr requires agent names to match [a-z][a-z0-9_-]{0,31} and be unique. */
const agentName = (profileId) =>
  (profileId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z]+/, 'a') +
    '-' + randomBytes(2).toString('hex')).slice(0, 32);

/**
 * helm's view of sessions.
 *
 * Two kinds live here. Agent sessions are driven headless (`drivers/`):
 * helm owns the process, and what the agent does arrives as a stream of
 * events kept in `EventLog`. Terminal sessions, and agents someone started
 * at the keyboard, are herdr panes: herdr owns those processes and this
 * class only maps a helm session to the workspace/pane behind it, so that a
 * daemon restart reconnects to work that never stopped running.
 */
export class Sessions extends EventEmitter {
  #index = new Map();
  /** paneId -> what the runtime last told us about a pane we do not own */
  #adopted = new Map();
  /** sessionId -> live driver */
  #drivers = new Map();
  /** sessionId -> reap timer */
  #reapers = new Map();
  /** sessionId -> expiry, for event pushes somebody is looking at */
  #watching = new Map();

  constructor(runtime, { events = new EventLog(), makeDriver = null, log = () => {}, terminals = new TerminalHost() } = {}) {
    super();
    this.runtime = runtime;
    this.events = events;
    this.log = log;
    this.makeDriver = makeDriver ?? ((engine, opts) => new DRIVERS[engine](opts));
    this.terminals = terminals;
    this.#load();
    runtime.on('status', (e) => this.#onStatus(e));
    runtime.on('closed', (e) => this.#onClosed(e));
    // A pty's bytes go out on the same event a watched pane's text does, so
    // the client has one thing to listen to.
    this.terminals.on('data', (d) => this.emit('data', d));
    this.terminals.on('exit', ({ id, code }) => {
      const s = this.#index.get(id);
      if (!s) return;
      this.emit('exit', { id, code });
      this.emit('session', { ...s, status: 'exited', alive: false });
    });
  }

  isDriven(s) { return !!s?.driver; }

  /**
   * What a terminal on this machine will be: helm's own pty, or the slow
   * herdr-pane fallback. Answerable with no host running - which is the usual
   * case, since one only starts when a terminal is opened.
   */
  async terminalBackend() {
    if (this.terminals.usable) return 'pty';
    const { loadPty } = await import('./pty.js');
    return (await loadPty()) ? 'pty' : 'panes';
  }

  /** The runtime handle for a stored session record. */
  #handle(s) {
    return {
      paneId: s.paneId,
      workspaceId: s.workspaceId,
      tabId: s.tabId,
      agentName: s.agentName,
    };
  }

  // ------------------------------------------------------------- persistence

  #load() {
    if (!existsSync(INDEX_FILE)) return;
    try {
      const raw = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
      for (const s of raw.sessions || []) this.#index.set(s.id, s);
    } catch { /* a corrupt index must not stop the daemon booting */ }
  }

  #save() {
    mkdirSync(HELM_DIR, { recursive: true });
    writeFileSync(
      INDEX_FILE,
      JSON.stringify({ version: 1, sessions: [...this.#index.values()] }, null, 2),
      { mode: 0o600 }
    );
  }

  // ------------------------------------------------------------------ events

  #onStatus({ paneId, status }) {
    if (!status) return;
    const session = this.#byPane(paneId);
    if (!session) {
      // A pane we do not own changed state; still worth telling the phone,
      // especially when it just became blocked.
      const pane = this.#adopted.get(paneId);
      if (pane && pane.status !== status) {
        pane.status = status;
        this.emit('status', { session: this.get(`pane:${paneId}`), from: null, to: status });
      }
      return;
    }
    // A plain shell has no agent, so herdr classifies it as 'unknown'. That is
    // not a state worth showing - `list()` already reports a live shell as
    // 'shell' - so ignore agent-status updates for one entirely.
    if (session.engine === 'shell') return;

    const previous = session.status;
    // `pane_updated` repeats the current status on unrelated changes; only a
    // real transition is worth writing to disk and waking every client for.
    if (status === previous) return;
    session.status = status;
    session.updatedAt = Date.now();
    this.#save();
    this.emit('session', session);

    // `blocked` is the one the phone cares about: the agent has stopped and
    // is waiting on a human.
    this.emit('status', { session, from: previous, to: status });
    this.#digest(session).catch(() => {});
  }

  #onClosed({ paneId, workspaceId }) {
    // Closing a workspace reports only the workspace id, not its panes.
    const session = paneId
      ? this.#byPane(paneId)
      : this.#byWorkspace(workspaceId);
    if (!session || session.status === 'exited') return;
    session.status = 'exited';
    session.exitedAt = Date.now();
    this.#save();
    this.emit('session', session);
    this.#digest(session).catch(() => {});
  }

  #byPane(paneId) {
    if (!paneId) return null;
    for (const s of this.#index.values()) if (s.paneId === paneId) return s;
    return null;
  }

  #byWorkspace(workspaceId) {
    if (!workspaceId) return null;
    for (const s of this.#index.values()) if (s.workspaceId === workspaceId) return s;
    return null;
  }

  /**
   * A rolling summary of what this session is doing, built from the pane's own
   * output. This is what the cross-environment brain reads; it costs nothing
   * because herdr already holds the scrollback.
   */
  async #digest(session) {
    let tail = '';
    try {
      const read = await this.runtime.read(this.#handle(session), { lines: 40 });
      tail = (read.text ?? '').trim();
    } catch { /* pane may have gone away mid-read */ }

    const lines = tail.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    this.emit('digest', {
      sessionId: session.id,
      cwd: session.cwd,
      engine: session.engine,
      summary: lines.slice(-12).join('\n').slice(0, 4000),
      state: {
        status: session.status,
        profileId: session.profileId,
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
  }

  // ------------------------------------------------------------------- verbs

  async list() {
    // The runtime is the authority on what is still alive; our index only
    // remembers which of those panes are ours.
    const live = await this.runtime.listLive();

    const out = [];
    const ours = new Set([...this.#index.values()].map((s) => s.paneId));

    // Anything running that helm did not start is still yours, so show it.
    this.#adopted.clear();
    for (const [paneId, pane] of live) {
      if (ours.has(paneId)) continue;
      this.#adopted.set(paneId, pane);
      this.runtime.watch({ paneId });
      out.push({
        id: `pane:${paneId}`,
        paneId,
        workspaceId: pane.workspaceId,
        tabId: pane.tabId,
        agentName: pane.agentName,
        engine: pane.engine ?? 'shell',
        profileId: null,
        cwd: pane.cwd,
        title: pane.agentName ?? pane.title ?? paneId,
        status: pane.engine ? (pane.status ?? 'unknown') : 'shell',
        alive: true,
        adopted: true,
        updatedAt: Date.now(),
      });
    }

    for (const s of this.#index.values()) {
      if (s.driver) {
        out.push({ ...s, archived: !!s.archived, alive: this.#drivers.has(s.id), adopted: false, pending: this.events.pending(s.id).length });
        continue;
      }
      if (s.pty) {
        const alive = this.terminals.has(s.id);
        out.push({ ...s, alive, status: alive ? 'shell' : 'exited', adopted: false });
        continue;
      }
      const pane = live.get(s.paneId);
      // herdr is the authority on what is still running, so no pane means the
      // process is gone - whatever the session was last seen doing. Keeping
      // the remembered status here is how a machine that rebooted mid-turn
      // ended up showing "needs you" for a session nobody could answer.
      // A plain shell has no agent for the runtime to classify, so its status
      // would always read 'unknown'. Say what it actually is.
      const status = !pane ? 'exited'
        : s.engine === 'shell' ? 'shell'
        : (pane.status ?? s.status ?? 'unknown');
      out.push({ ...s, archived: !!s.archived, alive: !!pane, status, cwd: pane?.cwd ?? s.cwd, adopted: false });
    }
    // Anything waiting on a human floats to the top; that is the whole point
    // of watching from a phone.
    const rank = (x) => (x.status === 'blocked' ? 0 : x.status === 'working' ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async start({ cwd, profileId, title, model, auto, effort, mode }) {
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`unknown profile: ${profileId}`);
    if (ENGINES[profile.engine]?.driver) return this.#startDriven({ cwd, profile, title, model, effort, mode, auto });

    const spec = materialize(profile);
    // What was chosen in the app, in the CLI's own words. An explicit choice
    // goes after the alias's own arguments so it wins if the two disagree.
    spec.args = [...spec.args, ...optionArgs(profile.engine, { model, auto, effort })];
    const dir = expand(cwd);

    // A plain shell is a terminal, and helm can run one itself - far better
    // than borrowing a herdr pane and reading its screen back. Where the pty
    // addon is missing the old path still works, slowly.
    if (spec.plain && await this.terminals.ensure()) {
      return this.#startTerminal({ dir, profileId, title, env: spec.env });
    }

    const handle = await this.runtime.createSession({
      cwd: dir,
      env: spec.env,
      label: title || `${profile.label} · ${dir.split('/').pop()}`,
    });

    const session = {
      id: randomBytes(6).toString('hex'),
      workspaceId: handle.workspaceId,
      paneId: handle.paneId,
      tabId: handle.tabId,
      profileId,
      engine: profile.engine,
      model: model || null,
      auto: !!auto,
      cwd: dir,
      title: title || `${dir.split('/').pop() || dir}`,
      status: 'starting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (spec.plain) {
      // A plain shell pane is already the thing we wanted; nothing to start.
      session.status = 'idle';
    } else {
      const { agentName: name } = await this.runtime.startAgent(handle, {
        kind: spec.kind, args: spec.args, name: agentName(profileId),
      });
      session.agentName = name;
      handle.agentName = name;
      session.status = 'working';
    }

    this.#index.set(session.id, session);
    this.#save();
    this.runtime.watch(handle);
    this.emit('session', session);
    return session;
  }

  // ---------------------------------------------------------------- terminals

  /**
   * A terminal helm owns. Unlike a herdr pane it does not outlive the daemon:
   * the shell is our child, so a restart ends it. `list()` reports that
   * honestly as `exited` and the app offers a new one, which is better than
   * reconnecting you to something that is no longer there.
   */
  async #startTerminal({ dir, profileId, title, env }) {
    const session = {
      id: randomBytes(6).toString('hex'),
      pty: true,
      profileId,
      engine: 'shell',
      cwd: dir,
      title: title || `${dir.split('/').pop() || dir}`,
      status: 'shell',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.terminals.open(session.id, { cwd: dir, env });
    this.#index.set(session.id, session);
    this.#save();
    this.emit('session', session);
    return session;
  }

  // ---------------------------------------------------------- headless agents

  async #startDriven({ cwd, profile, title, model, effort, mode, auto }) {
    const dir = expand(cwd);
    const session = {
      id: randomBytes(6).toString('hex'),
      driver: profile.engine,
      profileId: profile.id,
      engine: profile.engine,
      model: model || null,
      effort: effort || null,
      mode: mode || (auto != null ? modeFromAuto(profile.engine, auto) : defaultMode(profile.engine)),
      cwd: dir,
      title: title || `${dir.split('/').pop() || dir}`,
      status: 'idle',
      engineSessionId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#index.set(session.id, session);
    const driver = await this.#driver(session);
    await driver.start();
    session.engineSessionId = driver.engineSessionId;
    this.#save();
    this.emit('session', session);
    return session;
  }

  /** The live driver for a session, starting (or resuming) one if needed. */
  async #driver(s) {
    let d = this.#drivers.get(s.id);
    if (d) return d;
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === s.profileId);
    if (!profile) throw new Error(`the account for this session (${s.profileId}) is gone`);
    const spec = materialize(profile);
    d = this.makeDriver(s.driver, {
      cmd: spec.cmd, env: spec.env, args: spec.args, cwd: s.cwd,
      model: s.model, effort: s.effort, mode: s.mode, speed: s.speed,
      engineSessionId: s.engineSessionId,
      log: (m) => this.log(`[${s.id}] ${m}`),
    });
    this.#drivers.set(s.id, d);
    d.on('event', (e) => this.#onDriverEvent(s, d, e));
    // Both CLIs announce what they actually started with. Keep it: when the
    // owner has not picked a model, this is the only way to say which one is
    // running instead of showing the word "model". It is reported, not
    // chosen, so it stays separate from `model` and never becomes an
    // argument on the next launch.
    d.on('init', (info) => {
      if (!info) return;
      const model = info.model ?? null;
      const effort = info.effort ?? null;
      if (model === s.engineModel && effort === s.engineEffort) return;
      s.engineModel = model;
      s.engineEffort = effort;
      if (this.#index.has(s.id)) this.#save();
      this.emit('session', s);
    });
    return d;
  }

  #onDriverEvent(s, d, e) {
    if (this.#drivers.get(s.id) !== d && e.type !== 'status') return;
    if (e.type === 'status') {
      // A closed process is not a closed conversation: the next message
      // resumes it. Only an explicit kill removes the session.
      const status = e.status === 'exited' ? 'idle' : e.status;
      if (e.status === 'exited' && this.#drivers.get(s.id) === d) this.#drivers.delete(s.id);
      this.#reap(s, status);
      if (status !== s.status && this.#index.has(s.id)) {
        const previous = s.status;
        s.status = status;
        s.updatedAt = Date.now();
        this.#save();
        this.emit('session', s);
        this.emit('status', { session: s, from: previous, to: status });
      }
      if (e.status === 'exited') return;
    }
    if (d.engineSessionId && d.engineSessionId !== s.engineSessionId) {
      s.engineSessionId = d.engineSessionId;
      this.#save();
    }
    const event = this.events.append(s.id, e);
    s.lastSeq = event.seq;
    this.emit('event', { id: s.id, event });
  }

  /** Close a driver that has been idle for a long while; keep the session. */
  #reap(s, status) {
    clearTimeout(this.#reapers.get(s.id));
    this.#reapers.delete(s.id);
    if (status !== 'idle') return;
    const t = setTimeout(() => {
      const d = this.#drivers.get(s.id);
      if (d && d.status === 'idle') d.kill().catch(() => {});
    }, IDLE_REAP_MS);
    t.unref?.();
    this.#reapers.set(s.id, t);
  }

  /**
   * Events after `since`, plus what is still waiting on a person.
   *
   * Capped per call: an old chat holds up to 2000 events and a single reply
   * that large is megabytes - enough to exceed the WebRTC data-channel limit
   * even fragmented (and slow over the relay too). Callers page with
   * `since` until `hasMore` is false; each page's last `seq` is the next
   * `since`.
   */
  history(id, { since = 0, limit = 500 } = {}) {
    const s = this.get(id);
    const capped = Math.max(1, Math.min(Number(limit) || 500, 1000));
    const all = this.events.since(s.id, since);
    const events = all.slice(0, capped);
    return { events, pending: this.events.pending(s.id), last: this.events.last(s.id), session: s, hasMore: all.length > events.length };
  }

  /** Say that somebody is looking at this session; pushes flow while renewed. */
  watch(id) {
    this.get(id);
    this.#watching.set(id, Date.now() + WATCH_TTL_MS);
    return { ok: true, last: this.events.last(id) };
  }

  unwatch(id) { this.#watching.delete(id); return { ok: true }; }

  watching(id) {
    const until = this.#watching.get(id);
    if (!until) return false;
    if (Date.now() > until) { this.#watching.delete(id); return false; }
    return true;
  }

  async answer(id, requestId, decision) {
    const d = this.#drivers.get(id);
    if (!d) throw new Error('the agent is not running; that prompt is gone');
    await d.answer(requestId, decision);
    return { ok: true };
  }

  async interrupt(id) {
    const d = this.#drivers.get(id);
    if (d) await d.interrupt();
    return { ok: true };
  }

  async setMode(id, mode) {
    const s = this.get(id);
    if (!s.driver) throw new Error('not a headless session');
    s.mode = mode;
    this.#save();
    const d = this.#drivers.get(id);
    if (d) await d.setMode(mode);
    this.emit('session', s);
    return { ok: true, session: s };
  }

  async setEffort(id, effort) {
    const s = this.get(id);
    if (!s.driver) throw new Error('not a headless session');
    s.effort = effort || null;
    this.#save();
    const d = this.#drivers.get(id);
    if (d) await d.setEffort(s.effort);
    this.emit('session', s);
    return { ok: true, session: s };
  }

  async setSpeed(id, speed) {
    const s = this.get(id);
    if (!s.driver) throw new Error('not a headless session');
    s.speed = speed || null;
    this.#save();
    const d = this.#drivers.get(id);
    if (d?.setSpeed) await d.setSpeed(s.speed);
    this.emit('session', s);
    return { ok: true, session: s };
  }

  /**
   * The pickers a running agent advertised, when the driver is live. ACP
   * agents report their model list - with real names - at session start,
   * which beats anything a CLI subcommand can print. Null when the driver
   * is not up or reports nothing.
   */
  catalog(id) {
    const d = this.#drivers.get(id);
    return d?.catalog?.() ?? null;
  }

  async setModel(id, model) {
    const s = this.get(id);
    if (!s.driver) throw new Error('not a headless session');
    s.model = model || null;
    this.#save();
    const d = this.#drivers.get(id);
    if (d) await d.setModel(s.model);
    this.emit('session', s);
    return { ok: true, session: s };
  }

  /**
   * A session record for an id.
   *
   * Ids prefixed `pane:` refer to work helm did not start - an agent you
   * launched at the keyboard. They have no stored record, so we build one from
   * the pane id itself. This is what lets the phone act as a view onto
   * everything running on the machine, not just what it started.
   */
  get(id) {
    if (id.startsWith('pane:')) {
      const paneId = id.slice(5);
      const adopted = this.#adopted.get(paneId);
      return {
        id, paneId,
        workspaceId: adopted?.workspaceId ?? paneId.split(':')[0],
        tabId: adopted?.tabId,
        agentName: adopted?.agentName,
        engine: adopted?.engine ?? 'unknown',
        cwd: adopted?.cwd ?? '~',
        title: adopted?.title ?? paneId,
        adopted: true,
      };
    }
    const s = this.#index.get(id);
    if (!s) throw new Error(`unknown session: ${id}`);
    return s;
  }

  /**
   * The session as a conversation.
   *
   * Falls back to nothing rather than to terminal text: a caller that wants
   * the raw screen asks for it explicitly, and silently returning scrollback
   * here would make the chat view lie about what it is showing.
   */
  async messages(id, { limit = 120 } = {}) {
    const s = this.get(id);
    if (s.driver) return { messages: [], source: 'events' };
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
      if (s.transcript && this.#index.has(id)) this.#save();
    }
    // Asking for messages is how a chat view says it is watching.
    this.#watchTranscript(id, s.transcript);
    return {
      messages: await readMessages({
        engine: s.engine, path: s.transcript, sessionId: s.engineSessionId, limit,
      }),
      source: s.transcript,
    };
  }

  async read(id, { lines = 200, source = 'recent', ansi = false } = {}) {
    const s = this.get(id);
    if (s.driver) throw new Error('a headless session has no terminal');
    const res = await this.runtime.read(this.#handle(s), { lines, source, ansi });
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
  async attach(id, { lines = 400, ansi = true, cols, rows, renew = false } = {}) {
    const s = this.get(id);
    if (s.driver) throw new Error('a headless session has no terminal');
    // helm's own terminal needs no polling: the pty pushes as it writes. The
    // reply is everything worth drawing, and the viewer replaces its screen
    // with it, so a reconnect cannot paint the same bytes twice - which is
    // also why a renewal deliberately returns nothing to draw.
    if (s.pty) {
      const text = renew
        ? (await this.terminals.renew(id), null)
        : await this.terminals.view(id, { cols, rows });
      return { text, pty: true, session: s };
    }
    const existing = this.#watchers.get(id);
    if (existing) {
      existing.expires = Date.now() + WATCH_TTL_MS;
      const res = await this.runtime.read(this.#handle(s), { lines, source: 'recent', ansi });
      existing.last = res.text ?? '';
      return { text: existing.last, session: s };
    }

    const w = { last: '', expires: Date.now() + WATCH_TTL_MS, lines, ansi, busy: false, timer: null };
    this.#watchers.set(id, w);
    const res = await this.runtime.read(this.#handle(s), { lines, source: 'recent', ansi });
    w.last = res.text ?? '';

    const tick = async () => {
      if (!this.#watchers.has(id)) return;
      if (Date.now() > w.expires) { this.detach(id); return; }
      if (!w.busy) {
        w.busy = true;
        try {
          const r = await this.runtime.read(this.#handle(s), { lines, source: 'recent', ansi });
          const text = r.text ?? '';
          if (text !== w.last) {
            const delta = text.startsWith(w.last)
              ? { id, text: text.slice(w.last.length), reset: false }
              : { id, text, reset: true };
            w.last = text;
            this.emit('data', delta);
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

  detach(id) {
    this.terminals.unview(id);
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
  #watchTranscript(id, path) {
    if (!path) return;
    const existing = this.#transcripts.get(id);
    if (existing) {
      existing.expires = Date.now() + WATCH_TTL_MS;
      if (existing.path === path) return;
      clearInterval(existing.poll);
      this.#transcripts.delete(id);
    }
    const t = { path, expires: Date.now() + WATCH_TTL_MS, size: -1, poll: null };
    t.poll = setInterval(async () => {
      if (Date.now() > t.expires) {
        clearInterval(t.poll);
        this.#transcripts.delete(id);
        return;
      }
      try {
        const { size, mtimeMs } = await stat(path);
        const stamp = `${size}:${mtimeMs}`;
        if (t.size !== -1 && stamp !== t.size) this.emit('transcript', { id });
        t.size = stamp;
      } catch { /* transcript not written yet */ }
    }, TRANSCRIPT_POLL_MS);
    t.poll.unref?.();
    this.#transcripts.set(id, t);
  }

  /**
   * Send a prompt to the agent, or raw text to the terminal.
   *
   * `raw` matters: from the terminal view every keystroke - arrows, ctrl-c,
   * a bare newline - has to reach the pane untouched, whereas the chat view
   * wants a whole message handed to the agent as a prompt.
   */
  async input(id, text, { raw = false, attachments = [] } = {}) {
    const s = this.get(id);
    if (s.driver) {
      const clean = text.replace(/\n$/, '');
      // Slash commands are helm's, not the agent's: intercept before the
      // text reaches a CLI that would read them as words in a prompt.
      if (!raw) {
        const slash = /^\/(compact|usage)(?:\s+(.*?))?\s*$/s.exec(text.trim());
        if (slash) return this.#slash(s, slash[1], (slash[2] ?? '').trim());
      }
      // Emit optimistically so every watcher (desktop + mobile PWA) sees the
      // image immediately, even before the agent echoes it back.
      if (attachments?.length) {
        const d0 = this.#drivers.get(id);
        const turnId = d0?.nextTurnId?.() ?? `local-${Date.now()}`;
        this.events.append(id, { type: 'turn.start', turnId, text: clean, attachments: attachments.map((a) => ({ filename: a.filename, mime: a.mime, data: a.data?.slice(0, 80) + '…' })) });
        // full images live in the turn for rendering; truncate in log above is just for debugging
        const last = this.events.since(id, 0).at(-1);
        if (last) last.attachmentsFull = attachments;
      }
      const d = await this.#driver(s);
      // Only a driver that implements the verb AND a model that can see
      // images gets the bytes; anything else gets a filename placeholder
      // in the text, which is always safe while lost bytes are not.
      if (attachments?.length && typeof d.sendWithAttachments === 'function' && supportsImages(s.driver, s.model)) {
        await d.sendWithAttachments(clean, attachments);
      } else {
        let msg = clean;
        if (attachments?.length) {
          const imgs = attachments.map((a) => a.url || a.dataUrl || `[image: ${a.filename || 'image'}]`).join('\n');
          msg = msg ? `${msg}\n${imgs}` : imgs;
        }
        await d.send(msg);
      }
      return { ok: true };
    }
    if (s.pty) { await this.terminals.write(id, text); return { ok: true }; }
    const handle = this.#handle(s);
    return s.agentName && !raw
      ? this.runtime.sendPrompt(handle, text)
      : this.runtime.sendText(handle, text);
  }

  /**
   * `/compact [hint]` summarises the conversation into a fresh context;
   * `/usage` reports what this session burned plus plan usage when the
   * local usage dashboard is running. Both render as ordinary turns so
   * every watcher sees them, and neither is sent to the agent as a prompt.
   */
  async #slash(s, cmd, arg) {
    const turnId = `local-${Date.now().toString(36)}`;
    const text = `/${cmd}${arg ? ` ${arg}` : ''}`;
    if (cmd === 'compact') {
      this.#emitLocal(s, turnId, text);
      const d = await this.#driver(s);
      await d.compact(arg);
      return { ok: true };
    }
    const lines = [];
    let turns = 0, input = 0, output = 0, cost = 0;
    for (const e of this.events.since(s.id, 0)) {
      if (e?.type !== 'turn.done') continue;
      turns++;
      input += e.usage?.input ?? 0;
      output += e.usage?.output ?? 0;
      cost += e.costUsd ?? 0;
    }
    const usd = (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : (v ?? '—'));
    lines.push(`${turns} turns this session · ${(input / 1000).toFixed(1)}k tokens in / ${(output / 1000).toFixed(1)}k out${cost ? ` · ${usd(cost)}` : ''}`);
    try {
      if (await usageAvailable()) {
        const u = await fetchUsage();
        for (const a of u?.accounts ?? []) {
          const bits = [`today ${usd(a.today)}`, `month ${usd(a.month)}`];
          if (a.rateLimits) bits.push(`limits ${typeof a.rateLimits === 'string' ? a.rateLimits : JSON.stringify(a.rateLimits).slice(0, 120)}`);
          lines.push(`${a.label ?? a.id}: ${bits.join(' · ')}`);
        }
      } else {
        lines.push('plan usage unavailable (usage dashboard not running here)');
      }
    } catch (err) {
      lines.push(`plan usage unavailable: ${err?.message ?? err}`);
    }
    this.#emitLocal(s, turnId, text, lines.join('\n'));
    return { ok: true };
  }

  /** A turn helm itself speaks: appended and pushed like any driver event. */
  #emitLocal(s, turnId, text, body = null) {
    const itemId = `local-${turnId}`;
    const evs = [
      { type: 'turn.start', turnId, text },
      ...(body == null ? [] : [
        { type: 'item.start', id: itemId, kind: 'text', turnId },
        { type: 'item.delta', id: itemId, text: body },
        { type: 'item.done', id: itemId, status: 'ok' },
      ]),
      { type: 'turn.done', turnId, status: 'ok' },
    ];
    for (const e of evs) {
      const event = this.events.append(s.id, e);
      s.lastSeq = event.seq;
      this.emit('event', { id: s.id, event });
    }
  }

  /**
   * The viewer's size. A pty renders for it; a herdr pane has its own
   * geometry that the phone does not get to choose, so this is a no-op there
   * rather than an error - the terminal view sends it either way.
   */
  resize(id, cols, rows) {
    const s = this.get(id);
    if (s.pty) this.terminals.resize(id, cols, rows);
    return { ok: true };
  }

  keys(id, keys) {
    const s = this.get(id);
    if (s.driver) throw new Error('a headless session has no terminal');
    if (s.pty) {
      this.terminals.write(id, keys.map(KEY_BYTES).join(''));
      return { ok: true };
    }
    return this.runtime.sendKeys(this.#handle(s), keys);
  }

  async kill(id) {
    const s = this.get(id);
    if (s.driver) {
      const d = this.#drivers.get(id);
      this.#drivers.delete(id);
      clearTimeout(this.#reapers.get(id));
      if (d) await d.kill();
      this.#index.delete(id);
      this.#save();
      this.events.remove(id);
      this.emit('session', { ...s, status: 'exited', alive: false });
      return { ok: true };
    }
    if (s.pty) {
      await this.terminals.close(id);
      this.#index.delete(id);
      this.#save();
      this.emit('session', { ...s, status: 'exited', alive: false });
      return { ok: true };
    }
    await this.runtime.close(this.#handle(s));
    if (!s.adopted) {
      this.#index.delete(id);
      this.#save();
    }
    return { ok: true };
  }

  /** Hide a session from the active list without stopping or deleting it. */
  archive(id, archived = true) {
    const s = this.get(id);
    if (s.adopted) throw new Error('an external session cannot be archived');
    s.archived = !!archived;
    s.archivedAt = s.archived ? Date.now() : null;
    this.#save();
    this.emit('session', s);
    return { ok: true, session: s };
  }

  /**
   * Find out which terminals outlived this daemon.
   *
   * The host holds them, so an upgrade or a crash leaves them running - but
   * not forever, and not if the host itself was stopped. Anything the host
   * does not have is genuinely gone, and its record goes with it rather than
   * offering a phone a terminal that no longer exists.
   */
  async adoptTerminals() {
    const ok = await this.terminals.ensure({ spawn: false }).catch(() => false);
    let changed = false;
    for (const s of [...this.#index.values()]) {
      if (!s.pty) continue;
      if (ok && this.terminals.has(s.id)) continue;
      this.#index.delete(s.id);
      changed = true;
      this.emit('session', { ...s, status: 'exited', alive: false });
    }
    if (changed) this.#save();
    return ok;
  }

  /** Re-watch every surviving pane after a daemon restart. */
  resume() {
    for (const s of this.#index.values()) {
      // A terminal lives in the host process, which outlives us - so its
      // record stays until `adoptTerminals()` has asked what really survived.
      if (s.pty) continue;
      if (!s.driver) { this.runtime.watch(this.#handle(s)); continue; }
      // The process that asked died with the previous daemon; a prompt it
      // left open cannot be answered any more, so close it out here rather
      // than show a phone a question nobody can act on.
      for (const p of this.events.pending(s.id)) {
        this.events.append(s.id, { type: 'permission.resolved', requestId: p.requestId, decision: 'cancelled' });
      }
      const open = this.events.openTurn(s.id);
      if (open) this.events.append(s.id, { type: 'turn.done', turnId: open.turnId, status: 'interrupted', error: 'helm restarted' });
      if (s.status !== 'idle') { s.status = 'idle'; s.updatedAt = Date.now(); }
    }
    this.#save();
  }

  /** Close every live agent process; sessions stay resumable. */
  async stop() {
    await Promise.allSettled([...this.#drivers.values()].map((d) => d.kill()));
    this.#drivers.clear();
  }
}
