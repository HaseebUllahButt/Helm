import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, readlinkSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HELM_DIR, expand } from './paths.js';
import { getProfiles, materialize } from './profiles.js';
import { locate, messages as readMessages, sessionSnapshot } from './transcript.js';
import { ENGINES } from './engines.js';
import { localDigest, pathWithShim } from './brain.js';
import { forWire } from './events.js';
import { optionArgs } from './models.js';
import { modelPrefs, startPrefs, saveModelPrefs, accountKey } from './settings.js';
import { EventLog } from './events.js';
import { ClaudeDriver } from './drivers/claude.js';
import { CodexDriver, canInspectExternalCodex } from './drivers/codex.js';
import { OpencodeDriver, Opencode2Driver } from './drivers/opencode.js';
import { DevinDriver } from './drivers/devin.js';
import { devinUsageReport } from './devin-usage.js';
import { defaultMode, modeFromAuto } from './modes.js';
import { TerminalHost, PROC_SOCKET_PATH } from './terminals.js';
import { inventory } from './inventory.js';

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

const DRIVERS = {
  claude: ClaudeDriver,
  codex: CodexDriver,
  opencode: OpencodeDriver,
  opencode2: Opencode2Driver,
  devin: DevinDriver,
};

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
export const wire = ({ promptSample, transcript, externalLock, externalPid, externalImported, externalSource, externalTail, ...s }) => s;

