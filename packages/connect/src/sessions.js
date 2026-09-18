import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HELM_DIR, expand } from './paths.js';
import { getProfiles, materialize } from './profiles.js';
import { locate, messages as readMessages } from './transcript.js';
import { ENGINES } from './engines.js';
import { localDigest, pathWithShim } from './brain.js';
import { forWire } from './events.js';
import { optionArgs } from './models.js';
import { modelPrefs, accountKey } from './settings.js';
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
 * A name for a session that is more than the folder it runs in.
 *
 * Two sources: the agent itself - ACP sessions report the title they chose
 * as `session_info_update`, kept on the record as `generatedTitle` - and the
 * prompts, which always exist. Either kind lands only once the session has
 * TITLE_AFTER user prompts behind it: named on the first alone, a real
 * fraction of sessions would be called "hi". The name the owner typed at
 * start (`titleBy: 'user'`) always wins.
 */
const TITLE_AFTER = 2;
const TITLE_RANK = { auto: 1, agent: 2, user: 3 };
/** A prompt that says nothing about the work the session is for. */
const GREETING = /^(hi+|hey+|hello+|yo|sup|hiya|howdy|test(ing)?|ping|ok(ay)?|thanks?( you)?|good (morning|afternoon|evening))[.\s!?,]*$/i;

/** A title cut to fit, with the cut said out loud. */
const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/** A prompt's first non-empty line, unless the line says nothing. */
const informative = (text) => {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  return line && !GREETING.test(line) ? line : null;
};

/** The first informative line among the sampled prompts, or null. */
const promptTitle = (samples) => {
  for (const p of samples ?? []) {
    const line = informative(p);
    if (line) return clip(line, 60);
  }
  return null;
};

/**
 * Rows helm does not own: a herdr pane it did not start (`pane:`), and a past
 * session read out of a CLI's own history (`found:`). They are real work and
 * belong in the list, but helm has no record of its own to archive or delete -
 * so what the owner does with one is kept beside the sessions as a mark.
 */
const EXTERNAL = /^(pane:|found:)/;

/**
 * What a session looks like on the wire: everything but helm's own notes.
 * Both ways out - `list()` and every `session` event - go through it, so a
 * note kept for naming a thread never rides along to every paired device.
 */
export const wire = ({ promptSample, ...s }) => s;

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
/**
 * What a client may attach to one message.
 *
 * The browser already compresses and caps what it sends, but that cap is a
 * courtesy, not a guarantee: `session.input` is reachable by anything
 * holding a device token, and whatever arrives is written to the event log
 * and piped into a CLI's stdin. So the limits are enforced here too, and an
 * attachment that breaks them fails the send loudly instead of being
 * quietly dropped on the way to the model.
 */
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHED_BYTES = 24 * 1024 * 1024;

const MB = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Can this live driver be handed image bytes? One predicate, used both to
 * decide what to send and to tell the app whether to offer the clip, so the
 * two can never disagree.
 */
export function driverTakesImages(d) {
  if (!d || typeof d.sendWithAttachments !== 'function') return false;
  return d.acceptsImages?.() ?? true;
}

