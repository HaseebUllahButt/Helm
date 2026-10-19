import { piChatArgs } from './pi-settings.js';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { expand } from './paths.js';
import { getProfiles } from './profiles.js';
import { messages as readMessages, sessionActivity } from './transcript.js';
import { ENGINES, isInteractiveProc } from './engines.js';
import { EVENT_KEEP } from './events.js';
import { accountKey } from './settings.js';
import { defaultMode } from './modes.js';
import { inventory } from './inventory.js';
import { opencodeServiceActive, opencodeServiceSessions } from './opencode-service.js';
import { claudeLiveSessions, claudeLiveStatus } from './external-process.js';
import { readProcess, resumeCommand, safePoint, stopProcess, tellTerminal } from './takeover.js';
import { openFiles, processArgv, processCwd } from './procinfo.js';
import { claudeChatArgs } from './claude-hooks.js';
import { wire } from './session-wire.js';
import { externalInput } from './session-transcript-events.js';

/**
 * Conversations a CLI recorded on its own, opened in Helm: read from the
 * CLI's files while another process owns them, taken over on request, and
 * driven by Helm once it may write.
 */
export class ExternalSessions {
  #sessions;
  #core;
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  /** sessionId -> an in-flight managed connection shared by joining clients */
  #connections = new Map();
  /** session object -> in-flight full-rollout reconciliation */
  #imports = new WeakMap();

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
    for (const s2 of this.#core.index.values()) {
      if (s2.engineSessionId === id && (s2.driver || s2.external)) return this.#sessions.get(s2.id);
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
    // Fresh enough to trust: the row was on screen a moment ago. Liveness is
    // rechecked when a message is sent, so a stale "active" costs nothing.
    const recent = this.#core.lastDetected && Date.now() - this.#core.lastDetected.at < 30_000
      ? this.#core.lastDetected.byId.get(`${engine}:${id}`) : null;
    const found = recent ?? (await inventory(profiles.filter((p) => p.engine === engine), { limit: Infinity })).find((x) => x.engine === engine && x.id === id);
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
        // What the CLI will pick back up when it resumes this conversation:
        // reported, never passed as a choice on the next launch.
        engineModel: found.model ?? null,
        engineEffort: found.effort ?? null,
        transcript: found.transcript || null,
        externalLock: engine === 'codex'
          ? join(expand(homeOf(profile)), 'thread-writer-locks', `${id}.lock`) : null,
        external: true,
        externalHome: homeOf(profile),
        externalSource: true,
        externalActive: false,
        driver: engine,
        adopted: true,
        status: found.status ?? 'idle',
        turns: found.turns ?? 0,
        createdAt: Date.now(),
        updatedAt: found.updatedAt || Date.now(),
      };
      this.#core.index.set(session.id, session);
      this.#core.save();
      this.#sessions.emit('session', session);
      await this.importExternalTranscript(session);
      this.#core.viewers.watchTranscript(session.id, session.transcript);
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
        engineModel: found.model ?? null,
        engineEffort: found.effort ?? null,
        transcript: found.transcript,
        externalLock,
        externalPid: found.writerPid || null,
        externalService: !!found.serviceActive,
        driver: engine,
        external: true,
        externalHome: homeOf(profile),
        externalSource: true,
        externalActive: true,
        adopted: true,
        status: found.status ?? 'idle',
        turns: found.turns ?? 0,
        createdAt: Date.now(),
        updatedAt: found.updatedAt || Date.now(),
      };
      this.#core.index.set(session.id, session);
      this.#core.save();
      this.#sessions.emit('session', session);
      await this.importExternalTranscript(session);
      this.#core.viewers.watchTranscript(session.id, session.transcript);
      return session;
    }

    const session = await this.#core.startDriven({
      cwd: cwd || '~', profile, title: title || null,
      model: null, effort: null, mode: null, auto: null,
      engineSessionId: id, transcript: found?.transcript ?? null,
    });
    session.externalSource = true;
    session.externalImported = 0;
    // app-server resumes with metadata only; the rollout is the source of
    // truth for the conversation that happened before Helm picked it up.
    await this.importExternalTranscript(session);
    this.#core.save();
    // Nothing to mark: the row it came from is matched to this session by
    // its engineSessionId and drops out of the list on the next refresh
    // (`dedupeDetected` in the web app), which is also what stops a resumed
    // thread appearing twice.
    return session;
  }

  async refreshExternalActivity(s, active = this.externalActive(s)) {
    if (s.engine === 'opencode2') {
      await opencodeServiceSessions();
      active = this.externalActive(s);
    }
    const activity = await sessionActivity({ engine: s.engine, path: s.transcript,
      sessionId: s.engineSessionId, active, updatedAt: s.updatedAt,
      liveStatus: s.engine === 'opencode2' && opencodeServiceActive(s.engineSessionId) ? 'working' : s.engine === 'claude' && s.externalHome
        ? claudeLiveStatus(claudeLiveSessions(s.externalHome).get(s.engineSessionId) ?? []) : null });
    if (!s.external || this.#core.index.get(s.id) !== s) return { status: s.status, turns: s.turns ?? 0 };
    if (s.status !== activity.status || s.externalActive !== active || s.turns !== activity.turns) {
      const from = s.status;
      Object.assign(s, activity, { externalActive: active });
      this.#core.save();
      this.#sessions.emit('session', s);
      if (from !== s.status) this.#sessions.emit('status', { session: s, from, to: s.status });
    }
    return activity;
  }

  externalActive(s) {
    if (!s.external) return false;
    if (s.engine === 'opencode2' && opencodeServiceActive(s.engineSessionId)) return true;
    if (s.engine === 'claude' && s.externalHome
      && claudeLiveSessions(s.externalHome).has(s.engineSessionId)) return true;
    if (s.engine === 'codex' && s.externalLock && existsSync(s.externalLock)) return true;
    if (!s.externalPid) return false;
    try { process.kill(s.externalPid, 0); return this.#processOwnsTranscript(s); }
    catch { return false; }
  }

  #processOwnsTranscript(s) {
    if (!s.externalPid || !s.transcript) return false;
    if (s.engine === 'claude' && s.externalHome) {
      const owners = claudeLiveSessions(s.externalHome).get(s.engineSessionId) ?? [];
      if (owners.length) return owners.length === 1 && owners[0].pid === s.externalPid && !!owners[0].procStart;
    }
    // An open file descriptor is the strongest claim - it names the exact
    // transcript. Database stores and append-per-write logs are not held
    // open though, so for those engines inventory matched the process by
    // its interactive argv and directory instead; re-check the same way.
    const held = openFiles([s.externalPid], (path) => path === s.transcript).length > 0;
    if (held) return true;
    const byProc = ['opencode', 'opencode2', 'devin', 'pi', 'omp', 'grok', 'cursor', 'muse'].includes(s.engine);
    if (!byProc) return false;
    const argv = processArgv(s.externalPid);
    if (!argv || !isInteractiveProc(s.engine, argv)) return false;
    return processCwd(s.externalPid) === s.cwd;
  }

  /** A transcript is history, not a live provider control connection. */
  async handoffExternal(s) {
    // Re-discover at send time: a monitor may have been opened before the
    // CLI started or before its process changed. Never start a second writer
    // from a cached 'done' row, or terminate a turn that is still doing work.
    if (s.engine === 'opencode2') {
      const live = await opencodeServiceSessions({ fresh: true });
      // A shared service may own this exact chat even when its status read fails.
      if (live.running && !live.available) throw new Error('OpenCode 2 is not responding. Try again before continuing this chat.');
    }
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === s.profileId);
    s.externalHome = profile?.env?.[ENGINES[s.engine]?.homeEnv] ?? ENGINES[s.engine]?.defaultHome;
    const found = (await inventory(profiles.filter((p) => p.engine === s.engine), { limit: Infinity })).find((x) => x.engine === s.engine && x.id === s.engineSessionId);
    if (found) { s.externalPid = found.writerPid; s.transcript = found.transcript; s.externalService = !!found.serviceActive; }
    if (!this.externalActive(s)) return;
    await this.refreshExternalActivity(s, true);
    if (opencodeServiceActive(s.engineSessionId) && s.engine === 'opencode2') throw new Error('This OpenCode 2 chat is still running. Wait for its current step to finish, then send here.');
    throw new Error(`This ${s.engine} chat was started outside Helm's shared terminal. Use Take over above to continue here without manually closing it. New terminal chats share automatically when Helm's CLI integration is on.`);
  }

  #takeovers = new Map();

  /**
   * Bring a CLI that was open before Helm into a terminal both sides share,
   * without cutting its work off: it moves at the prompt, or right after the
   * step it is on, then carries on. The app follows it to the new thread.
   */
  async takeOver(id) {
    const s = this.#sessions.get(id);
    if (s.engine === 'opencode2') {
      await opencodeServiceSessions({ fresh: true });
      if (opencodeServiceActive(s.engineSessionId)) throw new Error('Wait for this OpenCode 2 step to finish, then send here.');
    }
    if (!s.external || !this.externalActive(s)) throw new Error('this conversation is not open in a terminal');
    if (!ENGINES[s.engine]?.resumeArgs) throw new Error(`${ENGINES[s.engine]?.label ?? s.engine} cannot be moved yet; close it in the terminal to continue here`);
    if (this.#takeovers.has(id)) return { waiting: true };
    const owners = s.engine === 'claude' ? claudeLiveSessions(s.externalHome).get(s.engineSessionId) ?? [] : [];
    const pid = owners[0]?.pid ?? s.externalPid;
    if (!pid) throw new Error('could not find the terminal this conversation is open in');
    readProcess(pid); // fails now, not after the wait, if it cannot be read
    const cancel = new AbortController();
    this.#takeovers.set(id, cancel);
    s.takeover = 'waiting';
    this.#sessions.emit('session', { ...wire(s), alive: true });
    const status = () => {
      if (s.engine === 'claude') return claudeLiveStatus(claudeLiveSessions(s.externalHome).get(s.engineSessionId) ?? []) ?? s.status;
      return s.status;
    };
    (async () => {
      const { wasWorking } = await safePoint({ status, transcript: s.transcript, signal: cancel.signal, pid });
      const proc = readProcess(pid);
      const first = (await readMessages({ engine: s.engine, path: s.transcript, sessionId: s.engineSessionId, all: true }))
        .find((m) => m.role === 'user')?.text ?? '';
      const resumed = resumeCommand(s.engine, proc.argv, s.engineSessionId, first);
      const nativeChat = s.engine === 'claude' && proc.env.HELM_NATIVE_CHAT !== '0';
      const cmd = resumed.cmd, args = nativeChat ? claudeChatArgs(resumed.args, proc.cwd || expand(s.cwd)) : s.engine === 'pi' ? piChatArgs(resumed.args) : resumed.args;
      if (cancel.signal.aborted) throw new Error('cancelled');
      // Prepare the host before closing the original provider.
      if (!await this.#sessions.nativeTerminals.ensure()) throw new Error('the shared terminal could not start');
      if (cancel.signal.aborted) throw new Error('cancelled');
      await stopProcess(pid);
      const moved = `native-${randomBytes(8).toString('hex')}`;
      const configHome = expand(proc.env[ENGINES[s.engine].homeEnv] || ENGINES[s.engine].defaultHome);
      const opened = await this.#sessions.nativeTerminals.open(moved, { cmd, args, cwd: proc.cwd || expand(s.cwd), cols: 120, rows: 36,
        exactEnv: true, env: { ...proc.env, HELM_NATIVE_SESSION: moved },
        native: { engine: s.engine, configHome, conversation: s.engineSessionId, nativeChat } });
      this.#core.natives.adoptNative({ id: moved, engine: s.engine, cwd: proc.cwd || expand(s.cwd), configHome, nativePid: opened.pid, nativeChat, createdAt: Date.now() });
      const next = this.#core.index.get(moved);
      Object.assign(next, { engineSessionId: s.engineSessionId, transcript: s.transcript, profileId: s.profileId,
        title: s.title, titleBy: s.titleBy, status: wasWorking ? 'working' : 'idle' });
      const bin = ENGINES[s.engine].bin;
      tellTerminal(proc.tty, `Helm: this chat moved to Helm. Type \`${bin} ${s.engine === 'codex' ? 'resume --last' : '-c'}\` here to keep using it in this window.`);
      if (wasWorking) await this.#nudge(moved);
      this.#takeovers.delete(id);
      this.#core.drivers.get(id)?.kill?.();
      this.#core.drivers.delete(id);
      this.#core.index.delete(id);
      this.#core.save();
      this.#sessions.emit('session', { ...wire(s), takeover: null, status: 'exited', alive: false, movedTo: { ...wire(next), alive: true } });
      this.#sessions.emit('session', { ...wire(next), alive: true });
    })().catch((err) => {
      this.#takeovers.delete(id);
      s.takeover = null;
      if (err.message !== 'cancelled') this.#sessions.log(`take over ${id}: ${err.message}`);
      this.#sessions.emit('session', { ...wire(s), alive: this.externalActive(s), takeoverError: err.message === 'cancelled' ? null : err.message });
    });
    return { waiting: true };
  }

  cancelTakeOver(id) {
    this.#takeovers.get(id)?.abort();
    return { ok: true };
  }

  /** Once the reopened CLI has drawn its screen and gone quiet, say carry on. */
  async #nudge(id) {
    const host = this.#sessions.nativeTerminals;
    let last = 0, seen = false;
    const onData = (d) => { if (d.id === id) { seen = true; last = Date.now(); } };
    host.on('data', onData);
    try {
      await host.view(id, { cols: 120, rows: 36 });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && (!seen || Date.now() - last < 2000)) await new Promise((r) => setTimeout(r, 200));
      await host.write(id, 'continue');
      await new Promise((r) => setTimeout(r, 300));
      await host.write(id, '\r');
    } finally {
      host.off('data', onData);
      host.unview(id);
    }
  }

  /** Both frontends use this provider; disconnecting a frontend leaves it alive. */
  async connect(id) {
    if (this.#connections.has(id)) return this.#connections.get(id);
    const work = this.#connect(id);
    this.#connections.set(id, work);
    try { return await work; }
    finally { this.#connections.delete(id); }
  }

  async #connect(id) {
    const s = this.#sessions.get(id);
    if (s.external) {
      await this.importExternalTranscript(s);
      await this.handoffExternal(s);
      Object.assign(s, { external: false, externalActive: false, adopted: false,
        externalLock: null, driver: s.engine, status: 'idle', notifyDone: true });
      s.mode ??= defaultMode(s.engine);
      this.#core.drivers.get(id)?.enableWriting?.();
    }
    if (!s.driver) throw new Error('this session does not have a managed provider');
    const d = await this.#core.driver(s);
    await d.start();
    s.engineSessionId = d.engineSessionId;
    s.shared = true;
    s.updatedAt = Date.now();
    clearTimeout(this.#core.reapers.get(id));
    this.#core.reapers.delete(id);
    this.#core.save();
    this.#sessions.emit('session', { ...s, alive: true });
    return { ...wire(s), alive: true };
  }

  /** Seed Helm's event view with the transcript it was monitoring. */
  async importExternalTranscript(s) {
    const running = this.#imports.get(s);
    if (running) return running;
    const work = this.#readExternalTranscript(s);
    this.#imports.set(s, work);
    try { return await work; } finally { this.#imports.delete(s); }
  }

  /** Mark the CLI's history as already shown, without copying any of it. */
  async skipExternalTranscript(s) {
    if (!s.transcript) return;
    const messages = await readMessages({
      engine: s.engine, path: s.transcript, sessionId: s.engineSessionId, all: true,
    }).catch(() => null);
    if (!messages) return;
    s.externalImported = messages.length;
    s.externalImagesVersion = 1;
    s.externalTail = null;
    if (this.#core.index.has(s.id)) this.#core.save();
  }

  async #readExternalTranscript(s) {
    if (!s.transcript) return;
    const messages = await readMessages({
      engine: s.engine, path: s.transcript, sessionId: s.engineSessionId, all: true,
    });
    // Claude chats copied before replies were read whole are missing what
    // Claude said between its tool calls: copy those once more, from scratch.
    if (s.engine === 'claude' && s.external && (s.externalImported ?? 0) > 0 && s.externalTextVersion !== 1) {
      this.#sessions.events.restart(s.id);
      s.externalImported = 0;
      s.externalTail = null;
    }
    if (s.engine === 'claude') s.externalTextVersion = 1;
    let imported = Math.min(s.externalImported ?? 0, messages.length);
    if (s.engine === 'codex' && s.externalImagesVersion !== 1 && imported) {
      // The old parser omitted image-only messages entirely. Translate its
      // cursor before continuing, rather than importing old answers twice.
      let oldCount = 0, index = 0;
      for (const message of messages) {
        if (oldCount >= imported) break;
        index++;
        if (!message.attachments?.length || message.rawText || message.tools?.length) oldCount++;
      }
      imported = index;
      s.externalImported = imported;
    }
    const nextId = () => `imported-${randomBytes(8).toString('hex')}`;
    const append = (event) => {
      const saved = this.#sessions.events.append(s.id, event);
      s.lastSeq = saved.seq;
      this.#sessions.emit('event', { id: s.id, event: saved.attachments?.length ? this.#sessions.events.since(s.id, saved.seq - 1)[0] : saved });
    };
    // Existing imports already consumed these messages before image blocks
    // were supported. Recover only retained user bubbles, with append-only
    // corrections so their ids, replies, and cached cursors stay intact.
    if (s.engine === 'codex' && s.externalImagesVersion !== 1) {
      const images = new Map();
      for (const message of messages.slice(0, imported)) {
        if (!message.attachments?.length) continue;
        const key = message.rawText ?? message.text;
        if (!key) continue;
        // Without a source id, identical old prompts cannot safely identify
        // which image belonged to which turn.
        images.set(key, images.has(key) ? null : message);
      }
      const corrected = new Set(this.#sessions.events.tail(s.id, 0).filter((e) => e.type === 'turn.images').map((e) => e.turnId));
      for (const event of [...this.#sessions.events.tail(s.id, 0)]) {
        if (event.type !== 'turn.start' || !String(event.turnId).startsWith('imported-') || event.attachments?.length || corrected.has(event.turnId)) continue;
        const message = images.get(event.text);
        if (!message) continue;
        append({ type: 'turn.images', turnId: event.turnId, text: message.text,
          attachments: message.attachments.map((a) => this.#sessions.events.putAttachment(s.id, a)),
        });
      }
      s.externalImagesVersion = 1;
      if (this.#core.index.has(s.id)) this.#core.save();
    }
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
          append({ type: 'item.start', id: itemId, turnId: tail.turnId, kind: 'tool', name: tool.name, input: externalInput(tool) });
          append({ type: 'item.done', id: itemId, turnId: tail.turnId, status: 'ok' });
        }
        tail.text = text;
        tail.tools = last.tools?.length ?? 0;
        if (this.#core.index.has(s.id)) this.#core.save();
      }
      return;
    }
    // The log keeps its last couple of thousand events. A long chat opened
    // for the first time used to write every one and trim as it went, which
    // got slower the longer the chat: start where the kept part starts, on
    // a message the owner wrote. The CLI's own history still has the rest.
    const cost = (m) => m.role === 'user' ? 1 : (m.tools?.length ?? 0) * 2 + (m.text ? 3 : 0) + 1;
    let budget = EVENT_KEEP * 0.8, from = messages.length;
    while (from > imported && budget - cost(messages[from - 1]) > 0) budget -= cost(messages[--from]);
    if (from > imported) {
      while (from < messages.length && messages[from].role !== 'user') from++;
      imported = from;
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
        append({ type: 'turn.start', turnId, text: message.text ?? '', imported: true,
          ...(message.attachments?.length ? { attachments: message.attachments.map((a) => this.#sessions.events.putAttachment(s.id, a)) } : {}),
        });
        continue;
      }
      if (!turnId) {
        turnId = nextId();
        append({ type: 'turn.start', turnId, text: '', imported: true });
      }
      // What Claude says comes before the calls it makes in the same reply.
      let textItemId = null;
      if (message.text) {
        textItemId = nextId();
        append({ type: 'item.start', id: textItemId, turnId, kind: 'text' });
        append({ type: 'item.delta', id: textItemId, turnId, text: message.text });
        append({ type: 'item.done', id: textItemId, turnId, status: 'ok' });
      }
      for (const tool of message.tools ?? []) {
        const itemId = nextId();
        append({ type: 'item.start', id: itemId, turnId, kind: 'tool', name: tool.name, input: externalInput(tool) });
        append({ type: 'item.done', id: itemId, turnId, status: 'ok' });
      }
      if (message.sourceId) s.externalTail = {
        sourceId: message.sourceId, turnId, itemId: textItemId,
        text: message.text ?? '', tools: message.tools?.length ?? 0,
      };
    }
    close();
    s.externalImported = messages.length;
    if (this.#core.index.has(s.id)) this.#core.save();
  }
}
