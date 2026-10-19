import { nativeAccount } from './native-account.js';
import { nativeControlCommand } from './native-controls.js';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { expand } from './paths.js';
import { getProfiles } from './profiles.js';
import { ENGINES } from './engines.js';
import { accountKey } from './settings.js';
import { permissionCard } from './drivers/claude.js';
import { codexTurnOutcome, nativeCodexThreads } from './drivers/codex.js';
import { MODES } from './modes.js';
import { ModeFooter, MODE_LABELS, MODE_FROM_LABEL, claudeBox } from './native-mode.js';
import { claudeLiveSessions, claudeLiveStatus, descendsFrom } from './external-process.js';
import { WORTH_SAYING } from '@helm/usage/recache';
import { readProcess } from './takeover.js';
import { pendingSummary, wire } from './session-wire.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * CLIs the owner runs in a Helm terminal, and Codex threads open in Codex's
 * own daemon. Helm does not drive these: it follows what their hooks,
 * footers and daemons report, and types into the terminal when the owner
 * changes a setting from the app.
 */
export class NativeSessions {
  #sessions;
  #core;
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  /** requestId -> { id, reply, raw }: a terminal Claude's question, waiting in its hook. */
  hookAsks = new Map();
  /**
   * session id -> a model change the app asked a terminal Claude for, until
   * Claude's PreModelSwitch hook says what it costs. `ask`: hold it back if
   * Claude says it rewrites a warm cache worth a question.
   */
  #modelSwitches = new Map();
  /** When a hook last said what a terminal Claude is doing. */
  #nativeStatusAt = new Map();
  /** Keep each pasted message and its Enter together across app clients. */
  nativeInputs = new Map();
  /** Footer reads waiting for a native Claude to finish drawing its first screen. */
  modeReads = new Set();

