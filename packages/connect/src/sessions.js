import { mergeUsageLimits } from './usage-recovery.js';
import { reportedMode } from './native-settings.js';
import { BASH_GUARD_MODES } from './pi-settings.js';
import { nativeAccount } from './native-account.js';
import { nativeCommands, nativeSettingCommand } from './native-controls.js';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HELM_DIR, expand, quickDir, isQuickDir } from './paths.js';
import { Checkpoints } from './checkpoints/store.js';
import { getProfiles, loadProfiles, materialize } from './profiles.js';
import { nativeActive } from './native-subagents.js';
import { nonAgentClaudeTask, claudeServiceTasks } from './claude-tasks.js';
import { ENGINES } from './engines.js';
import { localDigest, pathWithShim } from './brain.js';
import { forWire } from './events.js';
import { optionArgs, peekModels, listModels, followNewModels } from './models.js';
import { modelPrefs, startPrefs, saveModelPrefs, accountKey } from './settings.js';
import { EventLog } from './events.js';
import { nativeCodexSocket } from './drivers/codex.js';
import { defaultMode, modeFromAuto } from './modes.js';
import { ModeFooter, MODE_FROM_LABEL } from './native-mode.js';
import { TerminalHost, NativeHosts, PROC_SOCKET_PATH } from './terminals.js';
import { inventory, scratchFolder } from './inventory.js';
import { opencodeServiceSessions } from './opencode-service.js';
import { claudeLiveSessions, claudeLiveStatus, descendsFrom, dedupeNativeConversations } from './external-process.js';
import { readProcess } from './takeover.js';
import { startHookServer } from './claude-hooks.js';
import { gitBranch, worktreeHome } from './git-head.js';
import { AccountLimits } from './account-limits.js';
import { CLAUDE_NATIVE_COMMANDS } from './commands.js';
import { canvasPath } from './git.js';
import { validateVisual } from './visual.js';
import { DeliveryState } from './delivery-state.js';
import { DRIVERS, pendingSummary, wire } from './session-wire.js';
import { driverTakesImages } from './session-attachments.js';
import { missingClaudeConversation, parentLink } from './session-text.js';
import { SessionTitles } from './session-titles.js';
import { SessionRewind } from './session-rewind.js';
import { SessionSubagents } from './session-subagents.js';
import { SessionDelegation } from './session-delegation.js';
import { SessionViewers } from './session-viewers.js';
import { LimitRecovery } from './session-limits.js';
import { SessionResume } from './session-resume.js';
import { ExternalSessions } from './session-external.js';
import { NativeSessions } from './session-native.js';
import { DriverEvents } from './session-driver-events.js';
import { SessionDelivery } from './session-delivery.js';
import { SessionWorktrees } from './session-worktrees.js';
import { runSetup } from './chat-worktree.js';
import { projectKeysFor } from './project-key.js';

export { DRIVERS, wire } from './session-wire.js';
export { driverTakesImages, acceptAttachments, saveUploads, acceptImages } from './session-attachments.js';
export { transcriptEvents } from './session-transcript-events.js';
export { priceTurn } from './session-driver-events.js';

const INDEX_FILE = join(HELM_DIR, 'sessions.json');
/**
 * Changes to the index are written at most this often. The file is a couple
 * of megabytes on a busy machine and took ~15 ms to write, and it was written
 * on every status change, turn end and setting, so a burst of them held the
 * daemon for whole frames. stop(), process exit and any reader in this
 * process (a second Sessions loading the file) flush first; a step that must
 * be on disk before its next move calls flush() itself.
 */
const SAVE_DELAY_MS = 250;
/** Writes waiting for their timer, across every Sessions in this process. */
const pendingSaves = new Set();
/** Put every waiting index write on disk now. */
export function flushSessionIndex() {
  for (const flush of [...pendingSaves]) flush();
}
process.on('exit', flushSessionIndex);
// A headless agent that has been idle this long is closed; the next message
// resumes the same conversation, so nothing is lost but the warm process.
const IDLE_REAP_MS = 30 * 60_000;
const DELEGATION_IDLE_MS = 30_000;

/**
 * Rows helm does not own: a herdr pane it did not start (`pane:`), and a past
 * session read out of a CLI's own history (`found:`). They are real work and
 * belong in the list, but helm has no record of its own to archive or delete -
 * so what the owner does with one is kept beside the sessions as a mark.
 */
const EXTERNAL = /^(pane:|found:)/;
/** A look at a chat Helm did not start is forgotten after this long. */
const SEEN_KEEP_MS = 30 * 86_400_000;

