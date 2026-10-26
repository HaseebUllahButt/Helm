import { getProfiles } from './profiles.js';
import { messages as readMessages } from './transcript.js';
import { findSubagentsDir, nativeAgentFile, nativeSubagent, nativeSubagents, subagentsDir } from './native-subagents.js';
import { codexSubagents, codexChildMessages, cursorMessages, cursorSubagents, eventSubagents, opencodeSubagents, relayToSubagent, unwrapCoordinator, SUBAGENT_ENGINES } from './cli-subagents.js';
import { ENGINES } from './engines.js';
import { transcriptEvents } from './session-transcript-events.js';

// How often one Claude session's own subagent folder is re-listed at most.
const NATIVE_POLL_MS = 2_000;
// One reader per engine, so the event log can keep each one's answer until
// the thread changes instead of re-reading the whole thread every poll.
const LOG_SUBAGENTS = new Map();
const logSubagents = (engine) => {
  if (!LOG_SUBAGENTS.has(engine)) LOG_SUBAGENTS.set(engine, (events) => eventSubagents(events, { engine }));
  return LOG_SUBAGENTS.get(engine);
};

/**
 * What the driver last reported for one of Claude's own subagent cards:
 * `nativeAgents` is keyed by the tool call that started it.
 */
const hookState = (s, card) => s.nativeAgents?.[card.toolUseId] ?? s.nativeAgents?.[card.id];

// The newest messages a native subagent's window shows; a long run is
// thousands, and the end is what the owner opened it for.
const NATIVE_MESSAGES = 600;
const NATIVE_BYTES = 400_000;

/**
 * A CLI's own subagents: the helpers Claude, Codex and the others start by
 * themselves. Helm does not run them; it finds them in each CLI's records,
 * counts them on their chat, and opens one as a chat of its own.
 */
export class SessionSubagents {
  #sessions;
  #core;
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  /** id -> { key, dir, sig, cards, at, busy }: where each session's subagents are, and what their records last said. */
  native = new Map();
  /** sessionId -> (agent id -> tool calls that ran it): Claude reruns a helper under the SendMessage call that woke it. */
  agentTools = new Map();

  /** Release records owned by a chat that was removed. */
  forget(id) {
    this.native.delete(id);
    this.agentTools.delete(id);
    this.#firstReads.delete(id);
  }

  /** Whether Helm can find this session's own subagents: from its CLI's records, or from what its log saw start. */
  hasNative(s) { return SUBAGENT_ENGINES.has(s.engine) || !!s.spawned; }

