import { piChatArgs } from './pi-settings.js';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { expand } from './paths.js';
import { getProfiles } from './profiles.js';
import { messages as readMessages, sessionActivity, IncrementalTranscript } from './transcript.js';
import { ENGINES, isInteractiveProc } from './engines.js';
import { EVENT_KEEP } from './events.js';
import { EventFile } from './event-file.js';
import { accountKey } from './settings.js';
import { defaultMode } from './modes.js';
import { inventory } from './inventory.js';
import { opencodeServiceActive, opencodeServiceStatus, opencodeServiceSessions } from './opencode-service.js';
import { claudeLiveSessions, claudeLiveStatus } from './external-process.js';
import { readProcess, resumeCommand, safePoint, stopProcess, tellTerminal } from './takeover.js';
import { openFiles, processArgv, processCwd } from './procinfo.js';
import { claudeChatArgs } from './claude-hooks.js';
import { wire } from './session-wire.js';
import { externalInput } from './session-transcript-events.js';

const transcriptSource = event => event.sourceId ? `id:${event.sourceId}`
  : Number.isInteger(event.sourceIndex) ? `index:${event.sourceIndex}` : null;
const transcriptCost = message => message.role === 'user' ? 1
  : (message.tools?.length ?? 0) * 2 + (message.text ? 3 : 0) + 1;

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
  #transcripts = new WeakMap();

  /** Share one byte cursor between the importer and transcript viewers. */
  async readTranscript(s) {
    if (!['codex', 'claude'].includes(s.engine)) return { messages: await readMessages({
      engine: s.engine, path: s.transcript, sessionId: s.engineSessionId, all: true,
    }) };
    let state = this.#transcripts.get(s);
    if (!state || state.reader.path !== s.transcript || state.reader.engine !== s.engine) {
      state = { reader: new IncrementalTranscript({ engine: s.engine, path: s.transcript }),
        first: true, reset: !!state, changedFrom: Infinity };
      this.#transcripts.set(s, state);
    }
    const result = await state.reader.read({ trusted: true });
    state.reset ||= result.reset;
    const saved = s.externalTranscriptRevision;
    // Keep a growing final reply attached to its saved item after restart.
    // Replacement, truncation, and a same-size rewrite rebuild the events.
    if (state.first && saved) {
      const current = result.revision;
      if (saved.dev !== current.dev || saved.ino !== current.ino || Number(current.size) < Number(saved.size)
        || current.size === saved.size && ['mtimeNs', 'ctimeNs'].some(key => saved[key] !== current[key])) {
        state.reset = true;
      } else if (current.size !== saved.size && s.externalTail) {
        const index = (s.externalImported ?? 0) - 1;
        const message = result.messages[index], tail = s.externalTail;
        if (message?.sourceId !== tail.sourceId) state.changedFrom = 0;
        else if (message.text !== tail.text || (message.tools?.length ?? 0) !== tail.tools) state.changedFrom = index;
      }
    }
    if (state.first && s.externalTranscriptDigests) {
      const savedDigests = s.externalTranscriptDigests;
      const base = s.externalTranscriptDigestBase ?? 0;
      if (s.externalTranscriptPrefixDigest && this.#prefixDigest(s, result.digests,
        Math.min(base, result.digests.length), Infinity) !== s.externalTranscriptPrefixDigest) state.changedFrom = 0;
      for (let offset = 0; offset < Math.min(savedDigests.length, result.digests.length - base); offset++) {
        if (savedDigests[offset] !== result.digests[base + offset]) {
          state.changedFrom = Math.min(state.changedFrom, base + offset);
          break;
        }
      }
    }
    if (!state.first) state.changedFrom = Math.min(state.changedFrom, result.changedFrom);
    state.first = false;
    return { ...result, reset: state.reset, changedFrom: state.changedFrom };
  }

  /** Release cached history when its viewer or skip operation ends. */
  releaseTranscript(s) {
    if (s) this.#transcripts.delete(s);
  }

  #prefixDigest(s, digests, through, changedFrom) {
    const state = this.#transcripts.get(s);
    let prefix = state?.prefix;
    if (!prefix || through < prefix.through || changedFrom < prefix.through)
      prefix = { through: 0, hash: createHash('sha256') };
    while (prefix.through < through) prefix.hash.update(digests[prefix.through++]);
    if (state) state.prefix = prefix;
    return prefix.hash.copy().digest('hex');
  }

  #saveTranscriptDigests(s, digests, changedFrom, messages) {
    if (!digests) return false;
    const saved = s.externalTranscriptDigests, to = s.externalImported;
    if (saved && changedFrom === Infinity && (s.externalTranscriptDigestBase ?? 0) + saved.length === to) return false;
    // Match the existing imported event budget. Do not put a full chat's
    // digest array in sessions.json or copy it on every chat-list save.
    let from = to, budget = EVENT_KEEP * 0.8;
    while (from > 0 && budget - transcriptCost(messages[from - 1]) > 0) budget -= transcriptCost(messages[--from]);
    const next = digests.slice(from, to);
    const prefix = this.#prefixDigest(s, digests, from, changedFrom);
    if (saved && s.externalTranscriptDigestBase === from && saved.length === next.length
      && s.externalTranscriptPrefixDigest === prefix && saved.every((hash, index) => hash === next[index])) return false;
    s.externalTranscriptPrefixDigest = prefix;
    s.externalTranscriptDigests = next;
    s.externalTranscriptDigestBase = from;
    return true;
  }

  /** Read the full retained log, including local records outside its tail. */
  #replacementState(s, messages) {
    const log = this.#sessions.events;
    let events;
    new EventFile(join(log.dir, `${s.id}.jsonl`), e => ({ seq: e.seq }))
      .refresh(file => { events = [...file.view()]; });
    // Old imported logs have no source fields. Match their owner prompts
    // in order, then match retained text items to their current replies.
    const textByItem = new Map();
    for (const e of events) if (e.type === 'item.delta' && String(e.id).startsWith('imported-') && e.text)
      textByItem.set(e.id, (textByItem.get(e.id) ?? '') + e.text);
    const legacyItems = new Map();
    let cursor = 0;
    for (const e of events) {
      if (transcriptSource(e)) {
        if (['turn.start', 'item.start'].includes(e.type) && Number.isInteger(e.sourceIndex)) cursor = Math.max(cursor, e.sourceIndex + 1);
        continue;
      }
      const prompt = e.type === 'turn.start' && (e.imported || String(e.turnId).startsWith('imported-')) && e.text;
      const text = e.type === 'item.start' && e.kind === 'text' && textByItem.get(e.id);
      const tool = e.type === 'item.start' && e.kind === 'tool' && String(e.id).startsWith('imported-');
      if (!prompt && !text && !tool) continue;
      const index = messages.findIndex((m, at) => at >= (tool ? Math.max(0, cursor - 1) : cursor) && (prompt
        ? m.role === 'user' && m.text === e.text
        : tool ? m.role === 'assistant' && m.tools?.some(t => t.name === e.name && JSON.stringify(externalInput(t)) === JSON.stringify(e.input))
          : m.role === 'assistant' && m.text && (m.text.startsWith(text) || text.startsWith(m.text))));
      if (index < 0) continue;
      e.sourceIndex = index;
      e.sourceId = messages[index].sourceId;
      if (text || tool) legacyItems.set(e.id, { sourceId: e.sourceId, sourceIndex: index });
      cursor = index + 1;
    }
    for (const e of events) if (!transcriptSource(e) && legacyItems.has(e.id)) Object.assign(e, legacyItems.get(e.id));
    const turns = new Map(events.filter(e => e.type === 'turn.start' && transcriptSource(e)).map(e => [transcriptSource(e), e.turnId]));
    const items = new Map(), positions = new Map(), seen = new Set();
    for (const e of events) if (e.type === 'item.start' && String(e.id).startsWith('imported-') && transcriptSource(e) && !seen.has(e.id)) {
      const key = JSON.stringify([transcriptSource(e), e.kind]);
      const position = positions.get(key) ?? 0;
      positions.set(key, position + 1);
      items.set(JSON.stringify([transcriptSource(e), e.kind, position]), e.id);
      seen.add(e.id);
    }
    return { events, turns, items };
  }

  /** Publish a corrected history without moving or deleting Helm's cards. */
  #publishTranscriptReplacement(s, previous, importedEvents) {
    const log = this.#sessions.events;
    const importedTurns = new Set(previous.filter(e => e.imported || String(e.turnId).startsWith('imported-')).map(e => e.turnId));
    const visuals = new Set(previous.filter(e => e.type === 'item.start' && e.kind === 'visual').map(e => e.id));
    const isLocal = e => e.type !== 'history.reset' && (e.local || e.type === 'native.images' || visuals.has(e.id)
      || (!e.imported && (e.type.startsWith('item.') ? !String(e.id).startsWith('imported-')
        : !importedTurns.has(e.turnId) || !['turn.start', 'turn.done'].includes(e.type))));
    const local = previous.filter(isLocal);
    const owners = new Set(local.map(e => e.turnId).filter(Boolean));
    const parents = new Set(local.flatMap(e => [e.id, e.parentId]).filter(Boolean));
    const newTurns = new Set(importedEvents.filter(e => e.type === 'turn.start').map(e => e.turnId));
    const newItems = new Set(importedEvents.filter(e => e.type === 'item.start').map(e => e.id));
    // A local item can refer to an imported tool as its parent. Keep that
    // parent's own anchor too, through every level of the item chain.
    for (let more = true; more;) {
      more = false;
      for (const e of previous) if (e.type === 'item.start' && parents.has(e.id)) {
        if (e.turnId) owners.add(e.turnId);
        if (e.parentId && !parents.has(e.parentId)) { parents.add(e.parentId); more = true; }
      }
    }
    const kept = new Set(local);
    for (const e of previous) {
      if (['turn.start', 'turn.done'].includes(e.type) && owners.has(e.turnId) && !newTurns.has(e.turnId)) kept.add(e);
      if (['item.start', 'item.done'].includes(e.type) && parents.has(e.id) && !newItems.has(e.id)) kept.add(e);
    }
    const sources = new Set(importedEvents.map(transcriptSource).filter(Boolean));
    const before = new Map(), after = new Map(), unplaced = [];
    const add = (map, key, event) => { if (!map.has(key)) map.set(key, []); map.get(key).push(event); };
    let next = null;
    const nextSource = new Array(previous.length);
    for (let index = previous.length - 1; index >= 0; index--) {
      nextSource[index] = next;
      if (!kept.has(previous[index]) && sources.has(transcriptSource(previous[index]))) next = transcriptSource(previous[index]);
    }
    let prior = null;
    for (let index = 0; index < previous.length; index++) {
      const event = previous[index];
      if (kept.has(event)) {
        if (nextSource[index]) add(before, nextSource[index], event);
        else if (prior) add(after, prior, event);
        else unplaced.push(event);
      } else if (sources.has(transcriptSource(event))) prior = transcriptSource(event);
    }
    const merged = [];
    for (let index = 0; index < importedEvents.length; index++) {
      const event = importedEvents[index], source = transcriptSource(event);
      if (source !== (importedEvents[index - 1] ? transcriptSource(importedEvents[index - 1]) : null)) merged.push(...(before.get(source) ?? []));
      merged.push(event);
      if (source !== (importedEvents[index + 1] ? transcriptSource(importedEvents[index + 1]) : null)) merged.push(...(after.get(source) ?? []));
    }
    merged.push(...unplaced);
    let seq = log.last(s.id) + 1;
    const replacement = [{ type: 'history.reset', at: Date.now(), seq: ++seq },
      ...merged.map(e => ({ ...e, seq: ++seq }))];
    log.replace(s.id, replacement);
    s.lastSeq = seq;
    for (const event of replacement) this.#sessions.emit('event', { id: s.id, event });
  }

  /** A conversation can return to O2 after Helm last drove it. */
  async monitorService(s, found) {
    const idle = () => !(s.engine !== 'opencode2' || !s.driver || s.external || !s.engineSessionId
      || ['working', 'blocked', 'starting'].includes(s.status)
      || ['working', 'blocked', 'starting'].includes(this.#core.drivers.get(s.id)?.status)
      || this.#core.drivers.get(s.id)?.pending?.size || this.#core.drivers.get(s.id)?.backgroundTasks > 0
      || this.#sessions.events.activeTurn(s.id) || this.#sessions.events.pending(s.id).length
      || this.#core.driverStarts.has(s.id) || this.#core.retiring.has(s.id)
      || this.#core.sending.has(s.id) || this.#core.outbox.get(s.id)?.length);
    if (!idle() || !opencodeServiceStatus(s.engineSessionId)) return;
    found ??= (await inventory((await getProfiles()).filter(p => p.engine === 'opencode2'), { limit: Infinity }))
      .find(x => x.id === s.engineSessionId);
    if (!found?.serviceActive || this.#core.index.get(s.id) !== s || !idle()) return;
    const through = this.#sessions.events.tail(s.id, 0)
      .findLast(e => e.type === 'turn.done' && !e.imported && !e.local && !e.undelivered)?.at ?? s.updatedAt ?? 0;
    if (opencodeServiceStatus(s.engineSessionId) !== 'working') {
      if (found.updatedAt <= through) return;
      // Session metadata can be saved after Helm's reply. Only a new user
      // message proves that a short outside turn ran between our polls.
      const messages = await readMessages({ engine: s.engine, path: found.transcript, sessionId: s.engineSessionId, all: true });
      if (!messages.some(m => m.role === 'user' && Number(m.at) > through) || !idle()) return;
    }
    // Keep the same chat. Release only Helm's idle ACP connection: it has
    // cached the old conversation. The separate shared O2 service stays alive.
    // The saved event time separates already-shown Helm replies from new
    // outside messages, even on old records whose import cursor is stale.
    s.externalAfter = through;
    Object.assign(s, { external: true, externalSource: true, externalActive: true,
      externalService: true, externalPid: null, transcript: found.transcript,
      status: opencodeServiceStatus(s.engineSessionId), updatedAt: found.updatedAt, adopted: true });
    const driver = this.#core.drivers.get(s.id);
    if (driver) {
      clearTimeout(this.#core.reapers.get(s.id));
      this.#core.reapers.delete(s.id);
      this.#core.drivers.delete(s.id);
      driver.removeAllListeners?.();
      const retiring = Promise.resolve().then(() => driver.kill());
      this.#core.retiring.set(s.id, retiring);
      try { await retiring; }
      finally { if (this.#core.retiring.get(s.id) === retiring) this.#core.retiring.delete(s.id); }
    }
    this.#core.save();
    this.#sessions.emit('session', s);
    await this.importExternalTranscript(s);
    this.#core.viewers.watchTranscript(s.id, s.transcript);
  }

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
      liveStatus: s.engine === 'opencode2' ? opencodeServiceStatus(s.engineSessionId) : s.engine === 'claude' && s.externalHome
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
    if (s.engine === 'opencode2' && opencodeServiceStatus(s.engineSessionId)) return true;
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
    if (s.engine === 'opencode2' && opencodeServiceStatus(s.engineSessionId) === 'idle') return;
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
    if (s.engine === 'opencode2') {
      await opencodeServiceSessions({ fresh: true });
      await this.monitorService(s);
    }
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
    const { messages, revision, digests } = await this.readTranscript(s).catch(() => ({}))
      .finally(() => this.releaseTranscript(s));
    if (!messages) return;
    const state = this.#transcripts.get(s);
    if (state) { state.reset = false; state.changedFrom = Infinity; }
    s.externalTranscriptRevision = revision;
    s.externalImported = messages.length;
    this.#saveTranscriptDigests(s, digests, 0, messages);
    s.externalImagesVersion = 1;
    s.externalTail = null;
    if (this.#core.index.has(s.id)) this.#core.save();
  }

  async #readExternalTranscript(s) {
    if (!s.transcript) return;
    const { messages, reset, changedFrom, revision, digests } = await this.readTranscript(s);
    let rebuild = null;
    s.externalTranscriptRevision = revision;
    const state = this.#transcripts.get(s);
    if (state) { state.reset = false; state.changedFrom = Infinity; }
    // Extend a growing final reply in place. Changes to an earlier reply
    // require rebuilding the retained events in their original order.
    const count = s.externalImported ?? 0, last = messages[count - 1], tail = s.externalTail;
    const tailGrowth = changedFrom === count - 1
      && last?.role === 'assistant' && last.sourceId && last.sourceId === tail?.sourceId
      && (last.text ?? '').startsWith(tail.text ?? '') && (last.tools?.length ?? 0) >= (tail.tools ?? 0);
    if (['codex', 'claude'].includes(s.engine) && (reset || changedFrom < count && !tailGrowth
      || messages.length < count)) {
      rebuild ??= this.#replacementState(s, messages);
      s.externalImported = 0;
      s.externalTail = null;
    }
    // Claude chats copied before replies were read whole are missing what
    // Claude said between its tool calls: copy those once more, from scratch.
    if (s.engine === 'claude' && s.external && (s.externalImported ?? 0) > 0 && s.externalTextVersion !== 1) {
      rebuild ??= this.#replacementState(s, messages);
      s.externalImported = 0;
      s.externalTail = null;
    }
    if (s.engine === 'claude') s.externalTextVersion = 1;
    let imported = Math.min(s.externalImported ?? 0, messages.length);
    if (s.engine === 'opencode2' && s.externalAfter) {
      imported = Math.max(imported, messages.findLastIndex(m => Number(m.at) <= s.externalAfter) + 1);
    }
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
    const buffered = [];
    let sourceId, sourceIndex;
    const itemPositions = new Map();
    const nextItem = kind => {
      if (!rebuild) return nextId();
      const source = transcriptSource({ sourceId, sourceIndex });
      const key = JSON.stringify([source, kind]), position = itemPositions.get(key) ?? 0;
      itemPositions.set(key, position + 1);
      return rebuild.items.get(JSON.stringify([source, kind, position])) ?? nextId();
    };
    const append = (event) => {
      event = { ...event, ...(sourceId ? { sourceId } : {}), ...(Number.isInteger(sourceIndex) ? { sourceIndex } : {}) };
      if (rebuild) { buffered.push({ ...event, at: Date.now() }); return; }
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
    // Claude snapshots and database rows can grow without adding a message.
    // Extend the existing item and keep its id and all preceding events.
    let tailChanged = false;
    {
      const last = messages[imported - 1], tail = s.externalTail;
      if (last?.role === 'assistant' && last.sourceId && tail?.sourceId === last.sourceId) {
        const text = last.text ?? '';
        const tools = last.tools?.length ?? 0;
        const changed = text !== tail.text || tools !== (tail.tools ?? 0);
        tailChanged = changed;
        sourceId = last.sourceId;
        sourceIndex = imported - 1;
        if (changed && text && !tail.itemId) {
          tail.itemId = nextItem('text');
          append({ type: 'item.start', id: tail.itemId, turnId: tail.turnId, kind: 'text' });
          append({ type: 'item.delta', id: tail.itemId, turnId: tail.turnId, text });
          append({ type: 'item.done', id: tail.itemId, turnId: tail.turnId, status: 'ok' });
        } else if (tail.itemId && text.startsWith(tail.text ?? '') && text.length > (tail.text?.length ?? 0)) {
          append({ type: 'item.delta', id: tail.itemId, turnId: tail.turnId, text: text.slice((tail.text ?? '').length) });
        }
        for (const tool of (last.tools ?? []).slice(tail.tools ?? 0)) {
          const itemId = nextItem('tool');
          append({ type: 'item.start', id: itemId, turnId: tail.turnId, kind: 'tool', name: tool.name, input: externalInput(tool) });
          append({ type: 'item.done', id: itemId, turnId: tail.turnId, status: 'ok' });
        }
        tail.text = text;
        tail.tools = last.tools?.length ?? 0;
      }
      if (imported === messages.length) {
        if (rebuild) this.#publishTranscriptReplacement(s, rebuild.events, buffered);
        s.externalImported = imported;
        const checkpointChanged = this.#saveTranscriptDigests(s, digests, changedFrom, messages);
        if ((tailChanged || checkpointChanged || rebuild) && this.#core.index.has(s.id)) this.#core.save();
        return;
      }
    }
    // The log keeps its last couple of thousand events. A long chat opened
    // for the first time used to write every one and trim as it went, which
    // got slower the longer the chat: start where the kept part starts, on
    // a message the owner wrote. The CLI's own history still has the rest.
    const cost = transcriptCost;
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
    for (let index = imported; index < messages.length; index++) {
      const message = messages[index];
      if (message.role === 'user') {
        close();
        sourceId = message.sourceId;
        sourceIndex = index;
        s.externalTail = null;
        turnId = rebuild?.turns.get(transcriptSource({ sourceId, sourceIndex })) ?? nextId();
        append({ type: 'turn.start', turnId, text: message.text ?? '', imported: true,
          ...(message.attachments?.length ? { attachments: message.attachments.map((a) => this.#sessions.events.putAttachment(s.id, a)) } : {}),
        });
        continue;
      }
      sourceId = message.sourceId;
      sourceIndex = index;
      if (!turnId) {
        turnId = rebuild?.turns.get(transcriptSource({ sourceId, sourceIndex })) ?? nextId();
        append({ type: 'turn.start', turnId, text: '', imported: true });
      }
      // What Claude says comes before the calls it makes in the same reply.
      let textItemId = null;
      if (message.text) {
        textItemId = nextItem('text');
        append({ type: 'item.start', id: textItemId, turnId, kind: 'text' });
        append({ type: 'item.delta', id: textItemId, turnId, text: message.text });
        append({ type: 'item.done', id: textItemId, turnId, status: 'ok' });
      }
      for (const tool of message.tools ?? []) {
        const itemId = nextItem('tool');
        append({ type: 'item.start', id: itemId, turnId, kind: 'tool', name: tool.name, input: externalInput(tool) });
        append({ type: 'item.done', id: itemId, turnId, status: 'ok' });
      }
      if (message.sourceId) s.externalTail = {
        sourceId: message.sourceId, turnId, itemId: textItemId,
        text: message.text ?? '', tools: message.tools?.length ?? 0,
      };
    }
    close();
    if (rebuild) this.#publishTranscriptReplacement(s, rebuild.events, buffered);
    s.externalImported = messages.length;
    this.#saveTranscriptDigests(s, digests, rebuild ? 0 : changedFrom, messages);
    if (this.#core.index.has(s.id)) this.#core.save();
  }
}