const EXTERNAL_INFO_COMMANDS = [
  { name: 'status', description: 'Show chat settings and usage', source: 'helm' },
  { name: 'usage', description: 'Show saved text usage for this chat', source: 'helm' },
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
export class Sessions extends EventEmitter {
  // Session updates can arrive after archive from provider and recovery tasks.
  // Apply the same helper visibility rule as list() to every published update.
  emit(kind, ...args) {
    if (kind === 'session' && args[0]?.delegations) args[0] = { ...args[0], delegations: this.#delegation.visibleDelegations(args[0]) };
    return super.emit(kind, ...args);
  }
  #index = new Map();
  /** paneId -> what the runtime last told us about a pane we do not own */
  #adopted = new Map();
  /** sessionId -> live driver */
  #drivers = new Map();
  checkpoints = new Checkpoints();
  /** sessionId -> reap timer */
  #reapers = new Map();
  /** A resumed task waits for its previous process to finish releasing. */
  #retiring = new Map();
  /** external id -> 'archived' | 'removed', for rows helm does not own */
  #marks = new Map();
  /** When the owner last looked at a chat Helm did not start (pane:, found:). */
  #seen = new Map();
  /** When a row was removed, so new activity in its CLI can bring it back. */
  #removedAt = new Map();
  #deliveryState = new DeliveryState();
  /** sessionId -> open command cards (turn.start with local: true). */
  #commandCards = new Map();

  constructor(runtime, { events = new EventLog(), makeDriver = null, log = () => {}, terminals = new TerminalHost(), procHost = null, nativeHost = null, nativeDiscovery = !process.env.HELM_NO_SERVICE, turnSettleMs = 1500, waiterGraceMs = 3000, delegationIdleMs = DELEGATION_IDLE_MS, reattachRetryMs = 90_000, reattachConcurrency = 4 } = {}) {
    super();
    this.#makeParts();
    this.runtime = runtime;
    this.turnSettleMs = turnSettleMs;
    this.waiterGraceMs = waiterGraceMs;
    this.delegationIdleMs = delegationIdleMs;
    this.reattachRetryMs = reattachRetryMs;
    this.reattachConcurrency = reattachConcurrency;
    this.events = events;
    this.limits = new AccountLimits();
    this.log = log;
    this.nativeDiscovery = nativeDiscovery;
    this.makeDriver = makeDriver ?? ((engine, opts) => new DRIVERS[engine](opts));
    this.terminals = terminals;
    this.nativeTerminals = nativeHost ?? new NativeHosts();
    // Agent processes live on a second host behind a second socket, so this
    // feature does not wait on - or cost - whatever the pty host is holding.
    this.procs = procHost ?? new TerminalHost({ socketPath: PROC_SOCKET_PATH, unit: 'helm-procs' });
    this.#load();
    const recovered = this.checkpoints.recover(this.events, this.#index);
    // The journal moves on only once the index it describes is on disk.
    if (recovered.length) { this.#save(); this.flush(); this.checkpoints.finishRecovery(recovered); }
    this.#dropNonAgentTasks();
    // Old hook sockets died with the last daemon. A hook that asks again keeps
    // its card; any other is unanswerable here, and the terminal still asks.
    for (const s of this.#index.values()) if (s.nativeCli) {
      for (const pending of this.events.pending(s.id)) {
        if (!pending.reasks) this.events.append(s.id, { type: 'permission.resolved', requestId: pending.requestId });
      }
    }
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
    this.procs.on('proc.exit', ({ id }) => this.#resumer.procGone(id));
    const footers = new Map();
    this.nativeTerminals.on('data', (d) => {
      this.emit('data', d);
      const s = this.#index.get(d.id);
      if (!s?.nativeChat || s.engine !== 'claude') return;
      let footer = footers.get(d.id);
      if (!footer) footers.set(d.id, footer = new ModeFooter());
      footer.mark(); footer.feed(d.text);
      const mode = MODE_FROM_LABEL[footer.label()];
      if (mode) this.#natives.nativeSettings(s, { mode });
    });
    this.nativeTerminals.on('exit', ({ id }) => footers.delete(id));
    this.nativeTerminals.on('native.open', (s) => this.#natives.adoptNative(s));
    this.nativeTerminals.on('hello', () => {
      for (const s of this.nativeTerminals.nativeSessions()) this.#natives.adoptNative(s);
    });
    this.nativeTerminals.on('exit', ({ id, code }) => {
      const s = this.#index.get(id);
      if (!s?.nativeCli) return;
      for (const [requestId, ask] of this.#natives.hookAsks) if (ask.id === id) {
        ask.reply(null);
        this.#natives.closeHookAsk(requestId);
      }
      // Its conversation lives on in the CLI's history list; a dead row
      // here would only be a second, unusable copy of it.
      this.#index.delete(id);
      this.#save();
      this.emit('exit', { id, code });
      this.emit('session', { ...wire(s), status: 'exited', alive: false });
    });
    for (const s of this.nativeTerminals.nativeSessions()) this.#natives.adoptNative(s);
    this.nativePoll = setInterval(async () => {
      // Chat viewers do not attach xterm. Keep a quiet long-running tool or
      // pending question out of the terminal host's abandoned-CLI reaper.
      for (const s of this.#index.values()) if (s.nativeChat && ['working', 'blocked'].includes(s.status)) {
        this.nativeTerminals.renew(s.id).catch(() => {});
      }
      this.#natives.syncNativeClaude();
      // A CLI's own subagents start while their parent works and can run
      // on in the background after it settles; follow both, nothing idle.
      for (const s of this.#index.values()) {
        if (this.#subagents.hasNative(s) && (['working', 'starting', 'blocked'].includes(s.status) || nativeActive(s.nativeCards))) void this.#subagents.refreshNative(s);
      }
      // New outside O2 tabs have no Helm driver to publish their arrival.
      // Reuse this poll to push a list refresh, including when a tab closes.
      const openCode = JSON.stringify([...(await opencodeServiceSessions())].sort(([a], [b]) => a.localeCompare(b)));
      if (openCode !== this.#openCodeState) {
        this.#openCodeState = openCode;
        this.emit('discovery');
      }
      if (!this.nativeDiscovery) return;
      try {
        await this.nativeTerminals.ensure({ spawn: false });
        await this.#natives.discoverNativeCodex(await getProfiles());
      } catch (err) { this.log(`native CLI discovery: ${err.message}`); }
    }, 2500);
    this.nativePoll.unref?.();
    this.hooks = startHookServer((native, event, reply) => this.#natives.onHook(native, event, reply))
      .then((h) => { h.server.unref(); return h; })
      .catch((err) => { this.log(`claude hooks: ${err.message}`); return null; });
  }

  /**
   * The parts of this class kept in their own files (session-*.js). Each
   * part gets this instance, for what is public, and `core`: shared private
   * state and named operations. Delivery state stays behind its owner.
   */
  #titles;
  #rewinder;
  #subagents;
  #delegation;
  #viewers;
  #limitRecovery;
  #resumer;
  #external;
  #natives;
  #driverEvents;
  #delivery;
  #worktrees;
  #makeParts() {
    const sessions = this;
    const core = {
      index: this.#index,
      drivers: this.#drivers,
      reapers: this.#reapers,
      retiring: this.#retiring,
      marks: this.#marks,
      removedAt: this.#removedAt,
      deliveryState: this.#deliveryState,
      commandCards: this.#commandCards,
      terminal: this.#terminal.bind(this),
      setContext: this.#setContext.bind(this),
      get lastDetected() { return sessions.#lastDetected; },
      inventory: this.#inventory.bind(this),
      handle: this.#handle.bind(this),
      save: this.#save.bind(this),
      flush: () => this.flush(),
      startDriven: this.#startDriven.bind(this),
      driverStarts: this.#driverStarts,
      preparing: this.#preparing.bind(this),
      driver: this.#driver.bind(this),
      bindDriver: this.#bindDriver.bind(this),
      settled: this.#settled.bind(this),
      reap: this.#reap.bind(this),
    };
    core.titles = this.#titles = new SessionTitles(this, core);
    core.rewinder = this.#rewinder = new SessionRewind(this, core);
    core.subagents = this.#subagents = new SessionSubagents(this, core);
    core.delegation = this.#delegation = new SessionDelegation(this, core);
    core.viewers = this.#viewers = new SessionViewers(this, core);
    core.limitRecovery = this.#limitRecovery = new LimitRecovery(this, core);
    core.resumer = this.#resumer = new SessionResume(this, core);
    core.external = this.#external = new ExternalSessions(this, core);
    core.natives = this.#natives = new NativeSessions(this, core);
    core.driverEvents = this.#driverEvents = new DriverEvents(this, core);
    core.delivery = this.#delivery = new SessionDelivery(this, core);
    core.worktrees = this.#worktrees = new SessionWorktrees(this, core);
  }

  #terminal(s) { return s.nativeCli ? this.nativeTerminals : this.terminals; }

  // Usage limits (session-limits.js)
  accountLimits(profiles) { return this.#limitRecovery.accountLimits(profiles); }
  setAutoResumeLimited(id, on) { return this.#limitRecovery.setAutoResumeLimited(id, on); }
  cancelLimitContinuation(session) { return this.#limitRecovery.cancelLimitContinuation(session); }
  startLimitRecovery() { return this.#limitRecovery.startLimitRecovery(); }
  tickLimitRecovery(now) { return this.#limitRecovery.tickLimitRecovery(now); }
  recover(id, options) { return this.#limitRecovery.recover(id, options); }

  /** How full a conversation is: kept on its record, sent to clients as a session update. */
  #setContext(s, used, window, model, full, compacted = false) {
    if (!(window > 0)) return false;
    // Compacted with the new size not yet known: the ring empties and says so.
    if (compacted && !(used > 0)) {
      if (!s.context || s.context.compacted) return false;
      s.context = { ...s.context, used: 0, window, compacted: true, at: Date.now() };
      if (this.#index.has(s.id)) this.emit('session', s);
      return true;
    }
    if (!(used > 0)) return false;
    // `full` is the model's whole window: the menu's "Full" option, and what "Compact at" can never exceed.
    full = full > 0 ? full : undefined;
    model = typeof model === 'string' && model ? model : undefined;
    const was = s.context;
    if (was?.used === used && was?.window === window && was?.model === model && was?.full === full) return false;
    s.context = { used, window, ...(model && { model }), ...(full && { full }), at: Date.now() };
    if (this.#index.has(s.id)) this.emit('session', s);
    return true;
  }

  /** What the last list found, so opening a row it just showed skips a rescan. */
  #lastDetected = null;
  #openCodeState = '[]';

  /** Several screens list at once; one scan of every process serves them. */
  #inventoryScan = null;
  #inventory(profiles) {
    if (this.#inventoryScan) return this.#inventoryScan;
    const work = inventory(profiles);
    this.#inventoryScan = work;
    const done = () => { if (this.#inventoryScan === work) this.#inventoryScan = null; };
    work.then(done, done);
    return work;
  }

  isDriven(s) { return !!s?.driver; }

  /** Ask the live CLI what slash commands it accepts in this session. */
  async commands(id) {
    const s = this.get(id);
    if (s.nativeChat && s.engine === 'claude') return CLAUDE_NATIVE_COMMANDS;
    if (s.nativeCli) return nativeCommands(s.engine);
    if (!s.driver) return [];
    // Starting a second Claude/ACP process merely to populate a menu can
    // contend with the external CLI we are monitoring. These two reads are
    // available immediately; the provider's full dynamic palette appears
    // after Helm owns/resumes the session.
    if (s.external && s.engine !== 'codex') return EXTERNAL_INFO_COMMANDS;
    // A finished helper's worktree is removed once merged. Opening its chat
    // asks for this menu; starting the agent there only wrote a red "folder
    // does not exist" into the chat on every visit.
    if (!this.#drivers.has(s.id) && s.cwd && !existsSync(s.cwd)) return [];
    const driver = await this.#driver(s);
    const available = (await driver.availableCommands?.() ?? []).filter((c) => !['plan', 'plan-mode'].includes(c.name));
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
    // Another Sessions in this process may still hold the newest copy.
    flushSessionIndex();
    if (!existsSync(INDEX_FILE)) return;
    try {
      const raw = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
      for (const s of raw.sessions || []) {
        // Saved outside history uses the same chat and tray as live history.
        // This only chooses its view; the provider stays lazy until input.
        if (s.external && !s.driver && ENGINES[s.engine]?.driver) s.driver = s.engine;
        // Completion notifications are the normal behaviour for driven
        // threads. Preserve an explicit opt-out from an older client.
        if (s.driver && s.notifyDone == null) s.notifyDone = !s.delegation;
        // Legacy planning sessions resume as executable tasks, not a plan gate.
        if (s.driver && s.mode === 'plan') s.mode = defaultMode(s.engine);
        // Whatever was compacting before the daemon stopped has said nothing since.
        delete s.compacting;
        // A clone (or the agent's start after it) the restart cut off: the
        // chat says so and offers to go again.
        if (s.clone && !['done', 'failed'].includes(s.clone.state)) {
          s.clone = { ...s.clone, state: 'failed', error: 'Helm restarted before the repo was in.' };
          if (s.status === 'starting') s.status = 'idle';
        }
        // Its setup command died with the daemon; the agent starts on the
        // next message, in the worktree as it is.
        if (s.chatWorktree?.setup === 'running') {
          s.chatWorktree.setup = 'failed';
          if (s.status === 'starting') s.status = 'idle';
        }
        this.#index.set(s.id, s);
      }
      for (const [id, state] of Object.entries(raw.external || {})) this.#marks.set(id, state);
      for (const [id, at] of Object.entries(raw.seen || {})) if (Number.isFinite(at)) this.#seen.set(id, at);
      for (const [id, at] of Object.entries(raw.removedAt || {})) this.#removedAt.set(id, at);
    } catch { /* a corrupt index must not stop the daemon booting */ }
  }

  /**
   * Older daemons counted commands and passive watches as helpers. Repair
   * their saved working/failed counts without dropping actual helper work.
   */
  #dropNonAgentTasks() {
    let changed = false;
    for (const s of this.#index.values()) {
      if (s.engine !== 'claude' || !Object.keys(s.nativeAgents ?? {}).length) continue;
      let events;
      try { events = this.events.since(s.id, 0); } catch { continue; }
      const services = new Set(events.filter((e) => (e.type === 'item.start' && nonAgentClaudeTask(e))
        || (e.type === 'item.update' && nonAgentClaudeTask(e.agent))).map((e) => e.id));
      const removed = Object.keys(s.nativeAgents).filter((id) => services.has(id));
      for (const id of removed) delete s.nativeAgents[id];
      if (removed.length) { changed = true; this.#delegation.refreshTeam(s); }
      // A long-running shell can finish after its start was trimmed from
      // Helm's log. Read only this conversation, only for unresolved ids.
      const known = new Set(events.filter(e => e.type === 'item.start' || e.type === 'item.update' && e.agent?.type).map(e => e.id));
      const unknown = Object.keys(s.nativeAgents).filter(id => !known.has(id));
      if (unknown.length) {
        const profile = loadProfiles()?.profiles?.find(p => p.id === s.profileId);
        const home = s.nativeHome || s.externalHome || profile?.env?.CLAUDE_CONFIG_DIR || '~/.claude';
        void claudeServiceTasks({ home, cwd: s.cwd, sessionId: s.engineSessionId, ids: unknown }).then(ids => {
          if (this.#index.get(s.id) !== s || !ids.some(id => s.nativeAgents?.[id])) return;
          for (const id of ids) if (s.nativeAgents) delete s.nativeAgents[id];
          this.#delegation.refreshTeam(s);
          this.#save();
        });
      }
    }
    if (changed) this.#save();
  }

  #saveTimer = null;
  #flushSave = () => this.flush();

  /** Mark the index changed; it is written within SAVE_DELAY_MS. */
  #save() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(this.#flushSave, SAVE_DELAY_MS);
    this.#saveTimer.unref?.();
    pendingSaves.add(this.#flushSave);
  }

  /** Write a waiting index change now. Nothing waiting, nothing written. */
  flush() {
    if (!this.#saveTimer) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    pendingSaves.delete(this.#flushSave);
    try {
      mkdirSync(HELM_DIR, { recursive: true });
      writeFileSync(
        `${INDEX_FILE}.tmp`,
        JSON.stringify({
          version: 1,
          // Subagent cards are re-read from Claude's files, never remembered.
          sessions: [...this.#index.values()].map(({ nativeCards, ...s }) => s),
          external: Object.fromEntries(this.#marks),
          seen: Object.fromEntries(this.#seen),
          removedAt: Object.fromEntries(this.#removedAt),
        }),
        { mode: 0o600 }
      );
      renameSync(`${INDEX_FILE}.tmp`, INDEX_FILE);
    } catch (error) {
      // Off the caller's stack now, so a full disk must not end the daemon.
      // The next change tries again.
      this.log(`could not save the session list: ${error.message}`);
    }
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

  async list({ includeDelegations = false, parentId = null, includeDetected = false } = {}) {
    // One chat's helpers are Helm-driven sessions in the index: answer them
    // straight from it, without the process and history scans a full list
    // needs, so the Subagents panel opens at once.
    if (parentId) {
      const children = [...this.#index.values()].filter((s) => !s.archived && s.delegation?.parentId === parentId);
      if (children.every((s) => s.driver && !s.external)) return this.#shape(children.map((s) => this.#drivenRow(s)), { parentId });
    }
    // The runtime is the authority on what is still alive; our index only
    // remembers which of those panes are ours.
    const live = await this.runtime.listLive();
    const profiles = await getProfiles();
    // A hung Codex daemon must not stall every list: after the first, wait
    // a second at most and let the 2.5s poll catch up behind it.
    const discovery = this.#natives.discoverNativeCodex(profiles).catch((err) => this.log(`native CLI discovery: ${err.message}`));
    if (!this.#natives.nativeDiscovered) await discovery;
    else await Promise.race([discovery, new Promise((r) => setTimeout(r, 1000).unref?.())]);
    await this.nativeTerminals.ensure({ spawn: false }).catch(() => false);
    const liveO2 = !parentId && profiles.some((p) => p.engine === 'opencode2')
      ? await opencodeServiceSessions() : null;
    const detected = (includeDetected && !parentId) || [...this.#index.values()].some((s) => s.external || s.nativeCli)
      ? await this.#inventory(profiles)
      : liveO2?.size ? await this.#inventory(profiles.filter((p) => p.engine === 'opencode2')) : [];
    const detectedById = new Map(detected.map((s) => [`${s.engine}:${s.id}`, s]));
    if (detected.length) this.#lastDetected = { at: Date.now(), byId: detectedById };

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
      await this.#external.monitorService(s, detectedById.get(`${s.engine}:${s.engineSessionId}`))
        .catch(err => this.log(`OpenCode 2 monitor: ${err.message}`));
      if (s.external) {
        const profile = profiles.find((p) => p.id === s.profileId);
        s.externalHome = profile?.env?.[ENGINES[s.engine]?.homeEnv] ?? ENGINES[s.engine]?.defaultHome;
        const current = detectedById.get(`${s.engine}:${s.engineSessionId}`);
        if (current) {
          s.externalPid = current.writerPid || null;
          s.externalService = !!current.serviceActive;
          s.transcript = current.transcript || s.transcript;
          s.updatedAt = current.updatedAt;
          if (current.model) s.engineModel = current.model;
          if (current.effort) s.engineEffort = current.effort;
          if (current.mode) s.mode = current.mode;
        }
        const active = this.#external.externalActive(s);
        // This record is a read-only window onto another process until its
        // writer lock goes away. Keep it in the ordinary list so an open app
        // continues to receive transcript notifications across refreshes.
        out.push({
          ...wire(s), alive: active, adopted: true,
          ...await this.#external.refreshExternalActivity(s, active),
          externalActive: active,
        });
        continue;
      }
      if (s.driver) {
        out.push(this.#drivenRow(s));
        continue;
      }
      if (s.pty) {
        const alive = this.#terminal(s).has(s.id);
        if (s.nativeCli && alive) {
          let nativeEnv = null;
          if (s.nativePid) try { nativeEnv = readProcess(s.nativePid).env; } catch { /* exited or unreadable */ }
          const profile = nativeAccount(s, profiles, { env: nativeEnv });
          const owned = (pid) => !!pid && !!s.nativePid && descendsFrom(pid, s.nativePid);
          const claudeOwners = s.engine === 'claude' && s.nativeHome ? claudeLiveSessions(s.nativeHome) : null;
          // Prefer the terminal's actual process over its previous conversation
          // ID: two terminals may have resumed the same transcript.
          const current = detected.find((x) => x.engine === s.engine &&
            (owned(x.writerPid) || claudeOwners?.get(x.id)?.some((owner) => owned(owner.pid))))
            ?? detected.find((x) => x.engine === s.engine && x.id === s.engineSessionId);
          s.profileId = profile?.id ?? null;
          if (current) {
            s.engineSessionId = current.id;
            s.transcript = current.transcript;
            // A live Pi extension is fresher than the append-only transcript.
            if (!s.permissionControl) this.#natives.nativeSettings(s, {
              ...(current.model ? { model: current.model } : {}),
              ...(current.effort ? { effort: current.effort } : {}),
              ...(current.mode ? { mode: current.mode } : {}),
            });
            const owners = claudeOwners?.get(current.id)?.filter((owner) => owned(owner.pid)) ?? [];
            s.status = claudeLiveStatus(owners) ?? current.status ?? s.status;
            s.turns = current.turns;
            if (!s.titleBy) s.title = current.title || s.title;
            s.updatedAt = Math.max(s.updatedAt, current.updatedAt || 0);
            this.#save();
          }
        }
        // A question waiting in a hook outranks what the process record says.
        if ([...this.#natives.hookAsks.values()].some((a) => a.id === s.id)) s.status = 'blocked';
        out.push({ ...wire(s), alive, status: alive ? (s.nativeCli ? s.status : 'shell') : 'exited', adopted: false,
          ...pendingSummary(this.events.pending(s.id)) });
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
    if (!parentId) {
      const known = new Set(out.filter((s) => s.engineSessionId).map((s) => `${s.engine}:${s.engineSessionId}`));
      for (const x of detected) {
        // V2 service chats have no terminal for the native discovery path.
        if (!includeDetected && !x.serviceActive) continue;
        const id = `found:${x.engine}:${x.id}`;
        const mark = this.#marks.get(id);
        // Removed stays removed - unless it was used again in a terminal since.
        const reused = mark === 'removed' && this.#removedAt.get(id) && x.updatedAt > this.#removedAt.get(id) + 60_000;
        if ((mark === 'removed' && !reused) || known.has(`${x.engine}:${x.id}`) || this.isDelegatedConversation(x.engine, x.id)) continue;
        // A test's chat under /tmp is not one the owner had.
        if (scratchFolder(x.cwd)) continue;
        // A shared V2 service can own several exact IDs in the same folder.
        // Only terminal-owned chats can use the folder fallback.
        if (x.active && !x.serviceActive && out.some((s) => s.paneId && s.alive && s.engine === x.engine && expand(s.cwd) === expand(x.cwd))) continue;
        out.push({ id, engine: x.engine, engineSessionId: x.id, account: x.account,
          title: x.title, cwd: x.cwd, quick: isQuickDir(x.cwd) || undefined, profileId: x.account, model: x.model, engineModel: x.model, engineEffort: x.effort, mode: x.mode,
          status: x.status, turns: x.turns, alive: !!x.active, externalActive: !!x.active,
          adopted: true, archived: mark === 'archived', updatedAt: x.updatedAt, seenAt: this.#seen.get(id) });
      }
    }
    // A session's own subagents are found once here, then followed by the
    // poll; the first read lands as a session event, not a wait. One at a
    // time: just after a start that is every chat on the machine at once.
    for (const s of this.#index.values()) {
      if (this.#subagents.hasNative(s) && !s.archived && !this.#subagents.native.has(s.id)) this.#subagents.firstNativeRead(s);
    }
    return this.#shape(out, { parentId, includeDelegations });
  }

  /** A Helm-driven session as a list row. */
  #drivenRow(s) {
    return { ...wire(s), archived: !!s.archived, alive: s.nativeSocket ? !!this.#drivers.get(s.id)?.nativeConnected : this.#drivers.has(s.id), adopted: false, ...pendingSummary(this.events.pending(s.id)) };
  }

  /** Filter, decorate and order list rows. */
  #shape(out, { parentId = null, includeDelegations = false } = {}) {
    // Anything waiting on a human floats to the top; that is the whole point
    // of watching from a phone.
    const rank = (x) => (x.status === 'blocked' ? 0 : x.status === 'working' ? 1 : 2);
    return dedupeNativeConversations(out.filter((s) => !s.delegation?.hidden && (parentId ? !s.archived && s.delegation?.parentId === parentId : includeDelegations || !s.delegation || this.#delegation.unhomedDelegation(s))))
      .map((s) => s.delegations ? { ...s, delegations: this.#delegation.visibleDelegations(s) } : s)
      .map((s) => (s.delegation && this.#delegation.unhomedDelegation(s) ? { ...s, unhomed: true } : s))
      // The branch each thread's folder is on, for the sidebar's third line.
      // A chat in a worktree also says where the repo it came from is, so a
      // new chat "here" starts there (the new-chat keys).
      .map((s) => {
        if (!s.cwd || s.quick || this.#preparing(s)) return s;
        const home = worktreeHome(s.cwd);
        return { ...s, branch: gitBranch(s.cwd), ...(home ? { worktreeHome: home } : {}) };
      })
      .sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  // Helpers a chat delegates to (session-delegation.js)
  dismissChildFailures(id) { return this.#delegation.dismissChildFailures(id); }
  isDelegatedConversation(engine, id) { return this.#delegation.isDelegatedConversation(engine, id); }
  hasActiveDelegations(id) { return this.#delegation.hasActiveDelegations(id); }
  delegate(options) { return this.#delegation.delegate(options); }
  delegationResult(id, options) { return this.#delegation.delegationResult(id, options); }
  messageDelegation(parentId, id, data) { return this.#delegation.messageDelegation(parentId, id, data); }

  // A CLI's own subagents (session-subagents.js)
  nativeAgent(id, agentId, options) { return this.#subagents.nativeAgent(id, agentId, options); }
  messageNative(id, agentId, text) { return this.#subagents.messageNative(id, agentId, text); }

  canReturnTask(id) {
    return ['idle', 'done'].includes(this.get(id).status)
      && !this.#deliveryState.isSending(id) && !this.#deliveryState.hasSettling(id) && !this.get(id).queuePaused && !this.#deliveryState.hasQueue(id)
      && !this.events.activeTurn(id) && !this.events.pending(id).length && !this.hasActiveDelegations(id);
  }

  // Rewind and fork (session-rewind.js)
  rewindCheck(id, turnId) { return this.#rewinder.rewindCheck(id, turnId); }
  rewind(id, turnId, options) { return this.#rewinder.rewind(id, turnId, options); }
  fork(id, turnId) { return this.#rewinder.fork(id, turnId); }

  /** A new chat is on disk before anyone is told it exists. */
  async start(options) {
    try { return await this.#start(options); } finally { this.flush(); }
  }

  async #start({ cwd, quick = false, profileId, title, model, auto, effort, mode, speed, brain = false, parent = null, originHandoffId = null, delegation = null, originAutomationId = null, clone = null }) {
    if (originAutomationId != null) {
      if (!/^[A-Za-z0-9._:-]{1,120}$/.test(originAutomationId)) throw new Error('invalid automation identity');
      const existing = this.findAutomationSession(originAutomationId);
      if (existing) return existing;
    }
    if (originHandoffId !== null && !/^[a-f0-9]{24}$/.test(originHandoffId)) {
      throw new Error('invalid origin handoff id');
    }
    if (quick && cwd) throw new Error('a quick chat has no folder: send quick or cwd, not both');
    if (!quick && !cwd) throw new Error('which folder? send cwd, or quick for a chat with no folder');
    this.#rewinder.assertRewindUnlocked(null, cwd ? expand(cwd) : null);
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`unknown profile: ${profileId}`);
    if (quick && (brain || delegation || !ENGINES[profile.engine]?.driver)) {
      throw new Error(`${profile.label || profile.engine} cannot start a quick chat: only agents helm drives can`);
    }
    // The account's configured default is what a new session starts with; a
    // model chosen up front always wins.
    if (!model) {
      // A model released since a picker was last opened still becomes the
      // default before this chat starts - from the held catalogue only, so a
      // start never waits on a CLI.
      let held = null;
      try {
        const eng = ENGINES[profile.engine], spec = materialize(profile);
        const home = spec.env?.[eng?.homeEnv] ?? eng?.defaultHome;
        const launcher = profile.wraps ? { cmd: spec.cmd, args: spec.args } : null;
        held = peekModels(profile.engine, home, launcher);
        // OpenCode's own pick can sit behind a refused sign-in (models.js
        // startModel), so its first chat after a restart reads the list once.
        if (!held && /^opencode2?$/.test(profile.engine)) {
          held = await Promise.race([listModels(profile.engine, home, spec.env, launcher),
            new Promise((done) => setTimeout(done, 5_000, null))]).catch(() => null);
        }
        followNewModels(profile, held);
      } catch { /* the default as it was is still fine */ }
      // With no default of its own, a CLI whose pick sits behind a refused
      // sign-in starts on a model that works.
      model = modelPrefs(profile)?.default ?? held?.startModel ?? null;
    }
    const defaults = startPrefs(profile) ?? {};
    if (!effort) effort = defaults.effort ?? null;
    if (mode === 'plan') throw new Error('plan mode is not supported; dispatch the task directly');
    if (!mode) mode = defaults.mode === 'plan' ? defaultMode(profile.engine) : defaults.mode ?? null;
    if (!speed) speed = defaults.speed ?? null;
    const lineage = parentLink(parent);
    // A repo still to come from GitHub into `cwd`. The chat is there at
    // once and the clone runs inside it (see #followClone); a CLI Helm only
    // runs in a terminal waits for the clone before it starts instead.
    let cloning = null;
    if (clone) {
      if (quick || brain || delegation) throw new Error('only a new chat in a folder can clone a repo');
      if (!this.cloner) throw new Error('this machine cannot clone from GitHub');
      const login = typeof clone.login === 'string' ? clone.login : null;
      const job = await this.cloner.begin({ repo: clone.repo, target: cwd, login: login ?? undefined });
      if (job.state !== 'done') {
        if (!ENGINES[profile.engine]?.driver) {
          await job.done;
          if (job.state !== 'done') throw new Error(job.error || 'The clone failed.');
        } else cloning = { job, login };
      }
    }
    // A repo whose helm.json asks for it gives every new chat its own
    // worktree (session-worktrees.js); made once the chat has its id.
    const own = await this.#worktrees.plan({ cwd, quick, brain, clone, delegation });
    if (ENGINES[profile.engine]?.driver) return this.#startDriven({ cwd, quick, profile, title, model, effort, mode, speed, auto, brain, parent: lineage, originHandoffId, delegation, originAutomationId, cloning, own });
    if (brain) throw new Error(`${profile.engine} cannot be the brain: it has no headless driver`);

    const spec = materialize(profile);
    // What was chosen in the app, in the CLI's own words. An explicit choice
    // goes after the alias's own arguments so it wins if the two disagree.
    spec.args = [...spec.args, ...optionArgs(profile.engine, { model, auto, effort })];
    let dir = expand(cwd);
    const named = dir;
    // A CLI in a terminal has no chat to show progress in: its worktree and
    // setup are done before its pane opens, and problems go to the log.
    const id = randomBytes(6).toString('hex');
    let chatWorktree;
    if (own && !spec.plain) {
      const made = await this.#worktrees.make(own, id);
      if (made.record) {
        dir = made.cwd;
        chatWorktree = made.record;
        if (own.setup) {
          const result = await runSetup(own.setup, expand(made.record.path));
          if (!result.ok) this.log(`[${id}] the setup command in helm.json failed: ${result.output.slice(-500)}`);
        }
      }
    }

    // A plain shell is a terminal, and helm can run one itself - far better
    // than borrowing a herdr pane and reading its screen back. Where the pty
    // addon is missing the old path still works, slowly.
    if (spec.plain && await this.terminals.ensure()) {
      return this.#startTerminal({ dir, profileId, title, env: spec.env, parent: lineage, originHandoffId });
    }

    const handle = await this.runtime.createSession({
      cwd: dir,
      env: spec.env,
      label: title || `${profile.label} · ${named.split('/').pop()}`,
    });

    const session = {
      id,
      workspaceId: handle.workspaceId,
      paneId: handle.paneId,
      tabId: handle.tabId,
      profileId,
      engine: profile.engine,
      model: model || null,
      auto: !!auto,
      cwd: dir,
      title: title || `${named.split('/').pop() || named}`,
      titleBy: title ? 'user' : null,
      status: 'starting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parent: lineage,
      originHandoffId: originHandoffId || undefined,
      chatWorktree,
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

  /** Account credentials travel in the new terminal's environment, never its input log. */
  async integrationTerminal({ cwd, title, env, command }) {
    if (!await this.terminals.ensure()) throw new Error('Sign-in needs terminal support on this machine. Open the CLI locally to sign in.');
    const session = await this.#startTerminal({ dir: expand(cwd), profileId: 'shell', title, env });
    await this.input(session.id, `${command}\r`, { raw: true });
    return session;
  }

  async #startTerminal({ dir, profileId, title, env, parent = null, originHandoffId = null }) {
    this.#rewinder.assertRewindUnlocked(null, dir);
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
      parent: parentLink(parent),
      originHandoffId: originHandoffId || undefined,
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

  async #startDriven({ cwd, quick = false, profile, title, model, effort, mode, speed, auto, brain = false, engineSessionId = null, transcript = null, parent = null, originHandoffId = null, forkFrom = null, delegation = null, originAutomationId = null, cloning = null, own = null, chatWorktree = null }) {
    this.#rewinder.assertRewindUnlocked(null, cwd ? expand(cwd) : null);
    const id = randomBytes(6).toString('hex');
    // The chat's own worktree, before its agent starts there. When it
    // cannot be made the chat still starts, in the folder asked for, and
    // says why.
    const made = own ? await this.#worktrees.make(own, id) : null;
    // Named after the folder asked for, not the worktree's generated one.
    const named = cwd ? expand(cwd) : null;
    if (made?.record) cwd = made.cwd;
    // A quick chat's folder is made for it, empty, and named by its id. A
    // branch of one keeps its parent's: the CLI files a conversation under
    // the folder it ran in, so that is where the copy has to be read from.
    if (quick && !cwd) {
      cwd = quickDir(id);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
    }
    const dir = expand(cwd);
    const session = {
      id,
      driver: profile.engine,
      profileId: profile.id,
      engine: profile.engine,
      model: model || null,
      effort: effort || null,
      mode: mode || (auto != null ? modeFromAuto(profile.engine, auto) : defaultMode(profile.engine)),
      speed: speed || null,
      cwd: dir,
      // A quick chat's folder name is its id, which says nothing; it waits
      // for the agent or the first prompts to name it.
      title: title || (quick ? 'Quick chat' : `${named.split('/').pop() || named}`),
      titleBy: title ? 'user' : null,
      quick: quick || undefined,
      // The brain is a thread like any other - same driver, same events, same
      // permission cards - marked so that it can be found again and so that
      // `input` knows to put the network's state in front of what is typed.
      brain: brain || undefined,
      notifyDone: !delegation,
      delegation: delegation || undefined,
      status: 'idle',
      // Set when picking up a conversation the CLI already has: the driver
      // reads this as "resume", not "start".
      engineSessionId,
      transcript,
      ...(profile.engine === 'codex' && this.nativeDiscovery && nativeCodexSocket(profile)
        ? { nativeSocket: nativeCodexSocket(profile), nativeManaged: true, shared: true } : {}),
      // A branch's first conversation is a copy of another's; cleared once it
      // has had a turn of its own.
      forkFrom: forkFrom || undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parent: parentLink(parent),
      originAutomationId: originAutomationId || undefined,
      originHandoffId: originHandoffId || undefined,
      chatWorktree: made?.record ? { ...made.record, ...(own.setup ? { setup: 'running' } : {}) } : chatWorktree || undefined,
    };
    if (made?.error) {
      this.#index.set(session.id, session);
      this.#worktrees.say(session, made.error);
    }
    if (session.chatWorktree?.setup) {
      // Like a clone: listed and open at once, saying it is setting up;
      // the agent starts once the repo's setup command is done.
      session.status = 'starting';
      this.#index.set(session.id, session);
      this.#save();
      this.emit('session', session);
      void this.#worktrees.setup(session, own.setup).then(() => {
        if (this.#index.get(session.id) === session) return this.#startPrepared(session);
      });
      return session;
    }
    if (cloning) {
      // Listed and open straight away, so the owner can write in it or
      // leave it; the agent starts in the folder once the repo is in, and
      // what was sent meanwhile goes to it then.
      session.status = 'starting';
      session.clone = { repo: cloning.job.repo, login: cloning.login, state: 'cloning', percent: cloning.job.percent ?? 0 };
      this.#index.set(session.id, session);
      this.#save();
      this.emit('session', session);
      void this.#followClone(session, cloning.job);
      return session;
    }
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
      // Claude writes nothing to disk until its first message, so until then
      // its id cannot be resumed - a driver rebuilt early (a new effort, a
      // restart) has to start it again instead.
      if (!engineSessionId && !forkFrom) session.unsent = true;
      this.#save();
      this.emit('session', session);
      return session;
    } catch (err) {
      // A failed handshake must not leave a phantom row (or an agent process)
      // behind. The old path persisted the shell before awaiting ACP and
      // returned it with engineSessionId null when startup went wrong.
      this.#drivers.delete(session.id);
      this.#index.delete(session.id);
      this.#deliveryState.clear(session.id);
      clearTimeout(this.#reapers.get(session.id));
      this.#reapers.delete(session.id);
      driver?.removeAllListeners?.('event');
      await Promise.resolve(driver?.kill?.()).catch(() => {});
      this.#dropQuickDir(session);
      await this.#worktrees.dropped(session);
      this.#save();
      throw err;
    }
  }

  /** sessionId -> a driver being created, so concurrent callers share it. */
  #driverStarts = new Map();

  /** sessionId -> the clone running for a chat that started with one. */
  #clones = new Map();

  /** Started with a repo that is not in yet: no agent, and what is sent waits. */
  #preparing(s) { return (!!s.clone && s.clone.state !== 'done') || s.chatWorktree?.setup === 'running'; }

  /** The clone's bar while it runs, then the agent in the new folder. */
  async #followClone(s, job) {
    this.#clones.set(s.id, job);
    let shown = 0;
    const stop = job.onProgress((j) => {
      if (this.#index.get(s.id) !== s || s.clone?.state !== 'cloning') return;
      s.clone.percent = j.percent;
      // Every open app gets each update; twice a second is plenty for a bar.
      if (Date.now() - shown < 500) return;
      shown = Date.now();
      this.emit('session', s);
    });
    await job.done;
    stop();
    if (this.#clones.get(s.id) === job) this.#clones.delete(s.id);
    if (this.#index.get(s.id) !== s) return;
    if (job.state !== 'done') {
      s.clone = { ...s.clone, state: 'failed', error: job.error || 'The clone failed.' };
      s.status = 'idle';
      s.updatedAt = Date.now();
      this.#save();
      this.emit('session', s);
      return;
    }
    await this.#startAfterClone(s);
  }

  async #startAfterClone(s) {
    s.clone = { ...s.clone, state: 'done', percent: 100, error: undefined };
    s.status = 'starting';
    this.emit('session', s);
    // The repo is in; only the agent has to be tried again.
    await this.#startPrepared(s, (err) => { s.clone = { ...s.clone, state: 'failed', cloned: true, error: `The agent did not start: ${err.message}` }; });
  }

  /** The agent of a chat that had something to do first (a clone, a setup command). */
  async #startPrepared(s, failed = (err) => this.#worktrees.say(s, `The agent did not start: ${err.message}`)) {
    let driver = null;
    try {
      driver = await this.#driver(s);
      await driver.start();
      s.engineSessionId = driver.engineSessionId;
      if (!s.engineSessionId) throw new Error('it did not open a conversation');
      s.unsent = true;
      if (s.status === 'starting') s.status = 'idle';
    } catch (err) {
      this.#drivers.delete(s.id);
      driver?.removeAllListeners?.('event');
      await Promise.resolve(driver?.kill?.()).catch(() => {});
      if (this.#index.get(s.id) !== s) return;
      failed(err);
      s.status = 'idle';
    }
    s.updatedAt = Date.now();
    this.#save();
    this.emit('session', s);
    this.#delivery.pump(s);
  }

  /** "Try again" on a chat whose clone, or whose agent after it, failed. */
  async retryClone(id) {
    const s = this.get(id);
    if (!s.clone || s.clone.state !== 'failed') return { ok: true };
    if (s.clone.cloned) { void this.#startAfterClone(s); return { ok: true }; }
    // A clone cut off half way can be cleared: this chat made that folder.
    const job = await this.cloner.begin({ repo: s.clone.repo, target: s.cwd, login: s.clone.login ?? undefined, partialOk: true });
    s.clone = { ...s.clone, state: 'cloning', percent: 0, error: undefined };
    s.status = 'starting';
    this.#save();
    this.emit('session', s);
    if (job.state === 'done') void this.#startAfterClone(s);
    else void this.#followClone(s, job);
    return { ok: true };
  }

  /**
   * The live driver for a session, starting (or resuming) one if needed.
   *
   * One at a time per session: a message sent while a restart is still
   * rebinding the surviving process otherwise built a second driver on the
   * same process - two readers of one pipe, and two writers into one thread.
   */
  #driver(s) {
    const retiring = this.#retiring.get(s.id);
    if (retiring) return retiring.then(() => this.#driver(s));
    const live = this.#drivers.get(s.id);
    if (live) return Promise.resolve(live);
    let pending = this.#driverStarts.get(s.id);
    if (!pending) {
      pending = this.#createDriver(s);
      this.#driverStarts.set(s.id, pending);
      const done = () => { if (this.#driverStarts.get(s.id) === pending) this.#driverStarts.delete(s.id); };
      pending.then(done, done);
    }
    return pending;
  }

  async #createDriver(s) {
    if (this.#preparing(s)) throw new Error(s.chatWorktree?.setup === 'running' ? 'The worktree is still being set up.' : 'The repo is not cloned yet.');
    let d;
    // A thread opened from local history can outlive the provider's
    // transcript. If a previous attempt already proved its id is missing,
    // resend as a fresh conversation instead of retrying the same dead id.
    if (s.engine === 'claude' && missingClaudeConversation(
      this.events.tail(s.id).findLast((e) => e.type === 'turn.done' && e.status === 'error')?.error,
      s.engineSessionId,
    )) {
      s.engineSessionId = null;
      this.#save();
    }
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === s.profileId);
    if (!profile) throw new Error(`the account for this session (${s.profileId}) is gone`);
    const spec = materialize(profile);
    // A quick chat's folder is helm's own; if it went missing (cleaned by
    // hand), an empty one is as good as the old one.
    if (s.quick && isQuickDir(s.cwd)) mkdirSync(expand(s.cwd), { recursive: true, mode: 0o700 });
    // A chat's own worktree is removed once merged; reopened, it is rebuilt.
    await this.#worktrees.ensure(s);
    // The brain's tools are the `helm` command, so which `helm` it finds is
    // the whole question. Give it this daemon's own, ahead of the installed
    // one: a machine that has not been upgraded yet would otherwise hand the
    // brain a CLI that does not have the verbs its brief promises.
    // Every headless agent can reach the network CLI. Brains get the same
    // binary, but ordinary sessions need it too for `helm handoff`: an agent
    // should be able to move its work to another machine without a special
    // kind of conversation. The identity variables let that command recover
    // the current session and its working folder without trusting prose.
    // The mode is deliberately not among them: it changes while a session
    // runs, so a stale copy in the environment would outrank the live
    // record - `helm handoff` asks the session itself instead.
    spec.env = {
      ...spec.env,
      PATH: pathWithShim(spec.env?.PATH),
      HELM_SESSION_ID: s.id,
      HELM_PROFILE_ID: s.profileId,
      HELM_ENGINE: s.engine,
      HELM_CWD: s.cwd,
    };
    d = this.makeDriver(s.driver, {
      cmd: spec.cmd, env: spec.env, args: spec.args, cwd: s.cwd,
      model: s.nativeSocket && !s.nativeManaged ? null : s.model, effort: s.nativeSocket && !s.nativeManaged ? null : s.effort,
      // A reported native policy is for display. Rejoining must not turn it
      // into a policy override; the provider terminal owns that configuration.
      mode: s.nativeSocket && !s.nativeManaged ? null : s.mode, speed: s.nativeSocket && !s.nativeManaged ? null : s.speed,
      engineSessionId: s.engineSessionId,
      nativeSocket: s.nativeSocket,
      unsent: !!s.unsent,
      // helm's brief to the agent - which CLI accounts it can delegate to -
      // as standing instructions rather than glued onto the owner's first
      // message, where it read as something they had typed.
      // A hidden helper is asked one question with all it needs; the brief
      // would only cost it tokens.
      instructions: DRIVERS[s.driver]?.takesInstructions && !s.delegation?.hidden ? (this.delegationBrief?.(s) || null) : null,
      forkFrom: s.forkFrom,
      transcript: s.transcript,
      monitorOnly: !!s.external,
      delegated: !!s.delegation,
      // Held on the proc host, the process outlives this daemon. The
      // getters answer what the log still has open - read only when the
      // driver actually finds its process there to rebind.
      procHost: this.procs, procId: s.rewindProcId || s.id,
      openTurn: () => this.events.activeTurn(s.id)?.turnId ?? null,
      pendingEvents: () => this.events.pending(s.id),
      resumeEvents: () => this.events.tail(s.id, 0),
      log: (m) => this.log(`[${s.id}] ${m}`),
    });
    return this.#bindDriver(s, d, profile);
  }

  #bindDriver(s, d, profile) {
    this.#drivers.set(s.id, d);
    d.on('event', (e) => {
      if (e.type === 'limits' && this.#drivers.get(s.id) === d) {
        s.lastLimits = mergeUsageLimits(s.lastLimits, e);
        try { this.limits.record(accountKey(profile), e); }
        catch (err) { this.log(`account limits: ${err.message}`); }
      }
      this.#driverEvents.onDriverEvent(s, d, e);
    });
    // Both CLIs announce what they actually started with. Keep it: when the
    // owner has not picked a model, this is the only way to say which one is
    // running instead of showing the word "model". It is reported, not
    // chosen, so it stays separate from `model` and never becomes an
    // argument on the next launch.
    d.on('init', (info) => {
      if (!info) return;
      let changed = false;
      for (const [key, target] of [['model', 'engineModel'], ['effort', 'engineEffort'], ['effortKeepsCache', 'effortKeepsCache'], ['modelSwitchSignal', 'modelSwitchSignal']]) {
        // A partial init must not erase settings another provider event reported.
        if (info[key] === undefined) continue;
        if (s[target] !== info[key]) { s[target] = info[key]; changed = true; }
        if (['pi', 'omp'].includes(s.engine) && s[key] != null && typeof info[key] === 'string' && s[key] !== info[key]) {
          s[key] = info[key]; changed = true;
        }
      }
      const mode = reportedMode(s.engine, info);
      if (mode && s.mode !== mode) { s.mode = mode; changed = true; }
      if (!changed) return;
      if (this.#index.has(s.id)) this.#save();
      this.emit('session', s);
    });
    return d;
  }

  #settled(id) {
    clearTimeout(this.#deliveryState.clearSettling(id));
  }

  /** Finished children release their runtime quickly; their conversation stays resumable. */
  #reap(s, status) {
    // A turn just ended: its work may have been merged back.
    if (status === 'idle' && s.chatWorktree) setTimeout(() => void this.#worktrees.tidy(s), 3000).unref?.();
    clearTimeout(this.#reapers.get(s.id));
    this.#reapers.delete(s.id);
    if (status !== 'idle' || (s.shared && !s.delegation) || !this.#drivers.has(s.id)) return;
    const t = setTimeout(() => {
      this.#reapers.delete(s.id);
      const d = this.#drivers.get(s.id);
      if (!d || d.status !== 'idle' || s.status !== 'idle' || this.#retiring.has(s.id)) return;
      if (this.#deliveryState.isSending(s.id) || this.#deliveryState.hasQueue(s.id) || d.pending?.size
        || this.events.pending(s.id).length || this.events.activeTurn(s.id) || this.hasActiveDelegations(s.id)
        // A background command or watch it is waiting on dies with it.
        || d.backgroundTasks > 0) {
        this.#reap(s, 'idle'); return;
      }
      const retiring = Promise.resolve().then(() => d.kill()).then(() => {
        if (this.#drivers.get(s.id) === d) this.#drivers.delete(s.id);
        if (this.#index.has(s.id)) this.emit('session', { ...wire(s), alive: false });
      }, error => this.log(`[${s.id}] could not release idle provider: ${error.message}`)).finally(() => {
        if (this.#retiring.get(s.id) === retiring) this.#retiring.delete(s.id);
        if (this.#drivers.get(s.id) === d && this.#index.has(s.id)) this.#reap(s, s.status);
      });
      this.#retiring.set(s.id, retiring);
    }, s.delegation ? this.delegationIdleMs : IDLE_REAP_MS);
    t.unref?.();
    this.#reapers.set(s.id, t);
  }

  // Conversations a CLI recorded on its own (session-external.js)
  resumeExternal(options) { return this.#external.resumeExternal(options); }
  takeOver(id) { return this.#external.takeOver(id); }
  cancelTakeOver(id) { return this.#external.cancelTakeOver(id); }
  connect(id) { return this.#external.connect(id); }

  /**
   * This machine's contribution to the digest: its live sessions, each with
   * the line `brain.js` derives from its event log. Separate from `list()`
   * on purpose - `list()` is polled by every paired device every 15 seconds,
   * and reading every session's event tail is not something to do on that
   * schedule for people who are not asking for it.
   */
  async digest() {
    const sessions = localDigest(await this.list({ includeDelegations: true }), this.events);
    // Saved in every machine's snapshot, so `helm pickup` can still match an
    // offline machine's chats to a project.
    const keys = await projectKeysFor(sessions.map((s) => s.cwd));
    return { sessions: sessions.map((s) => (keys[s.cwd]?.length ? { ...s, project: keys[s.cwd] } : s)) };
  }

  /** Preserve former machine brains as ordinary conversations. */
  retireBrains() {
    let changed = false;
    for (const s of this.#index.values()) {
      if (!s.brain) continue;
      delete s.brain;
      changed = true;
    }
    if (changed) this.#save();
  }

  setBrainVersion(id, version) {
    this.get(id).brainVersion = version;
    this.#save();
  }

  /** A missing provider thread can be renewed without deleting Helm history. */
  async resetBrainProvider(id) {
    const s = this.get(id);
    if (!s.brain || s.external || s.nativeSocket || ['working', 'blocked'].includes(s.status)) {
      throw new Error('Only an idle Helm brain with a missing provider conversation can be renewed.');
    }
    const d = this.#drivers.get(id);
    this.#drivers.delete(id);
    d?.removeAllListeners?.();
    await d?.kill?.();
    s.brainPreviousThread = s.engineSessionId;
    s.engineSessionId = null;
    delete s.brainVersion;
    delete s.unsent;
    s.status = 'idle';
    this.#save();
  }

  /** The network brain's thread, only on its home VM. */
  brainSession() {
    for (const s of this.#index.values()) if (s.brain && !s.archived && s.status !== 'exited') return s;
    return null;
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

  /** An agent can select a project file without needing a browser click. */
  async openCanvas(id, { path, requestId }) {
    const s = this.get(id);
    if (!this.#index.has(id) || s.engine === 'shell') throw new Error('canvas needs a saved agent chat');
    if (s.quick || !s.cwd) throw new Error('this quick chat has no project folder; use an HTML file or a spin URL');
    if (!/^[a-f0-9]{24}$/.test(requestId ?? '')) throw new Error('invalid canvas request ID');
    const selected = await canvasPath(s.cwd, path);
    if (s.canvas?.requestId === requestId) {
      if (s.canvas.path !== selected) throw new Error('canvas request ID already used for another file');
      return { canvas: s.canvas };
    }
    // The read above can yield; deletion must not resurrect a removed chat.
    if (!this.#index.has(id)) throw new Error('no such saved agent chat');
    s.canvas = { path: selected, requestId };
    this.#save();
    this.emit('session', s);
    return { canvas: s.canvas };
  }

  /**
   * The owner closed the canvas the agent opened. The chat keeps that, so no
   * device (another browser, a phone) opens the same ask again.
   */
  closeCanvas(id, requestId) {
    const s = this.get(id);
    if (!s.canvas || s.canvas.requestId !== requestId || s.canvas.closed) return { canvas: s.canvas ?? null };
    s.canvas = { ...s.canvas, closed: true };
    this.#save();
    this.emit('session', s);
    return { canvas: s.canvas };
  }

  /** Save a page independently of provider lifetime or background tasks. */
  renderVisual(id, params) {
    const s = this.get(id);
    if (!this.#index.has(id) || s.engine === 'shell') throw new Error('visual replies need a saved agent chat');
    const { html, title, height, renderId, placement, url } = validateVisual(params);
    const itemId = `visual-${renderId}`;
    const ref = createHash('sha256').update(html).digest('hex').slice(0, 32);
    const prior = this.events.tail(id, 0).find(e => e.type === 'item.start' && e.id === itemId);
    if (prior) {
      if (prior.visual?.ref !== ref || prior.visual.title !== title || prior.visual.height !== height || prior.visual.placement !== placement || prior.visual.url !== url) throw new Error('render ID already used for a different visual');
      return { visual: prior.visual };
    }
    const stored = this.events.putAttachment(id, { filename: `${renderId}.html`, mime: 'text/html', data: Buffer.from(html).toString('base64') });
    const visual = { ref: stored.ref, title, height, bytes: stored.bytes, ...(placement ? { placement } : {}), ...(url ? { url } : {}) };
    const active = s.driver && !s.external ? this.events.activeTurn(id) : null;
    const turnId = active?.turnId ?? `local-visual-${renderId}`;
    const append = event => {
      const saved = this.events.append(id, event);
      s.lastSeq = saved.seq;
      this.emit('event', { id, event: saved });
    };
    if (!active) append({ type: 'turn.start', turnId, text: '', local: true });
    append({ type: 'item.start', turnId, id: itemId, kind: 'visual', visual });
    append({ type: 'item.done', turnId, id: itemId, status: 'ok' });
    if (!active) append({ type: 'turn.done', turnId, status: 'ok', local: true });
    if (placement === 'canvas') s.canvas = { requestId: renderId, visual };
    this.#save();
    if (placement === 'canvas') this.emit('session', s);
    this.emit('transcript', { id });
    return { visual };
  }

  readVisual(id, ref) {
    this.get(id);
    if (!this.#index.has(id)) throw new Error('no such saved agent chat');
    if (!/^[a-f0-9]{32}$/.test(ref ?? '') || !this.events.tail(id, 0).some(e => e.visual?.ref === ref)) throw new Error('no such visual in this chat');
    const data = this.events.attachment(id, ref);
    if (!data) throw new Error('this visual is no longer stored');
    return { html: Buffer.from(data, 'base64').toString('utf8') };
  }

  /** Backfill images when an existing imported chat is opened after upgrade. */
  async prepareHistory(id) {
    const s = this.get(id);
    if (s.engine === 'opencode2') {
      await opencodeServiceSessions();
      await this.#external.monitorService(s);
    }
    if (s.external || s.engine === 'codex' && s.externalSource && s.transcript && s.externalImagesVersion !== 1) {
      await this.#external.importExternalTranscript(s);
    }
  }

  // Screens and transcripts being watched (session-viewers.js)
  watch(id, watcher) { return this.#viewers.watch(id, watcher); }
  unwatch(id, watcher) { return this.#viewers.unwatch(id, watcher); }
  watching(id) { return this.#viewers.watching(id); }
  watcherRecipients(id) { return this.#viewers.recipients(id); }
  messages(id, options) { return this.#viewers.messages(id, options); }
  read(id, options) { return this.#viewers.read(id, options); }
  attach(id, options) { return this.#viewers.attach(id, options); }
  detach(id, watcher) { return this.#viewers.detach(id, watcher); }

  async answer(id, requestId, decision) {
    const s = this.get(id);
    const ask = this.#natives.hookAsks.get(requestId);
    if (s.nativeCli) {
      if (!ask || ask.id !== id) throw new Error('that question was already answered on the terminal');
      // The same answer `claude -p` takes, printed by the waiting hook.
      let response;
      if (decision?.option === 'deny') response = { behavior: 'deny', message: decision.message || 'The owner declined this from Helm.' };
      else {
        response = { behavior: 'allow' };
        if (decision?.option === 'always' && ask.raw?.permission_suggestions?.length) response.updatedPermissions = ask.raw.permission_suggestions;
        if (ask.kind === 'question' && decision?.answers) response.updatedInput = { ...ask.raw.input, answers: decision.answers };
        else if (decision?.updatedInput) response.updatedInput = decision.updatedInput;
      }
      ask.reply({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: response } });
      this.#natives.closeHookAsk(requestId, decision?.option);
      return { ok: true };
    }
    const d = this.#drivers.get(id);
    if (!d) throw new Error('the agent is not running; that prompt is gone');
    await d.answer(requestId, decision);
    return { ok: true };
  }

  async interrupt(id, visited = new Set()) {
    this.#rewinder.assertRewindUnlocked(id);
    if (visited.has(id)) return { ok: true };
    // Stop with a message waiting means "drop this reply, take my next
    // one": only the reply ends, and the waiting message goes straight out.
    if (!visited.size) {
      const next = await this.#delivery.stopReplyForNext(id);
      if (next) return next;
    }
    visited.add(id);
    const session = this.#index.get(id);
    const children = [...this.#index.values()].filter((child) => child.delegation?.parentId === id);
    if (session) {
      session.stoppedAt = Date.now();
      session.stopGeneration = (session.stopGeneration ?? 0) + 1;
      // Helpers are mentioned only when there were some to stop.
      const running = children.filter((child) => !['done', 'error', 'interrupted'].includes(child.delegation?.status));
      session.recovery = {
        kind: 'interrupted', at: Date.now(),
        message: running.length ? `You stopped this chat. Helm also stopped ${running.length === 1 ? 'its helper' : 'its helpers'}.` : 'Stopped by you.',
      };
      if (session.delegation) {
        session.delegation.status = 'interrupted';
        session.delegation.finishedAt = Date.now();
      }
      this.#delegation.updateTeam(session);
      this.#save();
      this.emit('session', session);
    }
    const stopping = children.map((child) => this.interrupt(child.id, visited));
    // "Stop" stops the queue too, and before the driver is asked: a settled
    // turn is what wakes the pump, so a stop that left the queue intact
    // would fire the next message the moment the interrupt landed. Each
    // waiting bubble disappears because the agent never saw it. Only the
    // actual turn in flight ends as interrupted and earns a "stopped" line.
    const queued = this.#deliveryState.removeQueue(id);
    for (const item of queued) {
      const event = this.events.append(id, { type: 'turn.remove', turnId: item.turnId });
      this.emit('event', { id, event });
    }
    const handed = this.#deliveryState.steered(id);
    this.#deliveryState.restoreSteered(id, []);
    for (const item of handed) {
      const event = this.events.append(id, { type: 'turn.remove', turnId: item.turnId });
      this.emit('event', { id, event });
    }
    const s = this.#index.get(id);
    if (s && (queued.length || handed.length)) s.lastSeq = this.events.last(id);
    const d = this.#drivers.get(id);
    if (d) stopping.push(d.interrupt());
    // A Pi in a terminal has no driver to ask: press Esc, which is how Pi
    // stops a reply. Only mid-turn - a second Esc at Pi's prompt opens its tree.
    else if (s?.nativeCli && s.engine === 'pi' && ['working', 'blocked'].includes(s.status)
      && this.nativeTerminals.has(id)) stopping.push(this.nativeTerminals.write(id, '\x1b'));
    const results = await Promise.allSettled(stopping);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw new Error(`Some work could not be stopped: ${failed.reason?.message || failed.reason}`);
    return { ok: true };
  }

  /** Persist the child created by a remote code handoff on the parent host. */
  linkChild(id, child = {}) {
    const s = this.get(id);
    if (String(id).startsWith('pane:')) throw new Error('a pane session cannot own a handoff link');
    if (!child || typeof child !== 'object') throw new Error('invalid handoff child');
    const text = (value, max = 200) => typeof value === 'string' && value.length > 0
      && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
    const handoffId = text(child.handoffId, 80);
    const machineId = text(child.machineId, 80);
    const sessionId = text(child.sessionId, 80);
    if (!handoffId || !machineId || !sessionId) throw new Error('handoff link is missing its identity');
    const record = {
      handoffId,
      machineId,
      sessionId,
      title: text(child.title, 120) || null,
      folder: text(child.folder, 1024) || null,
      digest: text(child.digest, 128) || null,
      createdAt: Number.isFinite(child.createdAt) ? child.createdAt : Date.now(),
    };
    s.children = (Array.isArray(s.children) ? s.children.filter((x) => x?.handoffId !== handoffId) : []);
    s.children.push(record);
    s.children = s.children.slice(-100);
    s.updatedAt = Date.now();
    this.#save();
    this.emit('session', s);
    return { ok: true, session: s };
  }

  setTaskTransfer(id, transfer) {
    const session = this.get(id);
    session.taskTransfer = transfer;
    session.updatedAt = Date.now();
    this.#save();
    this.emit('session', session);
  }

  receiveTaskReturn(id, { context, ...transfer }) {
    const session = this.get(id);
    const turnId = `returned-${transfer.handoffId}-${transfer.status}`;
    if (transfer.status === 'returned' && session.taskReturnAppliedId !== turnId) {
      session.taskReturnContext = context;
      session.taskReturnAppliedId = turnId;
      this.#save();
    }
    if (!this.events.turnState(id, turnId)) {
      const message = transfer.status === 'returned'
        ? `Task returned from ${transfer.machineName}. Project changes are applied here.`
        : `Task returned from ${transfer.machineName}. Local changes need review; the returned copy is in ${transfer.folder}.`;
      this.#delivery.emitLocal(session, turnId, message, context);
    }
    this.setTaskTransfer(id, transfer);
  }

  // Terminal CLIs and native Codex threads (session-native.js)
  control(id, kind) { return this.#natives.control(id, kind); }
  refreshNativeSettings(id) { return this.#natives.refreshNativeSettings(id); }

  async setMode(id, mode) {
    this.#rewinder.assertRewindUnlocked(id);
    if (mode === 'plan') throw new Error('plan mode is not supported; dispatch the task directly');
    const s = this.get(id);
    if (s.nativeCli && s.engine === 'pi') {
      if (s.permissionControl !== 'bash-guard' || !BASH_GUARD_MODES.some(m => m.id === mode)) throw new Error('This Pi does not offer bash-guard controls.');
      if (s.mode === mode) return { ok: true, session: wire(s) };
      return this.#natives.nativeWrite(s, '/bash-guard', { confirmedMode: mode });
    }
    if (s.nativeChat && s.engine === 'claude') return this.#natives.nativeMode(s, mode);
    if (!s.driver) throw new Error('not a headless session');
    const d = this.#drivers.get(id);
    if (d) await d.setMode(mode);
    s.mode = mode;
    this.#save();
    this.emit('session', s);
    return { ok: true, session: s };
  }

  async setEffort(id, effort) {
    this.#rewinder.assertRewindUnlocked(id);
    const s = this.get(id);
    if (s.nativeChat && s.engine === 'claude') {
      const level = effort || 'auto';
      if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto'].includes(level)) throw new Error('invalid Claude thinking effort');
      return this.input(id, `/effort ${level}`);
    }
    if (s.nativeCli) return this.#natives.nativeWrite(s, nativeSettingCommand(s.engine, 'effort', effort));
    if (!s.driver) throw new Error('not a headless session');
    const value = effort === 'auto' ? null : effort || null;
    const d = this.#drivers.get(id);
    if (d) await d.setEffort(value);
    s.effort = d && ['pi', 'omp'].includes(s.engine) ? d.effort : value;
    if (d && s.engine === 'claude') s.engineEffort = value;
    this.#save();
    this.emit('session', s);
    return { ok: true, session: s };
  }

  async setSpeed(id, speed) {
    this.#rewinder.assertRewindUnlocked(id);
    const s = this.get(id);
    if (!s.driver) throw new Error('not a headless session');
    s.speed = speed || null;
    this.#save();
    const d = this.#drivers.get(id);
    if (d?.setSpeed) await d.setSpeed(s.speed);
    this.emit('session', s);
    return { ok: true, session: s };
  }

  catalog(id) {
    const d = this.#drivers.get(id);
    return d?.catalog?.() ?? null;
  }

  /**
   * Whether a *running* agent can be sent images, or null when no driver is
   * up to ask. ACP agents only answer this at `initialize`, so a session
   * that has not started yet, or is still starting, leaves the app on the
   * model catalogue's guess.
   */
  acceptsImages(id) {
    const d = this.#drivers.get(id);
    if (!d || d.acceptsImages?.() === null) return null;
    return driverTakesImages(d);
  }

  /**
   * `pick`: the owner chose this in the app. `ask` (with `pick`): if Claude
   * says the switch rewrites a warm cache worth a question, hold it back and
   * return `{ ask }` with Claude's figures; `noSignal` means no running
   * Claude can say, and the app falls back to its own estimate. A pick
   * without `ask` is one the owner already confirmed.
   */
  async setModel(id, model, { pick = false, ask = false } = {}) {
    this.#rewinder.assertRewindUnlocked(id);
    const s = this.get(id);
    if (s.nativeChat && s.engine === 'claude') {
      const value = model || 'default';
      if (typeof value !== 'string' || value.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+\[\]-]*$/.test(value)) throw new Error('invalid Claude model');
      // Claude may reject the model or ask for confirmation. Sending bytes
      // is not acknowledgment, so never persist it as the active setting.
      if (!pick) return this.input(id, `/model ${value}`);
      return this.#natives.nativeModelSwitch(s, value, ask);
    }
    if (s.nativeCli) return this.#natives.nativeWrite(s, nativeSettingCommand(s.engine, 'model', model));
    if (!s.driver) throw new Error('not a headless session');
    const value = model || null;
    const d = this.#drivers.get(id);
    if (ask && !d?.modelSwitchSignal) return { ok: false, noSignal: true, session: s };
    if (d) {
      const r = await d.setModel(value, { ask });
      if (r?.ask) return { ok: false, ask: r.ask, session: s };
    }
    s.model = d && ['pi', 'omp'].includes(s.engine) ? d.model : value;
    this.#save();
    this.emit('session', s);
    return { ok: true, session: s };
  }

  /**
   * The models the owner's own chats on this engine used last, newest first:
   * the model picker puts them at the top. Helpers pick their own, so they
   * do not count.
   */
  recentModels(engine, count = 3) {
    const chats = [...this.#index.values()]
      .filter((s) => s.engine === engine && typeof s.model === 'string' && s.model && !s.delegation)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return [...new Set(chats.map((s) => s.model))].slice(0, count);
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
   * The session a code handoff started, found by the handoff id on its
   * record - or, for sessions from before that field existed, its parent
   * link.
   *
   * A receipt written after the session exists can be lost to a crash;
   * the handoff's own id on the session record is how a retry finds what
   * the store never recorded.
   */
  handoffSession(handoffId) {
    return [...this.#index.values()].find(
      (s) => s.originHandoffId === handoffId || s.parent?.handoffId === handoffId,
    ) ?? null;
  }

  /** What the retained log says about a caller-chosen turn id. */
  turnState(id, turnId) {
    return this.events.turnState(id, turnId);
  }

  // Sending messages (session-delivery.js)
  input(id, text, options) { return this.#delivery.input(id, text, options); }
  dequeue(id, turnId) { return this.#delivery.dequeue(id, turnId); }
  editQueued(id, turnId, text, attachments) { return this.#delivery.editQueued(id, turnId, text, attachments); }
  reorderQueue(id, turnIds) { return this.#delivery.reorderQueue(id, turnIds); }
  sendNow(id, turnId) { return this.#delivery.sendNow(id, turnId); }

  findAutomationSession(identity) {
    return [...this.#index.values()].find(s => s.originAutomationId === identity) || null;
  }

  /**
   * The viewer's size. A pty renders for it; a herdr pane has its own
   * geometry that the phone does not get to choose, so this is a no-op there
   * rather than an error - the terminal view sends it either way.
   */
  resize(id, cols, rows) {
    const s = this.get(id);
    if (s.pty) this.#terminal(s).resize(id, cols, rows);
    return { ok: true };
  }

  keys(id, keys) {
    const s = this.get(id);
    if (s.driver) throw new Error('a headless session has no terminal');
    const bytes = keys.map(KEY_BYTES).join('');
    if (s.pty) {
      this.#terminal(s).write(id, bytes);
      return { ok: true };
    }
    // The same bytes, down the same road typing takes. herdr's own key
    // names ("esc", lower case) are not the ones the app sends, and a name
    // it does not know was silently dropped - every quick key but a few.
    return this.runtime.sendText(this.#handle(s), bytes);
  }

  async kill(id) {
    this.#rewinder.assertRewindUnlocked(id);
    // A row read out of a CLI's own history: there is no process to stop and
    // nothing of ours to delete. "Delete" here means stop listing it - the
    // CLI's own transcript is its data, not helm's, and stays where it is.
    if (id.startsWith('found:')) return this.#mark(id, 'removed');
    const s = this.get(id);
    // The CLI keeps its own copy of the conversation, which the history scan
    // would list again as a chat Helm did not start - a deleted chat (a quick
    // one most of all) coming straight back. Deleting it here deletes that row
    // too. An outside chat Helm only watched is left listable.
    if (s.engineSessionId && !s.external) {
      this.#marks.set(`found:${s.engine}:${s.engineSessionId}`, 'removed');
      this.#removedAt.set(`found:${s.engine}:${s.engineSessionId}`, Date.now());
    }
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
      this.#clones.get(id)?.cancel();
      this.#clones.delete(id);
      const d = this.#drivers.get(id);
      this.#drivers.delete(id);
      this.#deliveryState.clear(id);
      this.#settled(id);
      this.#commandCards.delete(id);
      this.#deliveryState.clearClosedTurns(id);
      this.#rewinder.providerRevisions.delete(id);
      clearTimeout(this.#reapers.get(id));
      if (d) await d.kill();
      this.#index.delete(id);
      this.#dropQuickDir(s);
      await this.#worktrees.dropped(s);
      // On disk before its log goes, so a crash never lists a chat whose history is gone.
      this.#save();
      this.flush();
      this.events.remove(id);
      rmSync(join(HELM_DIR, 'agent-messages', id), { recursive: true, force: true });
      rmSync(join(HELM_DIR, 'uploads', id), { recursive: true, force: true });
      this.#delegation.updateTeam(s);
      this.emit('session', { ...s, status: 'exited', alive: false });
      return { ok: true };
    }
    if (s.pty) {
      await this.#terminal(s).close(id);
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
   * Deleting a quick chat deletes the folder made for it - unless a branch of
   * it, or a child it started, still works there. Archiving keeps it.
   */
  #dropQuickDir(s) {
    if (!s.quick || !isQuickDir(s.cwd)) return;
    const dir = expand(s.cwd);
    if ([...this.#index.values()].some((o) => o !== s && expand(o.cwd ?? '') === dir)) return;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (err) { this.log(`[${s.id}] could not remove ${dir}: ${err.message}`); }
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
    // A chat that cloned a repo is kept: it is where that repo was asked
    // for, and leaving it while the clone runs is the point.
    if (!s || s.brain || s.engine === 'shell' || s.pty || s.hasInput || (s.prompts ?? 0) > 0 || s.clone) {
      return { ok: true, discarded: false };
    }
    await this.kill(id);
    return { ok: true, discarded: true };
  }

  /** What the owner has filed away or dismissed among the rows helm does not own. */
  marks() { return Object.fromEntries(this.#marks); }

  #mark(id, state) {
    if (state) this.#marks.set(id, state); else this.#marks.delete(id);
    if (state === 'removed') this.#removedAt.set(id, Date.now()); else this.#removedAt.delete(id);
    this.#save();
    const session = { id, adopted: true, archived: state === 'archived', removed: state === 'removed' };
    this.emit('session', session);
    return { ok: true, session };
  }

  // Titles (session-titles.js)
  rename(id, title) { return this.#titles.rename(id, title); }

  /**
   * Whether this thread should announce completed turns. Driven sessions are
   * born on; the owner can silence an individual thread from its header.
   */
  /**
   * The owner looked at this chat, on whichever device. Kept on the machine,
   * not in that browser, so "finished, not opened yet" clears everywhere.
   * The machine's own clock stamps it: it is the clock that wrote updatedAt.
   */
  markSeen(id) {
    const at = Date.now();
    const s = this.#index.get(id);
    if (s) {
      s.seenAt = at;
      this.#save();
      this.emit('session', s);
      return { ok: true, seenAt: at };
    }
    if (!EXTERNAL.test(id)) throw new Error(`unknown session: ${id}`);
    this.#seen.set(id, at);
    const cutoff = at - SEEN_KEEP_MS;
    for (const [key, when] of this.#seen) if (when < cutoff) this.#seen.delete(key);
    this.#save();
    this.emit('session', { id, adopted: true, seenAt: at });
    return { ok: true, seenAt: at };
  }

  setNotifyDone(id, on = true) {
    const s = this.get(id);
    s.notifyDone = !!on;
    if (this.#index.has(id)) this.#save();
    this.emit('session', s);
    return { ok: true, session: wire(s) };
  }

  /** Hide a session from the active list without stopping or deleting it. */
  archive(id, archived = true) {
    this.#rewinder.assertRewindUnlocked(id);
    // Nothing of helm's to write on, so the mark is the record. Archiving one
    // of these is the only way to get a machine's own terminal panes and a
    // CLI's year of history out of the way without pretending they are gone.
    if (EXTERNAL.test(id)) return this.#mark(id, archived ? 'archived' : null);
    const s = this.get(id);
    s.archived = !!archived;
    s.archivedAt = s.archived ? Date.now() : null;
    if (s.archived && s.recovery?.kind === 'limited') { s.recovery.autoResumeCancelled = true; this.cancelLimitContinuation(s); }
    this.#delegation.updateTeam(s);
    this.#save();
    this.emit('session', s);
    if (s.delegation?.parentId) {
      const parent = this.#index.get(s.delegation.parentId);
      if (parent) this.emit('session', { ...parent, delegations: this.#delegation.visibleDelegations(parent) });
    }
    return { ok: true, session: wire(s) };
  }

  // After a daemon restart (session-resume.js)
  adoptTerminals() { return this.#resumer.adoptTerminals(); }
  resume() { this.#worktrees.watch(); return this.#resumer.resume(); }

  /**
   * Let an idle chat's agent process go now rather than at the idle reaper.
   * Its conversation stays and the next message starts it again.
   */
  async release(id) {
    clearTimeout(this.#reapers.get(id));
    this.#reapers.delete(id);
    await this.#retiring.get(id);
    const d = this.#drivers.get(id);
    if (!d) return;
    // The reaper's own steps, so a message sent meanwhile waits for them.
    const retiring = Promise.resolve().then(() => d.kill()).then(() => {
      if (this.#drivers.get(id) === d) this.#drivers.delete(id);
      const s = this.#index.get(id);
      if (s) this.emit('session', { ...wire(s), alive: false });
    }, (err) => this.log(`[${id}] could not release its agent: ${err.message}`)).finally(() => {
      if (this.#retiring.get(id) === retiring) this.#retiring.delete(id);
    });
    this.#retiring.set(id, retiring);
    await retiring;
  }

  /** Remove a chat's worktree now if its work is merged back (tests, and the sweep's own check). */
  worktreeTidy(id, now) { return this.#worktrees.tidy(this.get(id), now); }

  /** The chat's title changed: its worktree branch may take the name. */
  titled(s) { if (s.chatWorktree) void this.#worktrees.titled(s); }

  /** Daemon going away: hosted procs stay up, local ones die as before. */
  async stop() {
    this.flush();
    clearInterval(this.limitRecoveryTimer);
    this.limitRecoveryTimer = null;
    for (const timer of this.#natives.modeReads) clearTimeout(timer);
    this.#natives.modeReads.clear();
    clearInterval(this.nativePoll);
    this.#viewers.stop();
    this.#worktrees.stop();
    for (const timer of this.#reapers.values()) clearTimeout(timer);
    this.#reapers.clear();
    await Promise.allSettled(this.#retiring.values());
    for (const id of this.#deliveryState.settlingIds()) this.#settled(id);
    await (await this.hooks?.catch(() => null))?.close();
    this.nativeDiscovery = false;
    await this.#natives.nativeDiscovery?.catch(() => {});
    await Promise.allSettled([...this.#drivers.values()].map((d) => {
      d.flush?.();
      return d.suspend?.() ?? d.kill();
    }));
    this.#drivers.clear();
    // Let go of the hosts, without closing what they hold: their shells and
    // agents outlive this daemon by design. A socket left open here kept a
    // stopped daemon's process alive indefinitely.
    this.terminals.detach?.();
    this.nativeTerminals.detach?.();
    this.procs.detach?.();
    // Stopping settles turns and drivers, which change the index again.
    this.flush();
  }
}