  /**
   * What a terminal Claude's hooks say it is doing (claude-hooks.js). The
   * transcript is still where the conversation is read from; hooks add the
   * three things it cannot say - which file it is, that Claude is waiting on
   * a person, and when it is done.
   */
  onHook(native, event, reply) {
    // The first hook can beat the host's "a terminal opened" notice.
    if (!this.#core.index.has(native)) {
      for (const meta of this.#sessions.nativeTerminals.nativeSessions()) if (meta.id === native) this.adoptNative(meta);
    }
    const s = this.#core.index.get(native);
    if (!s?.nativeCli) return reply(null);
    const name = event.hook_event_name;
    if (name === 'HelmSettings' && s.engine === 'pi') {
      reply(null);
      this.nativeSettings(s, event);
      return;
    }
    if (s.engine === 'claude') this.nativeSettings(s, {
      ...(typeof event.effort?.level === 'string' ? { effort: event.effort.level } : {}),
      ...(typeof event.model === 'string' ? { model: event.model } : {}),
      ...(typeof event.permission_mode === 'string' ? { mode: event.permission_mode } : {}),
    });
    if (name === 'HelmSettings') { reply(null); return; }
    // A terminal Claude's status line knows how full its context is; a
    // driven one reports it from its replies instead.
    if (name === 'HelmContext') {
      reply(null);
      this.#core.setContext(s, event.used, event.window, event.model, event.full);
      return;
    }
    if (name === 'HelmUsage') {
      reply(null);
      const unifiedWindows = {};
      for (const key of ['five_hour', 'seven_day']) {
        const window = event.rate_limits?.[key];
        if (typeof window?.used_percentage === 'number') unifiedWindows[key] = {
          utilization: window.used_percentage / 100, resetsAt: window.resets_at,
        };
      }
      const limits = { claude: { unifiedWindows } };
      if (!Object.keys(unifiedWindows).length) return;
      const saved = this.#sessions.events.append(s.id, { type: 'limits', ...limits });
      void getProfiles().then(profiles => {
        let env = null;
        if (s.nativePid) try { env = readProcess(s.nativePid).env; } catch { /* process exited */ }
        const profile = nativeAccount(s, profiles, { env });
        if (profile) this.#sessions.limits.record(accountKey(profile), limits, saved.at);
      }).catch(err => this.#sessions.log(`native usage: ${err.message}`))
        .finally(() => this.#sessions.emit('event', { id: s.id, event: saved }));
      return;
    }
    if (typeof event.permission_mode === 'string' && event.permission_mode && s.mode !== event.permission_mode) {
      s.mode = event.permission_mode;
      this.#core.save();
      this.#sessions.emit('session', { ...wire(s), alive: this.#sessions.nativeTerminals.has(s.id), ...pendingSummary(this.#sessions.events.pending(s.id)) });
    }
    const setStatus = (status) => {
      this.#nativeStatusAt.set(s.id, Date.now());
      if (s.status === status) return;
      s.status = status; s.updatedAt = Date.now(); this.#core.save();
      this.#sessions.emit('session', { ...wire(s), alive: this.#sessions.nativeTerminals.has(s.id), ...pendingSummary(this.#sessions.events.pending(s.id)) });
    };
    if (name === 'PermissionRequest') {
      const requestId = `hook-${randomBytes(6).toString('hex')}`;
      const card = permissionCard(event.tool_name, event.tool_input ?? {}, { permission_suggestions: event.permission_suggestions });
      this.hookAsks.set(requestId, { id: s.id, reply, raw: card.raw, kind: card.kind });
      // Answered on the terminal instead: Claude ends this hook's wait.
      reply.onClose(() => this.closeHookAsk(requestId));
      const pending = this.#sessions.events.append(s.id, { type: 'permission.request', requestId, ...card });
      this.#sessions.emit('event', { id: s.id, event: pending });
      setStatus('blocked');
      return;
    }
    if (name === 'PreModelSwitch') return this.#onNativeModelSwitch(s, event, reply);
    reply(null);
    if (name === 'PostModelSwitch') {
      if (typeof event.to_model === 'string' && event.to_model) {
        s.model = null;
        s.engineModel = event.to_model;
        s.engineEffort = event.effort?.level ?? null;
        this.#core.save();
        this.#sessions.emit('session', { ...wire(s), alive: this.#sessions.nativeTerminals.has(s.id) });
      }
      return;
    }
    // Compacting: Claude says when it starts and when it is done. A turn
    // that ends, a fresh start after the summary, or the CLI closing ends it
    // too, so a missed PostCompact cannot leave it compacting for ever.
    const compacting = (on) => {
      if (!!s.compacting === on) return;
      if (on) s.compacting = Date.now(); else delete s.compacting;
      this.#core.save();
      this.#sessions.emit('session', { ...wire(s), alive: this.#sessions.nativeTerminals.has(s.id), ...pendingSummary(this.#sessions.events.pending(s.id)) });
    };
    if (name === 'PreCompact') { compacting(true); setStatus('working'); return; }
    if (['PostCompact', 'SessionStart', 'Stop', 'SessionEnd', 'UserPromptSubmit'].includes(name)) compacting(false);
    if (name === 'PostCompact') return;
    if (name === 'SessionStart') {
      s.nativeChat = true;
      if (typeof event.model === 'string' && event.model) s.engineModel = event.model;
      if (event.session_id) s.engineSessionId = event.session_id;
      if (event.transcript_path) s.transcript = event.transcript_path;
      this.#core.save();
      if (s.transcript) this.#core.viewers.watchTranscript(s.id, s.transcript);
      this.#sessions.emit('session', { ...wire(s), alive: this.#sessions.nativeTerminals.has(s.id) });
      const read = setTimeout(() => { this.modeReads.delete(read); void this.#readNativeMode(s.id); }, 1500);
      read.unref?.();
      this.modeReads.add(read);
      return;
    }
    // Anything that only happens after the question was settled settles it.
    if (['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'].includes(name)) {
      for (const [requestId, ask] of this.hookAsks) if (ask.id === s.id) this.closeHookAsk(requestId);
    }
    if (name === 'UserPromptSubmit' || name === 'PostToolUse') setStatus('working');
    else if (name === 'Stop' || (name === 'Notification' && event.notification_type === 'idle_prompt')) setStatus('idle');
  }

  /**
   * A terminal Claude keeps its own busy/idle word in its session file.
   * Hooks miss two moments: Stop does not run when a turn is interrupted, so
   * a stopped chat kept reading "working"; and nothing marks a turn Claude
   * starts by itself (a background task finishing) until its first tool
   * ends, so a busy chat read "done". Only a change Claude wrote after Helm's
   * own last status counts, so a fresh hook is never undone by an older file.
   * Questions stay with the hooks, which can answer them.
   */
  syncNativeClaude() {
    const homes = new Map();
    for (const s of this.#core.index.values()) {
      if (!s.nativeChat || s.engine !== 'claude' || !s.engineSessionId || !s.nativeHome) continue;
      if (s.status !== 'working' && s.status !== 'idle') continue;
      if ([...this.hookAsks.values()].some((a) => a.id === s.id)) continue;
      if (!homes.has(s.nativeHome)) homes.set(s.nativeHome, claudeLiveSessions(s.nativeHome));
      // Only this terminal's Claude: another may have resumed the same chat.
      const owners = (homes.get(s.nativeHome).get(s.engineSessionId) ?? [])
        .filter((o) => !!s.nativePid && descendsFrom(o.pid, s.nativePid));
      const live = claudeLiveStatus(owners);
      if ((live !== 'working' && live !== 'idle') || live === s.status) continue;
      if (!owners.some((o) => o.statusAt > (this.#nativeStatusAt.get(s.id) ?? 0))) continue;
      s.status = live; s.updatedAt = Date.now(); this.#core.save();
      this.#sessions.emit('session', { ...wire(s), alive: this.#sessions.nativeTerminals.has(s.id), ...pendingSummary(this.#sessions.events.pending(s.id)) });
    }
  }

  closeHookAsk(requestId, decision) {
    const ask = this.hookAsks.get(requestId);
    if (!ask) return;
    this.hookAsks.delete(requestId);
    const event = this.#sessions.events.append(ask.id, { type: 'permission.resolved', requestId, ...(decision ? { decision } : {}) });
    this.#sessions.emit('event', { id: ask.id, event });
    const s = this.#core.index.get(ask.id);
    if (s && s.status === 'blocked' && ![...this.hookAsks.values()].some((a) => a.id === s.id)) {
      s.status = 'working'; s.updatedAt = Date.now(); this.#nativeStatusAt.set(s.id, Date.now()); this.#core.save();
      this.#sessions.emit('session', { ...wire(s), alive: this.#sessions.nativeTerminals.has(s.id), ...pendingSummary(this.#sessions.events.pending(s.id)) });
    }
  }

  nativeDiscovery = null;
  nativeDiscovered = false;
  /** Native sessions already announced offline since their thread unloaded. */
  #nativeOffline = new Set();
  /** Native threads the last check found open in their terminal daemon. */
  nativeLoaded = new Set();
  /** Accounts whose native daemon is there but did not answer the last check. */
  nativeUnknown = new Set();
  async discoverNativeCodex(profiles) {
    if (!this.#sessions.nativeDiscovery) return;
    if (this.nativeDiscovery) return this.nativeDiscovery;
    const work = (async () => {
      const accounts = new Map();
      for (const p of profiles.filter((p) => p.engine === 'codex')) {
        const home = expand(p.env?.CODEX_HOME || ENGINES.codex.defaultHome);
        if (!accounts.has(home)) accounts.set(home, p);
      }
      const results = await Promise.allSettled([...accounts.values()].map((p) => nativeCodexThreads(p, this.#sessions.log)));
      const accountProfiles = [...accounts.values()];
      for (const [accountIndex, result] of results.entries()) {
        const account = accountProfiles[accountIndex].id;
        // A daemon that is there but did not answer says nothing about its
        // threads: leave them as they are rather than call them stopped.
        if (result.status !== 'fulfilled') { this.nativeUnknown.add(account); continue; }
        this.nativeUnknown.delete(account);
        // No daemon at all (null) means none of its threads is open.
        const loaded = new Set(result.value?.loaded ?? []);
        for (const session of this.#core.index.values()) {
          if (session.nativeSocket && session.profileId === account) this.nativeLoaded.delete(session.engineSessionId);
        }
        for (const id of loaded) this.nativeLoaded.add(id);
        for (const session of this.#core.index.values()) {
          if (!session.nativeSocket || session.profileId !== account || loaded.has(session.engineSessionId)) continue;
          const driver = this.#core.drivers.get(session.id);
          const pending = this.#sessions.events.pending(session.id);
          const open = this.#sessions.events.activeTurn(session.id);
          const turn = open && !String(open.turnId).startsWith('local-') ? open : null;
          const unreachable = this.#core.resumer.unreachable(session);
          // Checked every few seconds: an offline thread already settled
          // here is not saved and announced to every device again.
          if (!driver && session.status === 'idle' && !pending.length && !turn && !unreachable && this.#nativeOffline.has(session.id)) continue;
          this.#nativeOffline.add(session.id);
          await driver?.suspend();
          this.#core.drivers.delete(session.id);
          this.#core.settled(session.id);
          // The terminal that held the thread is gone, and with it any
          // question it asked: nobody can answer that card any more.
          for (const p of pending) {
            const event = this.#sessions.events.append(session.id, { type: 'permission.resolved', requestId: p.requestId, decision: 'cancelled' });
            session.lastSeq = event.seq;
            this.#sessions.emit('event', { id: session.id, event });
          }
          // No daemon holds the thread, so its turn is not running. Close
          // the card the way Codex's own record says it ended.
          if (turn) {
            const outcome = await codexTurnOutcome(session.transcript, turn.turnId);
            const status = outcome === 'ok' ? 'ok' : 'interrupted';
            const error = outcome === 'ok' || outcome === 'interrupted' ? null
              : outcome === 'running' ? 'Codex closed this thread before the turn finished.'
                : 'Codex is no longer running this thread.';
            if (session.delegation && !['done', 'error', 'interrupted'].includes(session.delegation.status)) session.delegation.status = status === 'ok' ? 'done' : status;
            const event = this.#sessions.events.append(session.id, { type: 'turn.done', turnId: turn.turnId, status, ...(error ? { error } : {}) });
            session.lastSeq = event.seq;
            this.#sessions.emit('event', { id: session.id, event });
          }
          if (session.status !== 'idle') {
            const event = this.#sessions.events.append(session.id, { type: 'status', status: 'idle' });
            session.lastSeq = event.seq;
            this.#sessions.emit('event', { id: session.id, event });
          }
          session.status = 'idle';
          if (session.delegation) this.#core.delegation.updateTeam(session);
          this.#core.resumer.reconnected(session);
          this.#core.save();
          this.#sessions.emit('session', { ...wire(session), alive: false, pending: 0, ask: null });
          // With a daemon to reopen it, what was queued behind the turn goes.
          if (result.value) this.#core.delivery.pump(session);
        }
        if (!result.value) continue;
        for (const thread of result.value.threads) {
          const removed = `found:codex:${thread.id}`;
          if (this.#core.marks.get(removed) === 'removed') {
            // Removing hides it; using it again in the terminal undoes that.
            const at = this.#core.removedAt.get(removed);
            if (!at || thread.updatedAt * 1000 <= at) continue;
            this.#core.marks.delete(removed);
            this.#core.removedAt.delete(removed);
          }
          const existing = [...this.#core.index.values()].find((s) => s.engine === 'codex' && s.engineSessionId === thread.id);
          // An idle Helm conversation resumed in a normal terminal moves to
          // that daemon too. Never detach a private turn that is still active.
          if (existing?.driver && !existing.external && !existing.nativeSocket
            && (['working', 'blocked', 'starting'].includes(existing.status) || this.#sessions.hasActiveDelegations(existing.id))) continue;
          const s = existing ?? { id: randomBytes(6).toString('hex'), createdAt: thread.createdAt * 1000 };
          this.#nativeOffline.delete(s.id);
          const first = !s.nativeSocket;
          const gainedTranscript = !s.transcript && !!thread.path;
          if (first) {
            await this.#core.drivers.get(s.id)?.suspend?.();
            this.#core.drivers.delete(s.id);
            delete s.mode;
          }
          Object.assign(s, { engine: 'codex', engineSessionId: thread.id,
            profileId: thread.profileId, cwd: thread.cwd, transcript: thread.path,
            driver: 'codex', nativeSocket: thread.nativeSocket, nativeCodex: true,
            shared: true, external: false, externalActive: false, externalSource: true, adopted: false,
            updatedAt: thread.updatedAt * 1000 });
          if (!s.titleBy) s.title = thread.name || thread.preview?.slice(0, 80) || (s.quick ? 'Quick chat' : basename(thread.cwd));
          // The snapshot names a newly found thread's state. After that the
          // live thread is the authority: this read can be older than the
          // notification that just arrived, and writing it here silently
          // either hid live work as idle or left a finished turn running.
          const blocked = thread.status?.activeFlags?.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput');
          const reported = blocked ? 'blocked' : thread.status?.type === 'active' ? 'working' : 'idle';
          if (first) s.status = reported;
          this.#core.index.set(s.id, s);
          if (first) {
            this.#core.save();
            this.#sessions.emit('session', { ...wire(s), alive: true });
          }
          // A chat Helm started already shows every turn live. Copying the
          // CLI's file in when it first appears put each message on screen
          // twice, below the live reply, with Codex's instructions as a
          // message of their own: only move the reading point past it.
          const live = !first && gainedTranscript
            && this.#sessions.events.tail(s.id, 0).some((e) => e.type === 'turn.start' && !e.imported);
          if (live) await this.#core.external.skipExternalTranscript(s);
          else if (first || gainedTranscript) await this.#core.external.importExternalTranscript(s);
          {
            try {
              const d = await this.#core.driver(s);
              d.transcript = s.transcript;
              // A driver that (re)connects reads the thread and reports it;
              // starting from the recorded state makes any change a real one.
              if (!d.nativeConnected) d.status = s.status;
              await d.start();
              if (s.recovery?.kind === 'error') { this.#core.resumer.reconnected(s); this.#core.delivery.pump(s); }
            } catch (err) {
              this.#core.drivers.delete(s.id);
              this.#sessions.log(`codex native attach: ${err.message}`);
              // Without a live stream the daemon's own report is the best
              // there is; record it as a real change rather than keep a
              // remembered label.
              if (s.status !== reported) {
                s.status = reported;
                s.updatedAt = Date.now();
                const event = this.#sessions.events.append(s.id, { type: 'status', status: reported });
                s.lastSeq = event.seq;
                this.#core.save();
                this.#sessions.emit('event', { id: s.id, event });
                this.#sessions.emit('session', { ...wire(s), alive: false });
              }
            }
          }
        }
      }
    })();
    this.nativeDiscovery = work;
    try { await work; this.nativeDiscovered = true; } finally { if (this.nativeDiscovery === work) this.nativeDiscovery = null; }
  }

  adoptNative(meta) {
    if (!meta?.id || !ENGINES[meta.engine]?.bin || ENGINES[meta.engine].plain) return;
    if (this.#core.index.has(meta.id)) {
      const existing = this.#core.index.get(meta.id);
      if (existing.nativeCli && existing.nativeChat !== !!meta.nativeChat) {
        existing.nativeChat = !!meta.nativeChat; this.#core.save();
      }
      return;
    }
    const session = { id: meta.id, engine: meta.engine, cwd: meta.cwd,
      title: basename(meta.cwd) || meta.engine, titleBy: null,
      profileId: null, pty: true, nativeCli: true, shared: true,
      nativePid: meta.nativePid, nativeHome: meta.configHome,
      nativeChat: !!meta.nativeChat,
      ...(meta.settings?.model ? { engineModel: meta.settings.model } : {}),
      ...(meta.settings?.effort ? { engineEffort: meta.settings.effort } : {}),
      ...(meta.settings?.mode ? { mode: meta.settings.mode } : {}),
      ...(meta.conversation ? { engineSessionId: meta.conversation } : {}),
      status: 'idle', createdAt: meta.createdAt, updatedAt: meta.createdAt };
    this.#core.index.set(meta.id, session);
    this.#core.save();
    this.#sessions.emit('session', { ...wire(session), alive: true });
  }

  nativeSettings(s, info) {
    let changed = false;
    for (const [source, target] of [['model', 'engineModel'], ['effort', 'engineEffort'], ['mode', 'mode'], ['permissionControl', 'permissionControl']]) {
      if (!Object.hasOwn(info, source)) continue;
      const value = info[source];
      if (value !== null && (typeof value !== 'string' || value.length > 200)) continue;
      if (s[target] !== value) { s[target] = value; changed = true; }
      // Accepted provider settings outrank old choices in the tray.
      if (source === 'model' || source === 'effort') {
        if (s[source] != null) { s[source] = null; changed = true; }
      }
    }
    if (typeof info.session_id === 'string' && s.engine === 'pi') {
      if (s.engineSessionId !== info.session_id) { s.engineSessionId = info.session_id; changed = true; }
      if (typeof info.transcript_path === 'string' && s.transcript !== info.transcript_path) { s.transcript = info.transcript_path; changed = true; }
    }
    if (!changed) return;
    this.#core.save();
    this.#sessions.emit('session', { ...wire(s), alive: this.#sessions.nativeTerminals.has(s.id) });
  }

  /** Open the same process's native picker. Byte delivery never claims a setting changed. */
  async control(id, kind) {
    const s = this.#sessions.get(id);
    if (!s.nativeCli) throw new Error('this session is not a shared CLI');
    const command = nativeControlCommand(s.engine, kind);
    return this.nativeWrite(s, command);
  }

  /**
   * Text in a terminal Claude's typing box joins whatever Helm types next. A
   * leftover "/permissions" made every later message a slash command Enter
   * could not run, so nothing the owner sent arrived. But the text may be
   * something the owner is typing right now, so it is put aside, not thrown
   * away: Ctrl+S stashes it and Claude puts it back once Helm's message is
   * sent. A second Ctrl+S would replace a draft already stashed, so then each
   * line is cut instead, and Ctrl+Y in the terminal brings back the last one cut.
   * Claude reads keys that arrive in one burst as typed text and drops the
   * Ctrl+U, so each key is its own write. An empty box, or a screen Helm
   * cannot read (a menu is open), gets no keys at all.
   */
  async clearClaudeBox(s) {
    if (s.engine !== 'claude') return;
    const host = this.#sessions.nativeTerminals;
    const read = async () => {
      try { return claudeBox(await host.view(s.id)); }
      catch { return null; }
      finally { if (!this.#sessions.watching(s.id)) host.unview(s.id); }
    };
    let box = await read();
    if (!box?.draft) return;
    if (!box.stashed) {
      await host.write(s.id, '\x13');
      for (let end = Date.now() + 1000; box?.draft && Date.now() < end;) { await pause(50); box = await read(); }
    }
    // Ctrl+U cuts left of the cursor and Ctrl+K the rest of the line (or the
    // line break, once the line is empty); Backspace joins the line above.
    for (let round = 0; box?.draft && round < 40; round++) {
      for (const key of ['\x15', '\x0b', '\x7f']) { await host.write(s.id, key); await pause(15); }
      box = await read();
    }
    // Claude reads these keys and the paste that follows as one burst otherwise, and loses the paste.
    await pause(100);
  }

  async nativeWrite(s, text, { control = true, confirmedMode = null } = {}) {
    const id = s.id;
    const work = (this.nativeInputs.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.#sessions.nativeTerminals.has(id)) throw new Error('This CLI is no longer running.');
      if ((control && s.status === 'blocked') || [...this.hookAsks.values()].some(ask => ask.id === id)) throw new Error('Answer the CLI question first.');
      if (control && s.status === 'working') throw new Error('Wait until the CLI finishes its turn before changing settings.');
      if (confirmedMode && s.mode === confirmedMode) return { ok: true, session: wire(s) };
      if (text != null) {
        await this.clearClaudeBox(s);
        await this.#sessions.nativeTerminals.write(id, `\x1b[200~${text}\x1b[201~`);
        await new Promise(resolve => setTimeout(resolve, 60));
        await this.#sessions.nativeTerminals.write(id, '\r');
      }
      if (confirmedMode) {
        const end = Date.now() + 3500;
        while (s.mode !== confirmedMode && this.#sessions.nativeTerminals.has(id) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30));
        if (s.mode !== confirmedMode) throw new Error('bash-guard did not report the requested state.');
        return { ok: true, session: wire(s) };
      }
      return { ok: true, terminal: true, ...(text != null ? { command: text } : {}) };
    });
    this.nativeInputs.set(id, work);
    try { return await work; }
    finally { if (this.nativeInputs.get(id) === work) this.nativeInputs.delete(id); }
  }

  /** The permission mode a terminal Claude's footer shows, until a hook says it. */
  async #readNativeMode(id) {
    const s = this.#core.index.get(id);
    if (!s?.nativeChat || !this.#sessions.nativeTerminals.has(id)) return;
    const footer = new ModeFooter();
    try { footer.feed(await this.#sessions.nativeTerminals.view(id)); }
    catch { return; }
    finally { if (!this.#sessions.watching(id)) this.#sessions.nativeTerminals.unview(id); }
    const mode = MODE_FROM_LABEL[footer.label()];
    if (!mode || s.mode === mode || this.#core.index.get(id) !== s) return;
    s.mode = mode;
    this.#core.save();
    this.#sessions.emit('session', { ...wire(s), alive: this.#sessions.nativeTerminals.has(id), ...pendingSummary(this.#sessions.events.pending(id)) });
  }

  /**
   * A terminal Claude has no command that sets its permission mode; the
   * person at the keyboard presses shift+tab until the footer names the one
   * they want. Do exactly that, reading the footer after each press, so the
   * chip only changes once Claude shows the new mode. A mode this Claude
   * does not offer (bypass needs it started with
   * --allow-dangerously-skip-permissions) comes back round to where it
   * started, and says so.
   */
  async nativeMode(s, mode) {
    const want = MODE_LABELS[mode];
    if (!want || !MODES.claude.some((m) => m.id === mode)) throw new Error('invalid Claude permission mode');
    const id = s.id;
    const work = (this.nativeInputs.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.#sessions.nativeTerminals.has(id)) throw new Error('Claude is no longer running in that terminal.');
      if ([...this.hookAsks.values()].some((a) => a.id === id)) throw new Error('Answer Claude\'s question first.');
      const host = this.#sessions.nativeTerminals;
      const footer = new ModeFooter();
      const onData = (d) => { if (d.id === id) footer.feed(d.text); };
      host.on('data', onData);
      // One press, then the mode the footer settles on.
      const press = async () => {
        footer.mark();
        if ([...this.hookAsks.values()].some(ask => ask.id === id)) throw new Error('Answer Claude\'s question first.');
        await host.write(id, '\x1b[Z');
        const end = Date.now() + 1500;
        let found = null, at = Date.now();
        while (Date.now() < end) {
          await new Promise((r) => setTimeout(r, 50));
          const label = footer.label();
          if (label !== found) { found = label; at = Date.now(); }
          if (found && Date.now() - at > 250) break;
        }
        // Older builds draw nothing for the default mode.
        return found ?? 'unlabelled';
      };
      try {
        // Everything drawn so far, so a redraw that skips unchanged
        // characters still reads whole.
        footer.feed(await host.view(id).catch(() => ''));
        const initial = footer.label();
        const before = initial ?? MODE_LABELS[s.mode];
        if (!before) throw new Error('Claude has not reported its permission mode. Open the terminal to check it.');
        if (before === want) {
          s.mode = mode; this.#core.save();
          return { ok: true, session: wire(s) };
        }
        let start = null;
        for (let n = 0; n < 8; n++) {
          const label = await press();
          if (label === want) {
            s.mode = mode; s.updatedAt = Date.now(); this.#core.save();
            this.#sessions.emit('session', { ...wire(s), alive: host.has(id), ...pendingSummary(this.#sessions.events.pending(id)) });
            return { ok: true, session: wire(s) };
          }
          if (start === null) start = label;
          else if (label === start) break;
        }
        if (start === null || start === 'unlabelled') throw new Error('Claude did not show its permission mode after shift+tab. Open the terminal to check it.');
        // Round once more to the mode it was in, rather than leave it moved.
        for (let n = 0; before && n < 8; n++) if (await press() === before) break;
        const name = MODES.claude.find((m) => m.id === mode)?.label ?? mode;
        throw new Error(mode === 'bypassPermissions'
          ? `${name} is not offered by this Claude. Start it with --allow-dangerously-skip-permissions to use it.`
          : `${name} is not offered by this Claude.`);
      } finally {
        host.off('data', onData);
        if (!this.#sessions.watching(id)) host.unview(id);
      }
    });
    this.nativeInputs.set(id, work);
    try { return await work; }
    finally { if (this.nativeInputs.get(id) === work) this.nativeInputs.delete(id); }
  }

  /**
   * The pickers a running agent advertised, when the driver is live. ACP
   * agents report their model list - with real names - at session start,
   * which beats anything a CLI subcommand can print. Null when the driver
   * is not up or reports nothing.
   */
  async refreshNativeSettings(id) {
    const s = this.#sessions.get(id);
    if (s.nativeChat && s.engine === 'claude') await this.#readNativeMode(id);
  }

  /**
   * Type `/model` into a terminal Claude the app is showing as a chat, and
   * let Claude's PreModelSwitch hook say what it costs. Claude's own
   * "this re-caches the conversation" question would sit unseen in the
   * terminal behind the chat, so Helm answers the hook: a confirmed pick or
   * a cold cache goes ahead without it, and a warm one comes back as
   * `{ ask }` for the app to ask. A Claude too old to run the hook just
   * switches; after a few seconds the answer is the plain typing result.
   */
  async nativeModelSwitch(s, value, ask) {
    let settle;
    const heard = new Promise((resolve) => { settle = resolve; });
    const entry = { ask, settle };
    this.#modelSwitches.set(s.id, entry);
    const forget = () => { if (this.#modelSwitches.get(s.id) === entry) this.#modelSwitches.delete(s.id); };
    try {
      const typed = await this.#sessions.input(s.id, `/model ${value}`);
      const outcome = await Promise.race([heard, new Promise((resolve) => setTimeout(resolve, 5000, null).unref?.())]);
      return outcome?.ask ? { ok: false, ask: outcome.ask, session: s } : typed;
    } finally { forget(); }
  }

  #onNativeModelSwitch(s, event, reply) {
    const entry = this.#modelSwitches.get(s.id);
    // Typed at the keyboard: Claude asks there itself, where the person is.
    if (!entry) return reply(null);
    this.#modelSwitches.delete(s.id);
    const tokens = Number(event.context_tokens);
    if (entry.ask && event.prompt_cache_warm === true && tokens >= WORTH_SAYING) {
      const usd = Number(event.estimated_cache_write_usd);
      reply({ hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'deny',
        permissionDecisionReason: 'Helm is asking the owner first: this switch rewrites a warm prompt cache.' } });
      entry.settle({ ask: { tokens, costUsd: Number.isFinite(usd) ? usd : null,
        ...(typeof event.cache_ttl === 'string' && { ttl: event.cache_ttl }) } });
      return;
    }
    reply({ hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'allow' } });
    entry.settle({});
  }
}