export function acceptImages(attachments) {
  const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  if (!list.length) return [];
  if (list.length > MAX_IMAGES) {
    throw new Error(`too many attachments: ${list.length}, the limit is ${MAX_IMAGES}`);
  }
  let total = 0;
  const out = [];
  for (const a of list) {
    const mime = String(a.mime ?? '').toLowerCase().split(';')[0].trim();
    const filename = String(a.filename ?? 'image').slice(0, 120);
    if (!mime.startsWith('image/')) throw new Error(`${filename} is ${mime || 'of unknown type'}; only images can be attached`);
    const data = String(a.data ?? '');
    if (!data) throw new Error(`${filename} arrived with no image data`);
    // Base64 is the wire form all the way to the CLIs, so it is validated
    // rather than re-encoded - a malformed payload would otherwise surface
    // as an opaque failure from inside the agent.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new Error(`${filename} is not valid base64`);
    }
    const bytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`${filename} is ${MB(bytes)}; the limit is ${MB(MAX_IMAGE_BYTES)}`);
    total += bytes;
    if (total > MAX_ATTACHED_BYTES) throw new Error(`those attachments come to ${MB(total)}; the limit is ${MB(MAX_ATTACHED_BYTES)} a message`);
    out.push({ filename, mime, data });
  }
  return out;
}

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
  /** external id -> 'archived' | 'removed', for rows helm does not own */
  #marks = new Map();

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
      for (const [id, state] of Object.entries(raw.external || {})) this.#marks.set(id, state);
    } catch { /* a corrupt index must not stop the daemon booting */ }
  }

  #save() {
    mkdirSync(HELM_DIR, { recursive: true });
    writeFileSync(
      INDEX_FILE,
      JSON.stringify({
        version: 1,
        sessions: [...this.#index.values()],
        external: Object.fromEntries(this.#marks),
      }, null, 2),
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
      const mark = this.#marks.get(`pane:${paneId}`);
      if (mark === 'removed') continue;
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
        archived: mark === 'archived',
        alive: true,
        adopted: true,
        updatedAt: Date.now(),
      });
    }

    for (const s of this.#index.values()) {
      if (s.driver) {
        out.push({ ...wire(s), archived: !!s.archived, alive: this.#drivers.has(s.id), adopted: false, pending: this.events.pending(s.id).length });
        continue;
      }
      if (s.pty) {
        const alive = this.terminals.has(s.id);
        out.push({ ...wire(s), alive, status: alive ? 'shell' : 'exited', adopted: false });
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
      out.push({ ...wire(s), archived: !!s.archived, alive: !!pane, status, cwd: pane?.cwd ?? s.cwd, adopted: false });
    }
    // Anything waiting on a human floats to the top; that is the whole point
    // of watching from a phone.
    const rank = (x) => (x.status === 'blocked' ? 0 : x.status === 'working' ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async start({ cwd, profileId, title, model, auto, effort, mode, brain = false }) {
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`unknown profile: ${profileId}`);
    // The account's configured default is what a new session starts with; a
    // model chosen up front always wins.
    if (!model) model = modelPrefs(profile)?.default ?? null;
    if (ENGINES[profile.engine]?.driver) return this.#startDriven({ cwd, profile, title, model, effort, mode, auto, brain });
    if (brain) throw new Error(`${profile.engine} cannot be the brain: it has no headless driver`);

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
      titleBy: title ? 'user' : null,
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
  /**
   * The next free "Terminal N".
   *
   * The app used to count the terminals it could see and add one, which is
   * a guess made from a list that may not have caught up - open two in quick
   * succession and both are called "Terminal 1", which is what happened.
   * The daemon holds the only list that is actually authoritative, so it
   * does the naming: one past the highest number in use, and a number freed
   * by closing a terminal stays free rather than being handed out twice.
   */
  #nextTerminalName() {
    let highest = 0;
    for (const s of this.#index.values()) {
      const n = /^Terminal (\d+)$/.exec(s.title ?? '');
      if (n) highest = Math.max(highest, Number(n[1]));
    }
    return `Terminal ${highest + 1}`;
  }

  async #startTerminal({ dir, profileId, title, env }) {
    const session = {
      id: randomBytes(6).toString('hex'),
      pty: true,
      profileId,
      engine: 'shell',
      cwd: dir,
      title: title || this.#nextTerminalName(),
      titleBy: title ? 'user' : null,
      status: 'shell',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // Registered before the await, not after: the name is taken from this
    // same index, and two terminals opened at once would otherwise both read
    // it before either had been added, and both be called "Terminal 1".
    this.#index.set(session.id, session);
    try {
      await this.terminals.open(session.id, { cwd: dir, env });
    } catch (err) {
      this.#index.delete(session.id);
      throw err;
    }
    this.#save();
    this.emit('session', session);
    return session;
  }

  // ---------------------------------------------------------- headless agents

  async #startDriven({ cwd, profile, title, model, effort, mode, auto, brain = false, engineSessionId = null }) {
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
      titleBy: title ? 'user' : null,
      // The brain is a thread like any other - same driver, same events, same
      // permission cards - marked so that it can be found again and so that
      // `input` knows to put the network's state in front of what is typed.
      brain: brain || undefined,
      status: 'idle',
      // Set when picking up a conversation the CLI already has: the driver
      // reads this as "resume", not "start".
      engineSessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#index.set(session.id, session);
    const driver = await this.#driver(session);
    await driver.start();
    // A fresh session takes whatever id the driver minted; a resumed one
    // already had the id that made it a resume, and must keep it.
    session.engineSessionId = engineSessionId ?? driver.engineSessionId;
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
    // The brain's tools are the `helm` command, so which `helm` it finds is
    // the whole question. Give it this daemon's own, ahead of the installed
    // one: a machine that has not been upgraded yet would otherwise hand the
    // brain a CLI that does not have the verbs its brief promises.
    if (s.brain) spec.env = { ...spec.env, PATH: pathWithShim(spec.env?.PATH) };
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
    if (e.type === 'title') return this.#titled(s, e.title, 'agent');
    // Every turn has always said what it cost and nothing added them up.
    // Accumulated on the record rather than summed from the log, which is
    // trimmed to the last few hundred events - a long thread would start
    // forgetting what its early turns cost.
    if (e.type === 'turn.done' && this.#index.has(s.id)) {
      s.turns = (s.turns ?? 0) + 1;
      if (e.costUsd > 0) s.costUsd = Math.round(((s.costUsd ?? 0) + e.costUsd) * 1e6) / 1e6;
      this.#save();
    }
    if (d.engineSessionId && d.engineSessionId !== s.engineSessionId) {
      s.engineSessionId = d.engineSessionId;
      this.#save();
    }
    const event = this.events.append(s.id, e);
    s.lastSeq = event.seq;
    this.emit('event', { id: s.id, event });
  }

  /**
   * One more real prompt behind the session. The title gate opens at
   * TITLE_AFTER: take the agent's own name when it reported a meaningful
   * one, else make one out of the prompts themselves.
   */
  #prompted(s, text) {
    if (!this.#index.has(s.id)) return;
    s.prompts = (s.prompts ?? 0) + 1;
    // Only a prompt that says something about the work is worth sampling: a
    // session that opens "hi", "hello" would otherwise fill the sample with
    // greetings and never earn a name at all.
    const sample = (s.promptSample ??= []);
    if (sample.length < TITLE_AFTER && informative(text)) sample.push(String(text).slice(0, 200));
    this.#save();
    // The gate opens *at* TITLE_AFTER and stays open: when the first prompts
    // were all greetings there is nothing to name the session after yet, and
    // the one that finally says something still deserves to name it.
    if (s.prompts < TITLE_AFTER) return;
    const agent = s.generatedTitle || null;
    const pick = agent ?? promptTitle(s.promptSample);
    if (pick) this.#titled(s, pick, agent ? 'agent' : 'auto');
  }

  /**
   * Adopt a candidate title once the session is old enough for it to be
   * trusted. The agent's own name outranks one derived from the prompts; a
   * name the owner typed outranks both.
   */
  #titled(s, title, by) {
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (by === 'agent') {
      // An ACP agent's first name for a session is a copy of the prompt, and
      // it keeps reporting one - so "hi" three prompts in would otherwise
      // rename a session that had already earned something better.
      if (GREETING.test(clean)) return;
      if (s.generatedTitle !== clean) {
        s.generatedTitle = clean;
        this.#save();
      }
    }
    // The gate is about *generated* names being premature. A name the owner
    // typed is never premature.
    if (by !== 'user' && (s.prompts ?? 0) < TITLE_AFTER) return;
    if ((TITLE_RANK[by] ?? 0) < (TITLE_RANK[s.titleBy] ?? 0)) return;
    const named = clip(clean, 80);
    if (s.title === named) return;
    s.title = named;
    s.titleBy = by;
    this.#save();
    this.emit('session', s);
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
/**
   * Pick up a conversation this machine's CLI recorded on its own.
   *
   * A session started at the keyboard - `claude` in a terminal, `codex` in a
   * pane - is listed by `inventory()` and, until now, could only be looked at.
   * That is the wrong half of the promise: the point of helm is to walk away
   * from the desk, and the thread you most want on your phone is the one you
   * were just working on.
   *
   * There is no process to attach to; the CLI exited. What this does is start
   * a *new* driven session carrying the old one's id, so the engine resumes
   * its own conversation - the same `--resume` the CLI would do - and helm
   * then owns it like any other thread. `engineSessionId` set before the
   * driver is built is the whole mechanism; every driver already treats a
   * supplied id as "resume this" rather than "start this".
   *
   * The account matters: a conversation recorded under one login cannot be
   * resumed under another, because the transcript is not there to resume.
   * So the profile is chosen by matching the engine *and* the account the
   * inventory read it from, and only then falling back to the engine.
   */
  async resumeExternal({ engine, account, id, cwd, title }) {
    if (!id) throw new Error('which conversation?');
    const spec = ENGINES[engine];
    if (!spec?.driver) throw new Error(`helm cannot drive ${engine} sessions`);

    // Already resumed once: hand back the thread rather than making a second
    // one that fights the first for the same conversation.
    for (const s2 of this.#index.values()) {
      if (s2.engineSessionId === id && s2.driver) return this.get(s2.id);
    }

    const profiles = await getProfiles();
    const forEngine = profiles.filter((x) => x.engine === engine);
    if (!forEngine.length) throw new Error(`no ${engine} account on this machine`);

    // The account the inventory recorded names a *home*, not something that
    // can necessarily run. `inventory()` dedupes by engine and home and keeps
    // whichever alias it saw first, and aliases onto one home differ in the
    // part that matters: here `claude-p` and `claudea` are both
    // `CLAUDE_CONFIG_DIR=~/.claude-personal`, and only `claudea` carries
    // `CLAUDE_CODE_OAUTH_TOKEN`. Resuming under the first one starts a CLI
    // that cannot authenticate and answers nothing, which looks exactly like
    // resume being broken.
    //
    // So: find the home the recorded account means, then among the aliases
    // onto that home take the one best able to run it - credentials first,
    // then the plainest, the same ordering the account picker uses.
    const spoken = forEngine.find((x) => accountKey(x) === account)
      ?? forEngine.find((x) => x.id === account);
    const homeOf = (x) => x.env?.[spec.homeEnv] ?? spec.defaultHome;
    const home = spoken ? homeOf(spoken) : null;
    const candidates = home ? forEngine.filter((x) => homeOf(x) === home) : forEngine;
    const profile = [...candidates].sort((a, b) =>
      ((b.envFrom?.length ?? 0) > 0 ? 1 : 0) - ((a.envFrom?.length ?? 0) > 0 ? 1 : 0)
      || (a.args?.length ?? 0) - (b.args?.length ?? 0))[0];
    if (!profile) throw new Error(`no ${engine} account on this machine`);

    const session = await this.#startDriven({
      cwd: cwd || '~', profile, title: title || null,
      model: null, effort: null, mode: null, auto: null,
      engineSessionId: id,
    });
    // Nothing to mark: the row it came from is matched to this session by
    // its engineSessionId and drops out of the list on the next refresh
    // (`dedupeDetected` in the web app), which is also what stops a resumed
    // thread appearing twice.
    return session;
  }

  /**
   * This machine's contribution to the digest: its live sessions, each with
   * the line `brain.js` derives from its event log. Separate from `list()`
   * on purpose - `list()` is polled by every paired device every 15 seconds,
   * and reading every session's event tail is not something to do on that
   * schedule for people who are not asking for it.
   */
  async digest() {
    return { sessions: localDigest(await this.list(), this.events) };
  }

  /** The brain's thread on this machine, if it has one. */
  brainSession() {
    for (const s of this.#index.values()) if (s.brain) return s;
    return null;
  }

  /**
   * The conversation as a client should see it.
   *
   * `tail` is what an app opening a chat asks for - the end of it - and
   * `before` is how it walks back from there. A plain `since` still pages
   * forward, which is what a client with a cached log wants: everything that
   * happened while it was away. Every shape is budgeted in bytes by
   * `events.window`, so no reply is ever too big to arrive.
   */
  history(id, { since = 0, limit = 500, tail = 0, before = 0 } = {}) {
    const s = this.get(id);
    const back = tail > 0 || before > 0;
    const w = this.events.window(s.id, {
      since,
      before,
      tail: tail ? Math.max(1, Math.min(Number(tail), 1000)) : 0,
    });
    // `limit` caps a page read forwards. A window taken from the end is
    // already bounded by `tail` and by the byte budget, and slicing it here
    // would cut the newest events off - the ones it was asked for.
    const capped = Math.max(1, Math.min(Number(limit) || 500, 1000));
    const events = back ? w.events : w.events.slice(0, capped);
    return {
      events,
      // A pending prompt is an event like any other and can carry a diff to
      // approve, so it goes through the same cap.
      pending: this.events.pending(s.id).map(forWire),
      last: this.events.last(s.id),
      session: s,
      hasMore: w.hasMore || events.length < w.events.length,
      // The window's own front, not its first event's: a window that lands
      // inside a long turn carries that turn's opening line from further
      // back, and reporting *that* as the front would claim a conversation
      // with a hole in the middle of it was whole.
      firstSeq: events.length === w.events.length ? w.firstSeq : (events[0]?.seq ?? 0),
      logFirst: w.logFirst,
    };
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

  /**
   * Whether a *running* agent can be sent images, or null when no driver is
   * up to ask. ACP agents only answer this at `initialize`, so a session
   * that has not started yet leaves the app on the model catalogue's guess.
   */
  acceptsImages(id) {
    const d = this.#drivers.get(id);
    return d ? driverTakesImages(d) : null;
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
      let clean = text.replace(/\n$/, '');
      // Slash commands are helm's, not the agent's: intercept before the
      // text reaches a CLI that would read them as words in a prompt.
      if (!raw) {
        const slash = /^\/(compact)(?:\s+(.*?))?\s*$/s.exec(text.trim());
        if (slash) return this.#slash(s, slash[1], (slash[2] ?? '').trim());
      }
      // What a client sent is not trusted to be sane: it arrives over the
      // network and lands in the event log and in a CLI's stdin.
      const images = acceptImages(attachments);

      // The brain is asked about a network, not a folder, so what it is
      // told has to include which network and in what state. One line, not
      // the digest: see `summaryLine`.
      const brainLine = s.brain && !raw ? this.brief?.() : null;

      const d = await this.#driver(s);
      // An ACP agent only says whether it takes images in its reply to
      // `initialize`, and the driver is started lazily - so asking before it
      // is up gets `false` for an agent that would have said yes, and the
      // picture becomes a filename. Start it first when there is an image
      // riding on the answer. `start()` returns immediately if it is already
      // running, and `send` would have called it a line later anyway.
      if (images.length) await d.start?.();
      // Sampled before the prefix goes on: the network's state is helm's
      // note to the agent, and naming the thread "[helm 2 machines…]" would
      // be naming it after helm rather than after the work.
      if (!raw) this.#prompted(s, clean);
      if (brainLine) clean = `${brainLine}\n\n${clean}`;

      // Emit the turn optimistically so every watcher sees the message the
      // moment it is sent, not when the agent gets round to echoing it. A
      // message queued behind a running turn can sit un-announced for
      // minutes - without this it looks like it was never sent at all. The
      // text emitted is the final text, helm's note included, because the
      // echo is matched against it: a `local-` turn is adopted by the real
      // turn's `turn.start` when the texts agree (see `apply` in the web's
      // session/types.ts).
      // `local-` plus a nonce: two sends in the same millisecond are two
      // turns, and an id shared between them would let one's turn.done
      // close the other.
      const turnId = `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      {
        const event = this.events.append(id, {
          type: 'turn.start', turnId, text: clean,
          attachments: images.map((a) => this.events.putAttachment(id, a)),
        });
        s.lastSeq = event.seq;
        this.emit('event', { id, event });
      }
      // The driver is the authority on whether this agent can see an image:
      // it is the one that spoke to the CLI. Anything else gets a filename
      // placeholder in the text, which is always safe while lost bytes are
      // not - but it says so out loud rather than dropping them silently.
      try {
        if (images.length && driverTakesImages(d)) {
          await d.sendWithAttachments(clean, images);
        } else {
          let msg = clean;
          if (images.length) {
            const names = images.map((a) => `[image: ${a.filename || 'image'} - this agent cannot see images]`).join('\n');
            msg = msg ? `${msg}\n${names}` : names;
            this.events.append(id, {
              type: 'error', kind: 'attachment',
              message: images.length === 1
                ? `${s.engine} cannot be sent images, so ${images[0].filename || 'the image'} was named but not attached.`
                : `${s.engine} cannot be sent images, so ${images.length} attachments were named but not sent.`,
            });
          }
          await d.send(msg);
        }
      } catch (err) {
        // The send never reached the agent. The bubble stays - it is what
        // the owner wrote - but it closes failed rather than hanging as a
        // message that looks merely unanswered, and the error travels back
        // to the client so the draft is offered again.
        const failed = this.events.append(id, {
          type: 'turn.done', turnId, status: 'error',
          error: String(err?.message || err),
        });
        s.lastSeq = failed.seq;
        this.emit('event', { id, event: failed });
        throw err;
      }
      return { ok: true };
    }
    if (s.pty) { await this.terminals.write(id, text); return { ok: true }; }
    const handle = this.#handle(s);
    if (s.agentName && !raw) {
      this.#prompted(s, text);
      return this.runtime.sendPrompt(handle, text);
    }
    return this.runtime.sendText(handle, text);
  }

  /** `/compact [hint]` summarises the conversation into a fresh context. */
  async #slash(s, cmd, arg) {
    const turnId = `local-${Date.now().toString(36)}`;
    const text = `/${cmd}${arg ? ` ${arg}` : ''}`;
    this.#emitLocal(s, turnId, text);
    const d = await this.#driver(s);
    await d.compact(arg);
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
    // A row read out of a CLI's own history: there is no process to stop and
    // nothing of ours to delete. "Delete" here means stop listing it - the
    // CLI's own transcript is its data, not helm's, and stays where it is.
    if (id.startsWith('found:')) return this.#mark(id, 'removed');
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

  /** What the owner has filed away or dismissed among the rows helm does not own. */
  marks() { return Object.fromEntries(this.#marks); }

  #mark(id, state) {
    if (state) this.#marks.set(id, state); else this.#marks.delete(id);
    this.#save();
    const session = { id, adopted: true, archived: state === 'archived', removed: state === 'removed' };
    this.emit('session', session);
    return { ok: true, session };
  }

  /** Hide a session from the active list without stopping or deleting it. */
  /**
   * The name the owner typed, which outranks anything helm or the agent
   * came up with and is never overwritten afterwards.
   */
  rename(id, title) {
    const s = this.get(id);
    if (s.adopted) throw new Error('an external session is named by the program that started it');
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('a thread needs a name');
    this.#titled(s, clean, 'user');
    return { ok: true, session: wire(s) };
  }

  /**
   * "Ping me when this finishes" - a one-shot flag on the thread. The bell
   * rings once on the next transition out of `working` (done, interrupted,
   * errored - any of them counts as finished for the person who asked), then
   * clears itself: a bell that stays armed would buzz on every later turn
   * too, which is the fastest way to get it ignored.
   */
  setNotifyDone(id, on = true) {
    const s = this.get(id);
    s.notifyDone = !!on;
    if (this.#index.has(id)) this.#save();
    this.emit('session', s);
    return { ok: true, session: wire(s) };
  }

  archive(id, archived = true) {
    // Nothing of helm's to write on, so the mark is the record. Archiving one
    // of these is the only way to get a machine's own terminal panes and a
    // CLI's year of history out of the way without pretending they are gone.
    if (EXTERNAL.test(id)) return this.#mark(id, archived ? 'archived' : null);
    const s = this.get(id);
    s.archived = !!archived;
    s.archivedAt = s.archived ? Date.now() : null;
    this.#save();
    this.emit('session', s);
    return { ok: true, session: wire(s) };
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
