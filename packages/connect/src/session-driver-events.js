import { usageResetAt, isUsageLimit } from './usage-recovery.js';
import { nonAgentClaudeTask } from './claude-tasks.js';
import { isWakeTurn, trackDelegationReply } from './delegation.js';
import { priceBucket } from '@helm/usage/pricing';
import { promptTitle } from './titles.js';
import { missingClaudeConversation } from './session-text.js';

/**
 * What one turn's tokens cost at list price, or null when the model is not
 * in the table. Codex counts cached tokens inside `input`; Claude does not.
 */
export function priceTurn(engine, model, usage) {
  if (!model || !usage) return null;
  const cacheRead = usage.cacheRead || 0;
  const input = Math.max(0, (usage.input || 0) - (usage.inputIncludesCache ? cacheRead : 0));
  const priced = priceBucket(engine, model, { input, output: usage.output || 0, cacheRead, cacheWrite: usage.cacheWrite || 0 }, new Date().toISOString().slice(0, 10));
  return priced && priced.total > 0 ? Math.round(priced.total * 1e6) / 1e6 : null;
}

/**
 * What a headless driver reports, turned into the chat: each event goes to
 * the log and to every client, and moves the session's status, team counts,
 * title and queue along.
 */
export class DriverEvents {
  #sessions;
  #core;
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  /** session id -> the compaction item open in it */
  #compactions = new Map();
  /** session id -> the last usage reading written to its log */
  #limits = new Map();