  #firstReads = new Set();
  #firstReading = false;
  firstNativeRead(s) {
    this.#firstReads.add(s.id);
    if (this.#firstReading) return;
    this.#firstReading = true;
    void (async () => {
      try {
        for (const id of this.#firstReads) {
          this.#firstReads.delete(id);
          const live = this.#core.index.get(id);
          if (live && !this.native.has(id)) await this.refreshNative(live);
          await new Promise((resolve) => setImmediate(resolve));
        }
      } finally { this.#firstReading = false; }
    })();
  }

  /**
   * What the driver last reported for one subagent card: `nativeAgents` is
   * keyed by the tool call that started it, or by the one that woke it again.
   */
  hookState(s, card) {
    const direct = hookState(s, card);
    if (direct) return direct;
    for (const tool of this.agentTools.get(s.id)?.get(card.id) ?? []) if (s.nativeAgents?.[tool]) return s.nativeAgents[tool];
    return undefined;
  }

  /**
   * One card per subagent: its records give the title, model, branch and
   * reply; what the driver last reported for the same tool call, when it
   * did, is the fresher state (waiting on you, still running, failed).
   */
  nativeCards(s) {
    return (this.native.get(s.id)?.cards ?? []).map((card) => {
      const state = this.hookState(s, card);
      const shown = ['working', 'blocked', 'error'].includes(state) && state !== card.status ? { ...card, status: state } : card;
      return { ...shown, canMessage: this.#canMessage(s, card) };
    });
  }

  /** A parent that can pass a message on: its CLI has a tool for it, and Helm can type into it. */
  #canMessage(s, card) {
    return !card.fromLog && !!card.target && ['claude', 'codex', 'opencode', 'opencode2'].includes(s.engine) && !!(s.driver || s.nativeChat);
  }

  async #engineEnv(s) {
    const profile = (await getProfiles()).find((p) => p.id === s.profileId);
    return profile?.env ?? {};
  }

  /** A Claude session's subagent folder; null until Claude has made it. */
  async #nativeDir(s) {
    if (s.transcript) return subagentsDir(s.transcript);
    if (!s.engineSessionId) return null;
    const engine = ENGINES.claude;
    return findSubagentsDir({ home: (await this.#engineEnv(s))[engine.homeEnv] ?? engine.defaultHome, cwd: s.cwd, sessionId: s.engineSessionId });
  }

  /**
   * Re-read a session's own subagents (Claude's Agent tool, Codex's
   * spawn_agent, OpenCode's task...) and tell the app when what it shows
   * changed. At most every NATIVE_POLL_MS, one at a time.
   */
  async refreshNative(s, { force = false } = {}) {
    if (!this.hasNative(s) || !this.#core.index.has(s.id)) { this.native.delete(s.id); return; }
    let n = this.native.get(s.id);
    // '[]' is "none": a session that never had any announces nothing.
    if (!n) this.native.set(s.id, n = { key: null, dir: null, sig: '[]', cards: [], at: 0, busy: null });
    if (n.busy) { if (!force) return; await n.busy; }
    if (!force && Date.now() - n.at < NATIVE_POLL_MS) return;
    n.at = Date.now();
    n.busy = this.#readNative(s, n).finally(() => { n.busy = null; });
    return n.busy;
  }

  /** The subagents a CLI's own records hold for this session. */
  async #storedAgents(s, n) {
    if (s.engine === 'claude') {
      const key = `${s.transcript ?? ''}|${s.engineSessionId ?? ''}|${s.profileId ?? ''}|${s.cwd ?? ''}`;
      if (n.key !== key || !n.dir) { n.key = key; n.dir = await this.#nativeDir(s); }
      // A Workflow's agents take no messages: no target, so no message box.
      return (await nativeSubagents(n.dir)).map((agent) => ({ ...agent, engine: 'claude', target: agent.workflow ? null : agent.id }));
    }
    if (!s.engineSessionId) return [];
    const env = await this.#engineEnv(s);
    if (s.engine === 'codex') return codexSubagents({ home: env.CODEX_HOME ?? ENGINES.codex.defaultHome, threadId: s.engineSessionId });
    if (s.engine === 'opencode' || s.engine === 'opencode2') return opencodeSubagents({ dataHome: env.XDG_DATA_HOME, sessionId: s.engineSessionId, engine: s.engine });
    if (s.engine === 'cursor') return cursorSubagents({ home: ENGINES.cursor?.defaultHome, chatId: s.engineSessionId });
    return [];
  }

  async #readNative(s, n) {
    try {
      const agents = await this.#storedAgents(s, n);
      if (this.native.get(s.id) !== n || this.#core.index.get(s.id) !== s) return;
      // What the chat's own log saw start: every helper of a CLI that keeps
      // no record Helm can read, and any not written down yet. One the
      // records already hold is the same helper - it only lends its tool
      // call, so the card and the step in the chat open the same thing.
      if (s.spawned) {
        const byId = new Map(agents.map((agent) => [agent.id, agent]));
        const byTool = new Map(agents.filter((agent) => agent.toolUseId).map((agent) => [agent.toolUseId, agent]));
        for (const card of this.#sessions.events.derive(s.id, logSubagents(s.engine), 0)) {
          const stored = byTool.get(card.id) ?? (card.threadId && byId.get(card.threadId));
          if (stored) { stored.toolUseId ??= card.id; continue; }
          agents.push({ ...card });
        }
      }
      agents.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
      const sig = JSON.stringify(agents.map((a) => [a.id, a.status, a.title, a.model, a.last, a.branch, a.toolUseId]));
      if (sig === n.sig) return;
      n.sig = sig;
      n.cards = agents;
      this.#core.delegation.refreshTeam(s);
    } catch (err) { this.#sessions.log(`native subagents: ${err.message}`); }
  }

  /** One of a session's own subagents, with its result and recent activity; `full` adds its whole conversation. */
  async nativeAgent(id, agentId, { full = false } = {}) {
    const s = this.#sessions.get(id);
    if (!this.hasNative(s)) throw new Error('this chat has no subagents');
    await this.refreshNative(s, { force: true });
    const card = s.nativeCards?.find((a) => a.id === agentId);
    if (!card) throw new Error('no such subagent');
    const raw = this.native.get(s.id)?.cards.find((a) => a.id === agentId) ?? card;
    const sent = (s.nativeSent?.[agentId] ?? []);
    let agent = { ...card, result: card.last, activity: [], task: raw.prompt ?? '' };
    if (s.engine === 'claude' && !raw.fromLog) {
      const detail = await nativeSubagent(this.native.get(s.id)?.dir, agentId);
      if (!detail) throw new Error('no such subagent');
      agent = { ...detail, engine: 'claude', target: card.target, canMessage: card.canMessage, status: card.status };
    }
    if (!full) return { agent };
    let found;
    if (raw.fromLog) {
      return { agent, events: this.#logAgentEvents(s, raw, card.status === 'working'), more: false };
    } else if (s.engine === 'claude') {
      // The whole conversation, drawn like any chat: a window onto the file
      // Claude writes, re-read each time it is asked for.
      const path = await nativeAgentFile(this.native.get(s.id)?.dir, agentId);
      if (!path) throw new Error('no such subagent');
      found = (await readMessages({ engine: 'claude', path, all: true, sidechain: true }))
        .map((m) => m.role === 'user' ? { ...m, text: unwrapCoordinator(m.text) } : m);
    } else if (s.engine === 'codex') {
      found = await codexChildMessages(raw.path, { sent });
    } else if (s.engine === 'cursor') {
      found = await cursorMessages(raw.path);
    } else {
      found = (await readMessages({ engine: s.engine, path: raw.path, sessionId: agentId, all: true }))
        .map((m) => m.role === 'user' ? { ...m, text: unwrapCoordinator(m.text) } : m);
    }
    // A message sent since its record last moved is on its way through the
    // parent: it shows as sent now, and the record's own copy replaces it.
    const newest = Math.max(0, ...found.map((m) => Date.parse(m.at ?? '') || 0));
    for (const m of sent) {
      if (m.at > newest && !found.some((f) => f.role === 'user' && f.text?.trim() === m.text.trim())) {
        found.push({ role: 'user', text: m.text, tools: [], at: new Date(m.at).toISOString() });
      }
    }
    let from = found.length, bytes = 0;
    while (from > 0 && found.length - from < NATIVE_MESSAGES) {
      bytes += JSON.stringify(found[from - 1]).length;
      if (bytes > NATIVE_BYTES && from < found.length) break;
      from--;
    }
    const events = transcriptEvents(found.slice(from), { open: ['working', 'blocked'].includes(card.status) });
    return { agent, events, more: from > 0 };
  }

  /**
   * A subagent's run as the chat's log recorded it: the step that started
   * it, then everything that ran inside it, as one turn of its own.
   */
  #logAgentEvents(s, card, open) {
    const all = this.#sessions.events.tail(s.id, 0);
    const inside = new Set([card.id]);
    const out = [];
    let seq = 0;
    const push = (event) => out.push({ ...event, turnId: 'agent', parentId: undefined, seq: ++seq });
    const start = all.find((e) => e.type === 'item.start' && e.id === card.id);
    push({ type: 'turn.start', text: card.prompt || card.title, at: start?.at });
    let reply = '';
    for (const e of all) {
      if (e.type === 'item.start' && e.parentId && inside.has(e.parentId)) { inside.add(e.id); push(e); continue; }
      if (e.id === card.id && e.type === 'item.done' && e.output) reply = e.output;
      if (e.id && e.id !== card.id && inside.has(e.id) && e.type.startsWith('item.')) push(e);
    }
    if (reply) {
      push({ type: 'item.start', id: `${card.id}:reply`, kind: 'text' });
      push({ type: 'item.delta', id: `${card.id}:reply`, text: reply });
      push({ type: 'item.done', id: `${card.id}:reply`, status: 'ok' });
    }
    if (!open) push({ type: 'turn.done', status: 'ok' });
    return out;
  }

  /**
   * Message one of a session's own subagents. Codex lets Helm speak on the
   * helper's own thread. Claude and OpenCode keep their helpers inside the
   * parent's process, so the parent is asked to pass the words on with its
   * own tool for it (Claude's SendMessage, OpenCode's task). Either way the
   * helper picks up where it was, with everything it knew; its own record
   * shows the reply.
   */
  async messageNative(id, agentId, text) {
    const s = this.#sessions.get(id);
    const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!body) throw new Error('write a message first');
    if (body.length > 32_000) throw new Error('that message is too long');
    await this.refreshNative(s, { force: true });
    const card = s.nativeCards?.find((a) => a.id === agentId);
    if (!card) throw new Error('no such subagent');
    if (!card.canMessage) throw new Error(s.driver || s.nativeChat
      ? `${ENGINES[s.engine]?.label ?? s.engine} cannot pass messages to its helpers.`
      : 'Open the main chat in Helm to message its helpers.');
    // Codex takes it straight on the helper's own thread, no model in the
    // way; the rest are asked to pass it on.
    let result = {};
    if (s.engine === 'codex') {
      let d = this.#core.drivers.get(id);
      if (!d && s.external) throw new Error('Continue this chat in Helm first, then message its helpers.');
      if (!d) { await this.#sessions.connect(id); d = this.#core.drivers.get(id); }
      if (typeof d?.messageSubagent !== 'function') throw new Error('This chat cannot reach its helpers right now.');
      await d.messageSubagent(card.id, body);
      void this.refreshNative(s, { force: true });
    } else result = await this.#sessions.input(id, relayToSubagent(s.engine, card, body));
    s.nativeSent ??= {};
    s.nativeSent[agentId] = [...(s.nativeSent[agentId] ?? []), { text: body, at: Date.now() }].slice(-20);
    this.#core.save();
    return { ok: true, ...result };
  }
}
