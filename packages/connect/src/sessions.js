import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HELM_DIR, expand } from './paths.js';
import { getProfiles, materialize } from './profiles.js';
import { locate, messages as readMessages } from './transcript.js';
import { ENGINES } from './engines.js';

const INDEX_FILE = join(HELM_DIR, 'sessions.json');

/** herdr requires agent names to match [a-z][a-z0-9_-]{0,31} and be unique. */
const agentName = (profileId) =>
  (profileId.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z]+/, 'a') +
    '-' + randomBytes(2).toString('hex')).slice(0, 32);

/**
 * helm's view of sessions, layered over herdr.
 *
 * herdr owns the processes and their lifetime; this class owns the mapping
 * from a helm session to the herdr workspace/pane/agent behind it, so that a
 * daemon restart reconnects to work that never stopped running.
 */
export class Sessions extends EventEmitter {
  #index = new Map();
  /** paneId -> what the runtime last told us about a pane we do not own */
  #adopted = new Map();

  constructor(runtime) {
    super();
    this.runtime = runtime;
    this.#load();
    runtime.on('status', (e) => this.#onStatus(e));
    runtime.on('closed', (e) => this.#onClosed(e));
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
      const pane = live.get(s.paneId);
      // A plain shell has no agent for the runtime to classify, so its status
      // would always read 'unknown'. Say what it actually is.
      const status = s.engine === 'shell'
        ? (pane ? 'shell' : 'exited')
        : (pane?.status ?? s.status ?? 'unknown');
      out.push({ ...s, alive: !!pane, status, cwd: pane?.cwd ?? s.cwd, adopted: false });
    }
    // Anything waiting on a human floats to the top; that is the whole point
    // of watching from a phone.
    const rank = (x) => (x.status === 'blocked' ? 0 : x.status === 'working' ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async start({ cwd, profileId, title }) {
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`unknown profile: ${profileId}`);

    const spec = materialize(profile);
    const dir = expand(cwd);

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
      cwd: dir,
      title: title || profile.label,
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
    if (!s.transcript) {
      const profiles = await getProfiles();
      const profile = profiles.find((p) => p.id === s.profileId);
      const engine = ENGINES[s.engine];
      if (!engine || engine.plain) return { messages: [], source: null };

      s.transcript = await locate({
        engine: s.engine,
        home: profile?.env?.[engine.homeEnv] ?? engine.defaultHome,
        cwd: s.cwd,
        startedAt: s.createdAt ?? 0,
      });
      if (s.transcript && this.#index.has(id)) this.#save();
    }
    return {
      messages: await readMessages({
        engine: s.engine, path: s.transcript, sessionId: s.engineSessionId, limit,
      }),
      source: s.transcript,
    };
  }

  async read(id, { lines = 200, source = 'recent', ansi = false } = {}) {
    const s = this.get(id);
    const res = await this.runtime.read(this.#handle(s), { lines, source, ansi });
    return { text: res.text, session: s };
  }

  /**
   * Send a prompt to the agent, or raw text to the terminal.
   *
   * `raw` matters: from the terminal view every keystroke - arrows, ctrl-c,
   * a bare newline - has to reach the pane untouched, whereas the chat view
   * wants a whole message handed to the agent as a prompt.
   */
  async input(id, text, { raw = false } = {}) {
    const s = this.get(id);
    const handle = this.#handle(s);
    return s.agentName && !raw
      ? this.runtime.sendPrompt(handle, text)
      : this.runtime.sendText(handle, text);
  }

  keys(id, keys) {
    return this.runtime.sendKeys(this.#handle(this.get(id)), keys);
  }

  async kill(id) {
    const s = this.get(id);
    await this.runtime.close(this.#handle(s));
    if (!s.adopted) {
      this.#index.delete(id);
      this.#save();
    }
    return { ok: true };
  }

  /** Re-watch every surviving pane after a daemon restart. */
  resume() {
    for (const s of this.#index.values()) this.runtime.watch(this.#handle(s));
  }
}