  onDriverEvent(s, d, e) {
    const current = this.#core.drivers.get(s.id);
    if (current !== d && (current || e.type !== 'status')) return;
    // Codex reports the same usage again and again. On 2026-10-19, 82% of
    // the limits rows in the owner's logs only repeated the row before, and
    // some chats held nothing else. Account limits still record every report.
    if (e.type === 'limits') {
      const reading = JSON.stringify(e);
      if (this.#limits.get(s.id) === reading) return;
      this.#limits.set(s.id, reading);
    }
    if (!['limits', 'title', 'settings', 'context'].includes(e.type)) this.#core.rewinder.providerRevisions.set(s.id, (this.#core.rewinder.providerRevisions.get(s.id) ?? 0) + 1);
    // A command card (/status, /usage) answers beside the task. It is not
    // the task's reply, and its end is not the task's end.
    if (e.type === 'turn.start' && e.local === true) {
      const cards = this.#core.commandCards.get(s.id) ?? new Set();
      this.#core.commandCards.set(s.id, cards.add(e.turnId));
    }
    const card = e.type === 'turn.start' ? e.local === true
      : e.type === 'item.start' ? !!this.#core.commandCards.get(s.id)?.has(e.turnId)
        : e.type === 'turn.done' && this.#commandCard(s.id, e.turnId);
    // A driver that closes one turn twice must not count it twice: its cost,
    // its place in the title count, and the notice to a parent are all
    // per-turn.
    if (e.type === 'turn.done' && e.turnId && !card && !this.#closeTurn(s.id, e.turnId)) return;
    // A success naming no turn, with no turn open, closes nothing: it is a
    // finish said again. (A failure still counts: it may be the only record
    // of a message the CLI refused before it echoed it.)
    if (e.type === 'turn.done' && !e.turnId && e.status === 'ok' && !card && !this.#sessions.events.activeTurn(s.id)) return;
    if (!card) trackDelegationReply(s, e);
    let forwarded = e;
    // A helper started: from now on this chat's log is one place its
    // subagents are found, whatever CLI it is.
    if (e.type === 'item.start' && e.kind === 'subagent' && !s.spawned) { s.spawned = true; this.#core.save(); }
    // Claude runs a helper woken by SendMessage under that call, not the one
    // that started it; the task id names the helper either way.
    if (e.type === 'item.update' && e.agent?.id && e.id && e.id !== e.agent.id) {
      const tools = this.#core.subagents.agentTools.get(s.id) ?? new Map();
      this.#core.subagents.agentTools.set(s.id, tools.set(e.agent.id, (tools.get(e.agent.id) ?? new Set()).add(e.id)));
    }
    if (s.engine === 'claude' && e.type === 'item.update' && nonAgentClaudeTask(e.agent) && s.nativeAgents?.[e.id]) {
      delete s.nativeAgents[e.id];
      this.#core.delegation.refreshTeam(s);
      this.#core.save();
    }
    if (e.type === 'subagent.status' || (e.type === 'permission.request' && e.parentId)) {
      const id = e.type === 'subagent.status' ? e.id : e.parentId;
      let status = e.type === 'subagent.status' ? e.status : 'blocked';
      if (status === 'working' && this.#sessions.events.pending(s.id).some(p => p.parentId === id)) status = 'blocked';
      s.nativeAgents ??= {};
      if (s.nativeAgents[id] !== status) {
        if (status === 'idle') delete s.nativeAgents[id];
        else s.nativeAgents[id] = status;
        this.#core.delegation.refreshTeam(s);
        this.#core.save();
      }
    }
    if (e.type === 'permission.resolved') {
      const ask = this.#sessions.events.pending(s.id).find(p => p.requestId === e.requestId);
      if (ask?.parentId && s.nativeAgents?.[ask.parentId] === 'blocked'
        && !this.#sessions.events.pending(s.id).some(p => p.requestId !== e.requestId && p.parentId === ask.parentId)) {
        s.nativeAgents[ask.parentId] = 'working';
        this.#core.delegation.refreshTeam(s);
        this.#core.save();
      }
    }
    // A helper started or moved on: its card follows now, not at the next poll.
    if (e.type === 'subagent.status' || (e.type === 'item.start' && e.kind === 'subagent')
      || (e.type === 'item.done' && s.nativeCards?.some((card) => card.toolUseId === e.id))) void this.#core.subagents.refreshNative(s);
    if ((e.type === 'turn.done' && e.status === 'interrupted') || (e.type === 'status' && e.status === 'exited')) {
      if (s.nativeAgents) { delete s.nativeAgents; this.#core.delegation.refreshTeam(s); this.#core.save(); }
    }
    const staleClaudeConversation = s.engine === 'claude'
      && e.type === 'turn.done'
      && e.status === 'error'
      && missingClaudeConversation(e.error, s.engineSessionId);
    if (staleClaudeConversation) {
      // The CLI can fail before echoing the user message, leaving turnId
      // empty. Close Helm's optimistic bubble with the same failure so the
      // composer offers the original text for resend.
      const open = this.#sessions.events.openTurn(s.id);
      if (!e.turnId && open) forwarded = { ...e, turnId: open.turnId };
      s.engineSessionId = null;
      d.engineSessionId = null;
      d.resume = false;
      this.#core.save();
    }
    // Slash commands such as /model and /permissions change the same live
    // driver settings as the composer's pickers. Persist them here so every
    // connected client and the next resumed process sees the same choice.
    if (e.type === 'settings') {
      for (const key of ['model', 'effort', 'mode', 'speed', 'permissionControl']) {
        if (Object.hasOwn(e, key)) s[key] = e[key] || null;
      }
      if (this.#core.index.has(s.id)) this.#core.save();
      this.#sessions.emit('session', s);
      return;
    }
    // How full the conversation is. It is a fact about the thread, not a line
    // in it: kept on the record (written out when the turn ends, with the
    // rest) and sent to clients as a session update.
    if (e.type === 'context') {
      this.#core.setContext(s, e.used, e.window, e.model, e.full, e.compacted === true);
      return;
    }
    if (e.type === 'status') {
      // A closed process is not a closed conversation: the next message
      // resumes it. Only an explicit kill removes the session.
      const status = e.status === 'exited' ? 'idle' : e.status;
      if (s.delegation && !s.stoppedAt && ['working', 'blocked'].includes(status)) s.delegation.status = status;
      if (s.delegation) this.#core.delegation.updateTeam(s);
      if (e.status === 'exited' && this.#core.drivers.get(s.id) === d) { this.#core.drivers.delete(s.id); this.#core.deliveryState.clearAwaitingEcho(s.id); }
      // An idle ACP connection does not own a chat resumed in O2's service.
      if (s.external && s.engine === 'opencode2') return;
      if (e.status === 'exited' && s.shared) this.#sessions.emit('session', { ...s, alive: false });
      this.#core.reap(s, status);
      if (status !== s.status && this.#core.index.has(s.id)) {
        const previous = s.status;
        s.status = status;
        s.updatedAt = Date.now();
        this.#core.save();
        this.#sessions.emit('session', s);
        this.#sessions.emit('status', { session: s, from: previous, to: status });
      }
      // A settled turn is what a queued message waits behind - even when the
      // turn ended badly. `exited` counts too: delivery respawns the driver,
      // which is how a queue survives the process dying mid-turn. The pump
      // reads s.status to know the agent is free, so it runs after it lands.
      if (status === 'idle' || e.status === 'exited') this.#core.deliveryState.clearSteps(s.id);
      if (e.status === 'idle' && this.#finishing(s)) this.#awaitTurnDone(s);
      else {
        this.#core.settled(s.id);
        if (status === 'idle') this.#core.delivery.pump(s);
      }
      if (e.status === 'exited') return;
    }
    // The CLI used a message handed to it mid-turn: from here it is part of
    // the conversation, at this point in it.
    if (e.type === 'input.consumed') return this.#core.delivery.consumed(s, e.text, e.inputId);
    // The CLI refused or lost a message handed to it mid-turn. It fails as
    // its own bubble rather than leaving it "sent" with nothing behind it.
    if (e.type === 'input.failed') return this.#core.delivery.consumed(s, e.text, e.inputId, e.error || 'The CLI did not take this message.');
    // Compacting is part of where the thread stands - its row, its chip and
    // the bar over the composer say so, for every CLI - from the compaction
    // item's start until it ends, or the CLI stops or exits.
    const compaction = e.type === 'item.start' && e.name === 'compact' && !e.parentId ? Date.now()
      : (e.type === 'item.done' && e.id === this.#compactions.get(s.id))
        || (e.type === 'status' && ['idle', 'exited'].includes(e.status)) ? 0 : null;
    if (compaction != null && (!!compaction !== !!s.compacting)) {
      if (compaction) { s.compacting = compaction; this.#compactions.set(s.id, e.id); }
      else { delete s.compacting; this.#compactions.delete(s.id); }
      if (this.#core.index.has(s.id)) { this.#core.save(); this.#sessions.emit('session', s); }
    }
    // A compaction is not a step: nothing waiting should go in while the CLI rewrites its context.
    if (e.type === 'item.start' && !e.parentId && !['text', 'thinking'].includes(e.kind) && e.name !== 'compact') {
      this.#core.deliveryState.addStep(s.id, e.id);
      void this.#core.delivery.handOver(s);
    }
    if (e.type === 'item.done') this.#core.deliveryState.removeStep(s.id, e.id);
    if (e.type === 'turn.done') this.#core.deliveryState.clearSteps(s.id);
    // A wordless command card is an answer, not the echo of anything sent.
    if (e.type === 'turn.start' && !e.wake && !(e.local && !e.text)) {
      // The echo of a message sent as a new turn carries its ticket's id.
      // A driver that knows it says so; otherwise the oldest matching text
      // sent through this driver claims it.
      const awaiting = this.#core.deliveryState.awaitingEcho(s.id);
      const echo = (e.text ?? '').trim();
      const index = awaiting?.findIndex((entry) => entry.driver === d && (e.inputId != null
        ? entry.turnId === e.inputId
        : entry.text === echo || (entry.text && echo.startsWith(`${entry.text}\n`)))) ?? -1;
      if (index >= 0) {
        const entry = awaiting[index];
        this.#core.deliveryState.removeAwaitingEcho(s.id, entry.turnId, d);
        forwarded = { ...forwarded, inputId: entry.turnId, ...(entry.source === 'agent' ? { source: 'agent' } : {}), ...(entry.checkpoint ? { checkpoint: entry.checkpoint } : {}) };
      }
      // Handed over too late for the turn it was typed into, the CLI runs
      // it as the next one instead; the echo is the client's cue.
      const steered = this.#core.deliveryState.steered(s.id);
      const i = steered?.findIndex((x) => forwarded.inputId != null ? x.turnId === forwarded.inputId : x.text.trim() === echo) ?? -1;
      if (i >= 0) this.#core.deliveryState.removeSteered(s.id, steered[i].turnId);
    }
    if (e.type === 'title') return this.#core.titles.titled(s, e.title, 'agent');
    // Every turn has always said what it cost and nothing added them up.
    // Accumulated on the record rather than summed from the log, which is
    // trimmed to the last few hundred events - a long thread would start
    // forgetting what its early turns cost.
    //
    // Claude reports a running total instead, and a resumed conversation
    // carries its saved total into the first result. Summing those counted
    // turn one again on every later turn - twenty equal turns showed ~10x.
    // The difference from the last total is the turn; a total that went
    // *down* is a fresh count (a /clear, or a conversation that was lost).
    if (e.type === 'turn.done' && e.costTotalUsd != null && s.forkFrom && s.costTotalUsd == null) {
      // A branch's first result carries the running total of the conversation
      // it was copied from. Start counting from it rather than bill the
      // branch for everything its parent ever cost.
      s.costTotalUsd = e.costTotalUsd;
      forwarded = { ...forwarded, costUsd: 0 };
    } else if (e.type === 'turn.done' && e.costTotalUsd != null) {
      const last = s.costTotalUsd ?? 0;
      const turn = e.costTotalUsd >= last ? e.costTotalUsd - last : e.costTotalUsd;
      s.costTotalUsd = e.costTotalUsd;
      forwarded = { ...forwarded, costUsd: Math.round(turn * 1e6) / 1e6 };
    }
    if (e.type === 'turn.done' && s.forkFrom) delete s.forkFrom;
    if (e.type === 'turn.done' && card) this.#core.commandCards.get(s.id)?.delete(e.turnId);
    if (e.type === 'turn.done' && this.#core.index.has(s.id) && !card) {
      // Work the agent began by itself (a background task finishing) after it
      // had reported: it is not a new run of the task. The task keeps the
      // outcome it reported, and the wake-up is not a prompt answered.
      const wake = this.#wakeTurn(s.id, e.turnId);
      if (s.delegation) {
        const settled = s.stoppedAt ? 'interrupted' : e.status === 'ok' ? 'done' : e.status;
        s.delegation.status = wake ? s.stoppedAt ? 'interrupted' : s.delegation.settledStatus ?? settled : settled;
        if (!wake) s.delegation.settledStatus = settled;
        s.delegation.summary = (s.delegationReply?.output || e.error || '').slice(-500);
        if (!wake) s.delegation.finishedAt = Date.now();
        this.#core.delegation.updateTeam(s);
      }
      // A wake-up that was cut short is not the task being stopped.
      if (e.status === 'error' || (e.status === 'interrupted' && !wake)) {
        const limited = e.status === 'error' && isUsageLimit(e);
        // A stop the owner asked for already says so (and whether helpers
        // were stopped too); the driver's own end-of-turn keeps those words.
        const stopped = e.status === 'interrupted' && s.recovery?.kind === 'interrupted' ? s.recovery.message : 'The task was stopped.';
        s.recovery = { kind: limited ? 'limited' : e.status, message: e.error || stopped, at: Date.now() };
        for (const key of ['errorCode', 'errorKind', 'retryable']) {
          if (Object.hasOwn(e, key)) s.recovery[key] = e[key];
        }
        if (limited) {
          s.recovery.resetAt = usageResetAt(e, s.lastLimits, s.recovery.at);
          s.recovery.turnId = e.turnId;
          s.queuePaused = true;
        }
      } else if (!wake && !s.stoppedAt) delete s.recovery;
      if (e.usage) s.lastUsage = { ...e.usage, at: Date.now(), model: s.model || s.engineModel };
      // A CLI that reports tokens but no price (Codex, and most others)
      // still gets a figure, at the same published rates the Usage screen
      // uses, so every chat can say what it cost.
      if (forwarded.costUsd == null && e.usage && e.status !== 'interrupted') {
        const priced = priceTurn(s.engine, s.model || s.engineModel || e.usage.model, e.usage);
        if (priced != null) forwarded = { ...forwarded, costUsd: priced };
      }
      if (!wake) {
        s.turns = (s.turns ?? 0) + 1;
        // A prompt and its first completed reply are two messages. Providers
        // that never emit a title must not leave this chat named for its folder.
        const name = s.generatedTitle || promptTitle(s.promptSample);
        if (name) this.#core.titles.titled(s, name, s.generatedTitle ? 'agent' : 'auto');
      }
      const cost = forwarded.costUsd;
      if (cost > 0) s.costUsd = Math.round(((s.costUsd ?? 0) + cost) * 1e6) / 1e6;
      this.#core.save();
      if (s.delegation) this.#sessions.emit('session', s);
    }
    if (!staleClaudeConversation && d.engineSessionId && d.engineSessionId !== s.engineSessionId) {
      s.engineSessionId = d.engineSessionId;
      this.#core.save();
    }
    const event = this.#sessions.events.append(s.id, forwarded);
    s.lastSeq = event.seq;
    this.#sessions.emit('event', { id: s.id, event });
    if (e.type === 'subagent.status' && e.status === 'idle' && s.delegation && !this.#sessions.hasActiveDelegations(s.id)
      && !['working', 'blocked', 'starting'].includes(s.status)) {
      const done = this.#sessions.events.tail(s.id, 500).findLast(entry => entry.type === 'turn.done');
      if (done) void this.#core.delegation.notifyParent(s, done);
    }
    // A CLI that reads input inside its running loop takes a waiting
    // message as soon as it is working again (see `messageDelivery`).
    if (e.type === 'status' && e.status === 'working') void this.#core.delivery.handOver(s);
    if (e.type === 'turn.done') {
      this.#sessions.emit('session', s);
      if (s.delegation && !card) void this.#core.delegation.notifyParent(s, event);
      if (this.#core.deliveryState.hasSettling(s.id) && !this.#finishing(s)) {
        this.#core.settled(s.id);
        if (s.status === 'idle') this.#core.delivery.pump(s);
      }
    }
  }

  /** Record a driver's turn.done; false when that turn was already closed. */
  #closeTurn(id, turnId) {
    // After a restart the set starts from what the log already shows closed,
    // so a driver replaying a completion it said before cannot count it again.
    this.#core.deliveryState.seedClosedTurns(id,
      () => this.#sessions.events.tail(id, 0).filter((e) => e.type === 'turn.done' && e.turnId).map((e) => e.turnId));
    return this.#core.deliveryState.closeTurn(id, turnId);
  }

  /** Whether this turn began by itself (the agent woke), not from a message of ours. */
  #wakeTurn(id, turnId) {
    return isWakeTurn({ turnId })
      || !!turnId && this.#sessions.events.tail(id, 0).some((e) => e.type === 'turn.start' && e.turnId === turnId && e.wake === true);
  }

  /** Whether this turn is a command card: a local answer, not agent work. */
  #commandCard(id, turnId) {
    if (this.#core.commandCards.get(id)?.has(turnId)) return true;
    return !!turnId && this.#sessions.events.tail(id, 0).some((e) => e.type === 'turn.start' && e.turnId === turnId && e.local === true);
  }

  /** Whether the agent's newest turn is still open in the log. */
  #finishing(s) {
    const turn = this.#sessions.events.activeTurn(s.id);
    return !!turn && !String(turn.turnId).startsWith('local-');
  }

  #awaitTurnDone(s) {
    if (this.#core.deliveryState.hasSettling(s.id)) return;
    const timer = setTimeout(() => {
      if (this.#core.deliveryState.settling(s.id) !== timer) return;
      this.#core.deliveryState.clearSettling(s.id);
      this.#sessions.log(`[${s.id}] idle without finishing its turn; sending what is queued`);
      if (s.status === 'idle') this.#core.delivery.pump(s);
    }, this.#sessions.turnSettleMs);
    timer.unref?.();
    this.#core.deliveryState.setSettling(s.id, timer);
  }
}