const EXTERNAL_INFO_COMMANDS = [
  { name: 'status', description: 'Show this session configuration and usage', source: 'helm' },
  { name: 'usage', description: 'Show persisted token usage for this session', source: 'helm' },
];

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
  /**
   * sessionId -> messages accepted but not yet handed to the agent.
   *
   * Every CLI queues input typed mid-turn *differently*: claude holds it
   * internally, codex's app-server refuses a second turn/start outright, and
   * an ACP agent answers a prompt sent while one is open however it pleases.
   * So the queue lives here, where it works the same on all four: a message
   * sent while the agent is working or blocked waits for the turn to end,
   * then goes out in the order it was typed - what typing into a CLI does.
   * Memory only: a daemon restart closes the orphaned `local-` turns in
   * `resume()` rather than promising to send what it no longer can.
   */
  #outbox = new Map();
  /** sessionIds with a `#deliver` in flight - the queue's mutex. */
  #sending = new Set();
  /** session object -> in-flight full-rollout reconciliation */
  #imports = new WeakMap();

  constructor(runtime, { events = new EventLog(), makeDriver = null, log = () => {}, terminals = new TerminalHost(), procHost = null } = {}) {
    super();
    this.runtime = runtime;
    this.events = events;
    this.log = log;
    this.makeDriver = makeDriver ?? ((engine, opts) => new DRIVERS[engine](opts));
    this.terminals = terminals;
    // Agent processes live on a second host behind a second socket, so this
    // feature does not wait on - or cost - whatever the pty host is holding.
    this.procs = procHost ?? new TerminalHost({ socketPath: PROC_SOCKET_PATH, unit: 'helm-procs' });
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
    // An agent process that dies while no driver holds it still leaves the
    // record: close what it left open so the session stops reading as busy.
    this.procs.on('proc.exit', ({ id }) => this.#procGone(id));
  }

  isDriven(s) { return !!s?.driver; }

  /** Ask the live CLI what slash commands it accepts in this session. */
  async commands(id) {
    const s = this.get(id);
    if (!s.driver) return [];
    // Starting a second Claude/ACP process merely to populate a menu can
    // contend with the external CLI we are monitoring. These two reads are
    // available immediately; the provider's full dynamic palette appears
    // after Helm owns/resumes the session.
    if (s.external && s.engine !== 'codex') return EXTERNAL_INFO_COMMANDS;
    const driver = await this.#driver(s);
    const available = await driver.availableCommands?.() ?? [];
    return s.externalSource && s.engine !== 'codex'
      ? [...EXTERNAL_INFO_COMMANDS, ...available]
      : available;
  }

  /**
   * What a terminal on this machine will be: helm's own pty, or the slow
   * herdr-pane fallback. While the app is loading machine details, start the
   * pty host in the background so the first terminal does not have to wait
   * for its process and socket to come up.
   */
  async terminalBackend() {
    if (this.terminals.usable) return 'pty';
    const { loadPty } = await import('./pty.js');
    if (!(await loadPty())) return 'panes';
    this.terminals.ensure().catch(() => {});
    return 'pty';
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
      for (const s of raw.sessions || []) {
        // Completion notifications are the normal behaviour for driven
        // threads. Preserve an explicit opt-out from an older client.
        if (s.driver && s.notifyDone == null) s.notifyDone = true;
        this.#index.set(s.id, s);
      }
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
      if (s.external) {
        const active = this.#externalActive(s);
        // This record is a read-only window onto another process until its
        // writer lock goes away. Keep it in the ordinary list so an open app
        // continues to receive transcript notifications across refreshes.
        out.push({
          ...wire(s), alive: active, adopted: true,
          status: active ? 'idle' : 'idle',
          externalActive: active,
        });
        continue;
      }
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

  async start({ cwd, profileId, title, model, auto, effort, mode, speed, brain = false }) {
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`unknown profile: ${profileId}`);
    // The account's configured default is what a new session starts with; a
    // model chosen up front always wins.
    if (!model) model = modelPrefs(profile)?.default ?? null;
    const defaults = startPrefs(profile) ?? {};
    if (!effort) effort = defaults.effort ?? null;
    if (!mode) mode = defaults.mode ?? null;
    if (!speed) speed = defaults.speed ?? null;
    if (ENGINES[profile.engine]?.driver) return this.#startDriven({ cwd, profile, title, model, effort, mode, speed, auto, brain });
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

  async #startDriven({ cwd, profile, title, model, effort, mode, speed, auto, brain = false, engineSessionId = null, transcript = null }) {
    const dir = expand(cwd);
    const session = {
      id: randomBytes(6).toString('hex'),
      driver: profile.engine,
      profileId: profile.id,
      engine: profile.engine,
      model: model || null,
      effort: effort || null,
      mode: mode || (auto != null ? modeFromAuto(profile.engine, auto) : defaultMode(profile.engine)),
      speed: speed || null,
      cwd: dir,
      title: title || `${dir.split('/').pop() || dir}`,
      titleBy: title ? 'user' : null,
      // The brain is a thread like any other - same driver, same events, same
      // permission cards - marked so that it can be found again and so that
      // `input` knows to put the network's state in front of what is typed.
      brain: brain || undefined,
      notifyDone: true,
      status: 'idle',
      // Set when picking up a conversation the CLI already has: the driver
      // reads this as "resume", not "start".
      engineSessionId,
      transcript,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#index.set(session.id, session);
    let driver = null;
    try {
      driver = await this.#driver(session);
      await driver.start();
      // A model the agent refused is corrected by a settings event mid-start
      // (the record then carries what is actually running). When the refused
      // value was the account's stored default it is stale - providers retire
      // names - so drop it rather than fail the same way on every new
      // session. An explicit pick that missed is left alone.
      if (model && session.model !== model) {
        try {
          const prefs = modelPrefs(profile);
          if (prefs?.default === model) {
            this.log(`[${session.id}] dropping stale ${profile.engine} default model ${model}`);
            saveModelPrefs(profile, { default: null, approved: prefs.approved });
          }
        } catch { /* a read-only config still gets the session's correction */ }
      }
      // A fresh session takes whatever id the driver minted; a resumed one
      // already had the id that made it a resume, and must keep it.
      session.engineSessionId = engineSessionId ?? driver.engineSessionId;
      if (!session.engineSessionId) throw new Error(`${profile.label || profile.engine} did not create an engine session`);
      this.#save();
      this.emit('session', session);
      return session;
    } catch (err) {
      // A failed handshake must not leave a phantom row (or an agent process)
      // behind. The old path persisted the shell before awaiting ACP and
      // returned it with engineSessionId null when startup went wrong.
      this.#drivers.delete(session.id);
      this.#index.delete(session.id);
      this.#outbox.delete(session.id);
      clearTimeout(this.#reapers.get(session.id));
      this.#reapers.delete(session.id);
      driver?.removeAllListeners?.('event');
      await Promise.resolve(driver?.kill?.()).catch(() => {});
      this.#save();
      throw err;
    }
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
      transcript: s.transcript,
      monitorOnly: !!s.external,
      // Held on the proc host, the process outlives this daemon. The
      // getters answer what the log still has open - read only when the
      // driver actually finds its process there to rebind.
      procHost: this.procs, procId: s.id,
      openTurn: () => this.events.openTurn(s.id)?.turnId ?? null,
      pendingEvents: () => this.events.pending(s.id),
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
    // Slash commands such as /model and /permissions change the same live
    // driver settings as the composer's pickers. Persist them here so every
    // connected client and the next resumed process sees the same choice.
    if (e.type === 'settings') {
      for (const key of ['model', 'effort', 'mode', 'speed']) {
        if (Object.hasOwn(e, key)) s[key] = e[key] || null;
      }
      if (this.#index.has(s.id)) this.#save();
      this.emit('session', s);
      return;
    }
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
      // A settled turn is what a queued message waits behind - even when the
      // turn ended badly. `exited` counts too: delivery respawns the driver,
      // which is how a queue survives the process dying mid-turn. The pump
      // reads s.status to know the agent is free, so it runs after it lands.
      if (status === 'idle') this.#pump(s);
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
   * Opening is deliberately read-only. An inactive row becomes a lightweight
   * transcript-backed Helm record immediately; the provider process is
   * started only when the owner sends a new message. A Codex row with a live
   * writer first becomes a transcript monitor: Codex permits one writer, so
   * Helm either waits for the CLI to close or takes it over explicitly before
   * resuming the thread.
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
      if (s2.engineSessionId === id && (s2.driver || s2.external)) return this.get(s2.id);
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

    // The inventory row is the authority for the transcript path. Do not
    // guess it from the working directory: several old conversations can
    // share one folder, and guessing the newest one is how opening a chat
    // displays the wrong conversation.
    const found = (await inventory(profiles)).find((x) => x.engine === engine && x.id === id);
    if (!found) throw new Error(`that ${engine} conversation is no longer available on this machine; refresh the list`);

    // Opening history must not create a provider process. Besides being
    // wasteful, a cold Devin/OpenCode/Claude process can take long enough to
    // make a perfectly good chat look unopenable. This record is promoted to
    // a driven session by input() on the first real prompt.
    if (!found.active) {
      const session = {
        id: randomBytes(6).toString('hex'),
        profileId: profile.id,
        engine,
        cwd: expand(cwd || found.cwd || '~'),
        title: title || found.title || basename(expand(cwd || '~')),
        titleBy: title ? 'user' : null,
        engineSessionId: id,
        transcript: found.transcript || null,
        external: true,
        externalSource: true,
        externalActive: false,
        adopted: true,
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: found.updatedAt || Date.now(),
      };
      this.#index.set(session.id, session);
      this.#save();
      this.emit('session', session);
      this.#watchTranscript(session.id, session.transcript);
      return session;
    }

    // Codex permits exactly one writer per thread. When a laptop CLI is
    // still holding it, opening from the app is a monitor operation: keep
    // reading that exact rollout and wait to become the writer until the
    // original CLI has gone. Starting app-server here would fail with an
    // active-writer conflict and, worse, make the row look controllable when
    // it is not.
    if (found.active) {
      const externalLock = engine === 'codex'
        ? join(expand(homeOf(profile)), 'thread-writer-locks', `${id}.lock`)
        : null;
      const session = {
        id: randomBytes(6).toString('hex'),
        profileId: profile.id,
        engine,
        cwd: expand(cwd || found.cwd || '~'),
        title: title || found.title || basename(expand(cwd || '~')),
        titleBy: title ? 'user' : null,
        engineSessionId: id,
        transcript: found.transcript,
        externalLock,
        externalPid: found.writerPid || null,
        driver: engine,
        external: true,
        externalSource: true,
        externalActive: true,
        adopted: true,
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: found.updatedAt || Date.now(),
      };
      this.#index.set(session.id, session);
      this.#save();
      this.emit('session', session);
      await this.#importExternalTranscript(session);
      this.#watchTranscript(session.id, session.transcript);
      return session;
    }

    const session = await this.#startDriven({
      cwd: cwd || '~', profile, title: title || null,
      model: null, effort: null, mode: null, auto: null,
      engineSessionId: id, transcript: found?.transcript ?? null,
    });
    session.externalSource = true;
    session.externalImported = 0;
    // app-server resumes with metadata only; the rollout is the source of
    // truth for the conversation that happened before Helm picked it up.
    await this.#importExternalTranscript(session);
    this.#save();
    // Nothing to mark: the row it came from is matched to this session by
    // its engineSessionId and drops out of the list on the next refresh
    // (`dedupeDetected` in the web app), which is also what stops a resumed
    // thread appearing twice.
    return session;
  }

  #externalActive(s) {
    if (!s.external) return false;
    if (s.engine === 'codex') return !!(s.externalLock && existsSync(s.externalLock));
    if (!s.externalPid) return false;
    try { process.kill(s.externalPid, 0); return this.#processOwnsTranscript(s); }
    catch { return false; }
  }

  #processOwnsTranscript(s) {
    if (!s.externalPid || !s.transcript) return false;
    if (s.engine === 'opencode' || s.engine === 'opencode2' || s.engine === 'devin') {
      try {
        const argv = readFileSync(`/proc/${s.externalPid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        const engineAt = argv.findIndex((x) => basename(x) === s.engine || basename(x).startsWith(`${s.engine}.`));
        if (engineAt < 0 || readlinkSync(`/proc/${s.externalPid}/cwd`) !== s.cwd) return false;
        const sub = argv[engineAt + 1];
        if ((s.engine === 'opencode' || s.engine === 'opencode2')
            && ['acp', 'serve', 'run', 'stats', 'api', 'service'].includes(sub)) return false;
        return !(s.engine === 'devin' && sub === 'acp');
      } catch { return false; }
    }
    const dir = `/proc/${s.externalPid}/fd`;
    let fds;
    try { fds = readdirSync(dir); } catch { return false; }
    return fds.some((fd) => {
      try { return readlinkSync(join(dir, fd)) === s.transcript; } catch { return false; }
    });
  }

  /** Release the external writer as part of the first send from Helm. */
  async #handoffExternal(s) {
    if (!this.#externalActive(s)) return;
    if (!this.#processOwnsTranscript(s)) {
      throw new Error(`Helm cannot identify the external ${s.engine} process safely; close it on the machine first`);
    }
    process.kill(s.externalPid, 'SIGTERM');
    const deadline = Date.now() + 8_000;
    while (this.#externalActive(s) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.#externalActive(s)) throw new Error(`the external ${s.engine} process did not release the session`);
    s.externalActive = false;
    s.updatedAt = Date.now();
    this.#save();
    this.emit('session', s);
  }

  /** Seed Helm's event view with the transcript it was monitoring. */
  async #importExternalTranscript(s) {
    const running = this.#imports.get(s);
    if (running) return running;
    const work = this.#readExternalTranscript(s);
    this.#imports.set(s, work);
    try { return await work; } finally { this.#imports.delete(s); }
  }

  async #readExternalTranscript(s) {
    if (!s.transcript) return;
    const messages = await readMessages({
      engine: s.engine, path: s.transcript, sessionId: s.engineSessionId, all: true,
    });
    const imported = Math.min(s.externalImported ?? 0, messages.length);
    const nextId = () => `imported-${randomBytes(8).toString('hex')}`;
    const append = (event) => {
      const saved = this.events.append(s.id, event);
      s.lastSeq = saved.seq;
      this.emit('event', { id: s.id, event: saved });
    };
    // SQLite providers update the final message row in place while it
    // streams, so the message count does not move. Extend the already drawn
    // item when its persisted snapshot grows instead of waiting for the next
    // message (or drawing the whole answer a second time).
    if (imported === messages.length) {
      const last = messages.at(-1), tail = s.externalTail;
      if (last?.role === 'assistant' && last.sourceId && tail?.sourceId === last.sourceId) {
        const text = last.text ?? '';
        if (tail.itemId && text.startsWith(tail.text ?? '') && text.length > (tail.text?.length ?? 0)) {
          append({ type: 'item.delta', id: tail.itemId, turnId: tail.turnId, text: text.slice((tail.text ?? '').length) });
        }
        for (const tool of (last.tools ?? []).slice(tail.tools ?? 0)) {
          const itemId = nextId();
          append({ type: 'item.start', id: itemId, turnId: tail.turnId, kind: 'tool', name: tool.name, input: tool.input });
          append({ type: 'item.done', id: itemId, turnId: tail.turnId, status: 'ok' });
        }
        tail.text = text;
        tail.tools = last.tools?.length ?? 0;
        if (this.#index.has(s.id)) this.#save();
      }
      return;
    }
    let turnId = null;
    const close = () => {
      if (!turnId) return;
      append({ type: 'turn.done', turnId, status: 'ok', imported: true });
      turnId = null;
    };
    for (const message of messages.slice(imported)) {
      if (message.role === 'user') {
        close();
        s.externalTail = null;
        turnId = nextId();
        append({ type: 'turn.start', turnId, text: message.text ?? '', imported: true });
        continue;
      }
      if (!turnId) {
        turnId = nextId();
        append({ type: 'turn.start', turnId, text: '', imported: true });
      }
      for (const tool of message.tools ?? []) {
        const itemId = nextId();
        append({ type: 'item.start', id: itemId, turnId, kind: 'tool', name: tool.name, input: tool.input });
        append({ type: 'item.done', id: itemId, turnId, status: 'ok' });
      }
      let textItemId = null;
      if (message.text) {
        textItemId = nextId();
        append({ type: 'item.start', id: textItemId, turnId, kind: 'text' });
        append({ type: 'item.delta', id: textItemId, turnId, text: message.text });
        append({ type: 'item.done', id: textItemId, turnId, status: 'ok' });
      }
      if (message.sourceId) s.externalTail = {
        sourceId: message.sourceId, turnId, itemId: textItemId,
        text: message.text ?? '', tools: message.tools?.length ?? 0,
      };
    }
    close();
    s.externalImported = messages.length;
    if (this.#index.has(s.id)) this.#save();
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
    // "Stop" stops the queue too, and before the driver is asked: a settled
    // turn is what wakes the pump, so a stop that left the queue intact
    // would fire the next message the moment the interrupt landed. Each
    // waiting bubble disappears because the agent never saw it. Only the
    // actual turn in flight ends as interrupted and earns a "stopped" line.
    const queued = this.#outbox.get(id) ?? [];
    this.#outbox.delete(id);
    for (const item of queued) {
      const event = this.events.append(id, { type: 'turn.remove', turnId: item.turnId });
      this.emit('event', { id, event });
    }
    const s = this.#index.get(id);
    if (s && queued.length) s.lastSeq = this.events.last(id);
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
        // SQLite writes live updates to a WAL while another CLI is open.
        // Watching only the main database makes OpenCode/Devin appear frozen
        // until their process checkpoints or exits.
        const wal = await stat(`${path}-wal`).catch(() => null);
        const stamp = `${size}:${mtimeMs}:${wal?.size ?? 0}:${wal?.mtimeMs ?? 0}`;
        if (t.size !== -1 && stamp !== t.size) this.emit('transcript', { id });
        if (t.size !== -1 && stamp !== t.size) {
          const session = this.#index.get(id);
          if (session?.external && session.driver) await this.#importExternalTranscript(session);
        }
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
    if (s.external) {
      await this.#importExternalTranscript(s);
      const portableInfo = !raw && !attachments.length ? await this.#providerInfo(s, text, true) : null;
      if (portableInfo) {
        const turnId = `local-${randomBytes(6).toString('hex')}`;
        this.#emitLocal(s, turnId, text.trim(), portableInfo);
        return { ok: true };
      }
      const inspectOnly = !raw && !attachments.length && s.engine === 'codex' && canInspectExternalCodex(text);
      if (inspectOnly) {
        // This changes only Helm's renderer: the external CLI remains the
        // writer and keeps running. The driver is connected for account reads
        // such as /usage but does not resume the thread.
        s.driver = s.engine;
        s.updatedAt = Date.now();
        this.#save();
        this.emit('session', s);
      } else {
        await this.#handoffExternal(s);
      // Ownership has moved naturally: turn the monitor into the same driven
      // session instead of creating a duplicate row or losing its transcript.
        s.external = false;
        s.externalActive = false;
        s.adopted = false;
        s.externalLock = null;
        s.driver = s.engine;
        s.mode ??= defaultMode(s.engine);
        s.notifyDone = true;
        s.updatedAt = Date.now();
        this.#drivers.get(s.id)?.enableWriting?.();
        this.#save();
        this.emit('session', s);
      }
    }
    // A historical provider session remains marked after Helm resumes it so
    // /status and /usage can be answered from that provider's persisted
    // record without spending a model turn. Codex has its richer app-server
    // implementation, including account rate limits, so it is left alone.
    if (!raw && !attachments.length && s.externalSource) {
      const body = await this.#providerInfo(s, text, false);
      if (body) {
        const turnId = `local-${randomBytes(6).toString('hex')}`;
        this.#emitLocal(s, turnId, text.trim(), body);
        return { ok: true };
      }
    }
    // Mark the chat synchronously, before starting/resuming a driver can
    // yield. A user can send and immediately navigate back; the navigation's
    // discard request must never overtake that first message and erase it.
    if (!raw && s.engine !== 'shell' && !s.hasInput) {
      s.hasInput = true;
      this.#save();
    }
    if (s.driver) {
      let clean = text.replace(/\n$/, '');
      // Helm-owned commands are intercepted here. Commands advertised by
      // the agent continue to the driver, which is the only component that
      // knows their version-specific semantics.
      let compact = null;
      if (!raw) {
        const slash = /^\/(compact)(?:\s+(.*?))?\s*$/s.exec(text.trim());
        if (slash) compact = (slash[2] ?? '').trim();
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
      // be naming it after helm rather than after the work. A slash command
      // is a verb for the CLI, not a description of the work - "/status"
      // must never become the thread's title.
      if (!raw && !clean.trimStart().startsWith('/')) this.#prompted(s, clean);
      if (brainLine) clean = `${brainLine}\n\n${clean}`;

      const turnId = `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const item = { turnId, text: clean, images, compact };
      // Sideband commands are app-server or local reads that run beside an
      // active turn rather than behind it. Busy is a turn in flight, a
      // prompt waiting on the owner, or a send still being written - the
      // cases where the message takes a ticket instead. Both are settled
      // here, before the optimistic bubble, because it is the bubble that
      // tells the client which this message was: the `local-` id alone
      // cannot, since the first send into an idle session is briefly local
      // too without ever having waited.
      const sideband = !raw && compact == null && !images.length && d.canRunWhileBusy?.(clean);
      const busy = !sideband && (this.#sending.has(s.id) || s.status === 'working' || s.status === 'blocked');
      if (compact != null) {
        // `/compact` is a command, not a prompt, so its bubble is a closed
        // one-liner rather than a turn that waits on the agent's echo.
        this.#emitLocal(s, turnId, `/compact${compact ? ` ${compact}` : ''}`);
      } else {
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
        const event = this.events.append(id, {
          type: 'turn.start', turnId, text: clean, queued: busy,
          ...(sideband ? { local: true } : {}),
          attachments: images.map((a) => this.events.putAttachment(id, a)),
        });
        s.lastSeq = event.seq;
        this.emit('event', { id, event });
      }

      // These Codex commands are app-server or local reads, not model turns.
      // Run them beside the active turn so checking status or usage neither
      // queues behind it nor clears its working state and Stop control.
      if (sideband) {
        await this.#deliver(s, item, d);
        return { ok: true };
      }
      // The message takes a ticket and `#pump` hands it to the agent once
      // the turn settles - the same thing typing into a busy CLI does, on
      // engines whose own queue would drop it instead.
      if (busy) {
        const q = this.#outbox.get(s.id) ?? [];
        q.push(item);
        this.#outbox.set(s.id, q);
        return { ok: true };
      }
      this.#sending.add(s.id);
      try {
        await this.#deliver(s, item, d);
      } finally {
        this.#sending.delete(s.id);
        this.#pump(s);
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

  /**
   * The markdown a /status or /usage answers with for a session whose CLI
   * is not under helm's driver - an external session being monitored, or a
   * historical one. Devin's /usage is its quota card, fetched live the way
   * the TUI fetches it; everything else is the transcript snapshot. Null
   * means "not an info command" - the caller keeps going down input's path.
   */
  async #providerInfo(s, text, monitored) {
    const m = /^\/(status|usage)\s*$/i.exec(text.trim());
    if (!m || s.engine === 'codex') return null;
    if (s.engine === 'devin' && m[1].toLowerCase() === 'usage') {
      const profile = (await getProfiles()).find((p) => p.id === s.profileId);
      const env = profile ? materialize(profile).env : {};
      try {
        return await devinUsageReport({ transcript: s.transcript, engineSessionId: s.engineSessionId, env });
      } catch (err) {
        return `*${String(err?.message || err)}*`;
      }
    }
    return sessionSnapshot({
      engine: s.engine, path: s.transcript, sessionId: s.engineSessionId, cwd: s.cwd, monitored,
    });
  }

  /**
   * Hand one message to the agent.
   *
   * The driver is the authority on whether this agent can see an image: it
   * is the one that spoke to the CLI. Anything else gets a filename
   * placeholder in the text, which is always safe while lost bytes are not -
   * but it says so out loud rather than dropping them silently.
   */
  async #deliver(s, item, d = null) {
    d ??= await this.#driver(s);
    try {
      if (item.compact != null) {
        await d.compact(item.compact);
      } else if (item.images.length && driverTakesImages(d)) {
        await d.sendWithAttachments(item.text, item.images);
      } else {
        let msg = item.text;
        if (item.images.length) {
          const names = item.images.map((a) => `[image: ${a.filename || 'image'} - this agent cannot see images]`).join('\n');
          msg = msg ? `${msg}\n${names}` : names;
          this.events.append(s.id, {
            type: 'error', kind: 'attachment',
            message: item.images.length === 1
              ? `${s.engine} cannot be sent images, so ${item.images[0].filename || 'the image'} was named but not attached.`
              : `${s.engine} cannot be sent images, so ${item.images.length} attachments were named but not sent.`,
          });
        }
        await d.send(msg);
      }
    } catch (err) {
      // The send never reached the agent. The bubble stays - it is what
      // the owner wrote - but it closes failed rather than hanging as a
      // message that looks merely unanswered, and the error travels back
      // to the client so the draft is offered again.
      const failed = this.events.append(s.id, {
        type: 'turn.done', turnId: item.turnId, status: 'error',
        error: String(err?.message || err),
      });
      s.lastSeq = failed.seq;
      this.emit('event', { id: s.id, event: failed });
      throw err;
    }
  }

  /**
   * Give the agent the next queued message, if it can take one.
   *
   * Called when a turn settles (`#onDriverEvent`) and after every delivery.
   * Each send is awaited before the next is considered, and the loop stops
   * as soon as the agent reports itself busy again - which for a real driver
   * is before `send` even returns, so a queue drains one turn at a time, in
   * the order the messages were typed.
   */
  #pump(s) {
    if (this.#sending.has(s.id)) return;
    const q = this.#outbox.get(s.id);
    if (!q?.length) return;
    if (s.status === 'working' || s.status === 'blocked') return;
    this.#sending.add(s.id);
    (async () => {
      try {
        for (;;) {
          const next = this.#outbox.get(s.id)?.[0];
          if (!next) break;
          // A killed session drops what it was holding: its event log is
          // gone, so there is no turn to close the message against anyway.
          if (!this.#index.has(s.id)) { this.#outbox.delete(s.id); break; }
          if (s.status === 'working' || s.status === 'blocked') break;
          try {
            await this.#deliver(s, next);
          } catch {
            // The turn already failed loudly, with a resend waiting on it.
            // The queue moves on - a dead agent fails each send on its own
            // merits rather than eating the rest of the queue silently.
          }
          this.#outbox.get(s.id)?.shift();
        }
      } finally {
        this.#sending.delete(s.id);
      }
    })();
  }

  /**
   * Take back a message still waiting in the queue.
   *
   * The CLI version of this is pulling the text back into the input box
   * before the agent ever sees it: the bubble closes as interrupted - it was
   * stopped, before it was sent - and the caller gets the words back for the
   * draft. A turnId the queue no longer holds already went out, so that is
   * `found: false` rather than an error.
   */
  dequeue(id, turnId) {
    const s = this.get(id);
    const q = this.#outbox.get(id) ?? [];
    const i = q.findIndex((x) => x.turnId === turnId);
    if (i < 0) return { ok: true, found: false };
    const [item] = q.splice(i, 1);
    const event = this.events.append(id, { type: 'turn.remove', turnId });
    s.lastSeq = event.seq;
    this.emit('event', { id, event });
    return { ok: true, found: true, text: item.text };
  }

  /**
   * Hand a queued message to the turn already running, without stopping it.
   *
   * Only engines with a real steering primitive get this - codex's
   * app-server turn/steer is the one that exists today - so the capability
   * is the method existing on the driver, not a flag. Where it does not
   * exist the refusal lands before the queue is touched: Claude's print
   * stream would queue a second frame as its own later turn and ACP v1 has
   * no safe equivalent, and faking either would mislabel the promise.
   *
   * `#sending` is held across the steer so a turn settling mid-call cannot
   * let `#pump` hand the same ticket to the agent twice. `turn.accept` is
   * the event that lands instead of a close: the message went out, so its
   * bubble is promoted into the transcript rather than marked stopped.
   */
  async sendNow(id, turnId) {
    const s = this.get(id);
    const q = this.#outbox.get(id) ?? [];
    const i = q.findIndex((x) => x.turnId === turnId);
    if (i < 0) return { ok: true, found: false, sent: false };
    const item = q[i];
    const d = this.#drivers.get(id);
    if (typeof d?.steer !== 'function') {
      throw new Error(`${s.engine} cannot send a queued message into the current turn`);
    }
    if (this.#sending.has(s.id)) throw new Error('message is already being sent');
    this.#sending.add(s.id);
    try {
      await d.steer(item.text, item.images);
      // A withdraw or a queue-clearing interrupt may have landed while the
      // steer was in flight: take the ticket out by id, not by position.
      const rest = this.#outbox.get(s.id);
      if (rest) {
        const j = rest.findIndex((x) => x.turnId === turnId);
        if (j >= 0) rest.splice(j, 1);
        if (!rest.length) this.#outbox.delete(s.id);
      }
      const event = this.events.append(id, { type: 'turn.accept', turnId });
      s.lastSeq = event.seq;
      this.emit('event', { id, event });
      return { ok: true, found: true, sent: true };
    } finally {
      this.#sending.delete(s.id);
      this.#pump(s);
    }
  }

  /** A turn helm itself speaks: appended and pushed like any driver event. */
  #emitLocal(s, turnId, text, body = null) {
    const itemId = `local-${turnId}`;
    const evs = [
      { type: 'turn.start', turnId, text, local: true },
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
    if (s.external) {
      // Close only Helm's monitor. The external CLI and its transcript are
      // deliberately untouched; its inventory row can be opened again.
      const d = this.#drivers.get(id);
      this.#drivers.delete(id);
      await d?.kill?.();
      this.#index.delete(id);
      this.#save();
      this.emit('session', { ...s, status: 'exited', alive: false });
      return { ok: true };
    }
    if (s.driver) {
      const d = this.#drivers.get(id);
      this.#drivers.delete(id);
      this.#outbox.delete(id);
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

  /**
   * Remove a chat that was opened but never used.
   *
   * This check belongs on the machine, not in the browser: another device
   * may have sent the first prompt after this device last refreshed its
   * session record. Navigation can therefore ask unconditionally and the
   * authoritative input marker makes the operation harmless once the chat
   * contains anything. Brains and terminals are persistent entry points,
   * not throwaway chats, and are deliberately excluded.
   */
  async discardEmpty(id) {
    const s = this.#index.get(id);
    if (!s || s.brain || s.engine === 'shell' || s.pty || s.hasInput || (s.prompts ?? 0) > 0) {
      return { ok: true, discarded: false };
    }
    await this.kill(id);
    return { ok: true, discarded: true };
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
   * Whether this thread should announce completed turns. Driven sessions are
   * born on; the owner can silence an individual thread from its header.
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
    // The proc host's hello carries which agent processes survived; resume()
    // reads that list to leave their open turns and questions standing.
    await this.procs.ensure({ spawn: false }).catch(() => false);
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

  /**
   * A hosted agent process died while detached, or with no driver ever
   * bound after a restart. The turns and questions it left open are
   * unanswerable now - close them the way `resume` does for a dead process.
   */
  #procGone(id) {
    const s = this.#index.get(id);
    if (!s?.driver || this.#drivers.has(id)) return;
    const tail = this.events.tail(id, 0);
    const closed = new Set(tail.filter((e) => e.type === 'turn.done').map((e) => e.turnId));
    for (const e of tail) {
      if (e.type !== 'turn.start' || closed.has(e.turnId)) continue;
      closed.add(e.turnId);
      this.events.append(id, { type: 'turn.done', turnId: e.turnId, status: 'interrupted', error: 'agent exited' });
    }
    for (const p of this.events.pending(id)) {
      this.events.append(id, { type: 'permission.resolved', requestId: p.requestId, decision: 'cancelled' });
    }
    if (s.status === 'idle') return;
    s.status = 'idle';
    s.updatedAt = Date.now();
    const event = this.events.append(id, { type: 'status', status: 'idle' });
    s.lastSeq = event.seq;
    this.emit('event', { id, event });
    this.emit('session', s);
    this.#save();
  }

  /** Re-watch every surviving pane after a daemon restart. */
  resume() {
    for (const s of this.#index.values()) {
      // A terminal lives in the host process, which outlives us - so its
      // record stays until `adoptTerminals()` has asked what really survived.
      if (s.pty) continue;
      if (!s.driver) { this.runtime.watch(this.#handle(s)); continue; }
      // An agent process the host kept is still running whatever it was
      // running: its last open turn may be live and its questions still
      // answerable, so neither gets closed. Earlier open turns are another
      // matter - only one prompt is ever in flight, so those were queued
      // messages that never reached the agent.
      if (this.procs.hasProc(s.id)) {
        const tail = this.events.tail(s.id, 0);
        const closed = new Set(tail.filter((e) => e.type === 'turn.done').map((e) => e.turnId));
        const open = tail.filter((e) => e.type === 'turn.start' && !closed.has(e.turnId)).map((e) => e.turnId);
        open.pop();
        for (const turnId of open) {
          this.events.append(s.id, { type: 'turn.done', turnId, status: 'interrupted', error: 'helm restarted' });
        }
        continue;
      }
      // The process that asked died with the previous daemon; a prompt it
      // left open cannot be answered any more, so close it out here rather
      // than show a phone a question nobody can act on.
      for (const p of this.events.pending(s.id)) {
        this.events.append(s.id, { type: 'permission.resolved', requestId: p.requestId, decision: 'cancelled' });
      }
      // Every turn left open died with the previous daemon: a running turn's
      // agent is gone, and a message still in the queue never sent. Scan the
      // tail rather than asking `openTurn`, which only finds the last one -
      // with several queued, each earlier bubble would hang "queued" forever.
      const tail = this.events.tail(s.id, 0);
      const closed = new Set(tail.filter((e) => e.type === 'turn.done').map((e) => e.turnId));
      for (const e of tail) {
        if (e.type !== 'turn.start' || closed.has(e.turnId)) continue;
        closed.add(e.turnId);
        this.events.append(s.id, { type: 'turn.done', turnId: e.turnId, status: 'interrupted', error: 'helm restarted' });
      }
      if (s.status !== 'idle') {
        s.status = 'idle';
        s.updatedAt = Date.now();
        // The log is what a viewer replays for status: closing the turns
        // above without recording the settle leaves the last `working`
        // standing, and the session reads as busy until the next turn.
        const event = this.events.append(s.id, { type: 'status', status: 'idle' });
        s.lastSeq = event.seq;
        this.emit('event', { id: s.id, event });
        this.emit('session', s);
      }
    }
    this.#save();
  }

  /** Daemon going away: hosted procs stay up, local ones die as before. */
  async stop() {
    await Promise.allSettled([...this.#drivers.values()].map((d) => d.suspend?.() ?? d.kill()));
    this.#drivers.clear();
  }
}
