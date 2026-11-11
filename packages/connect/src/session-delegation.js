import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { getProfiles } from './profiles.js';
import { nativeWorking } from './native-subagents.js';
import { ENGINES } from './engines.js';
import { modelPrefs, startPrefs, subagentPrefs } from './settings.js';
import { codexHelperFork, delegationMode, delegationOutput, isWakeTurn, resultNotice, turnOf } from './delegation.js';
import { nativeCodexSocket } from './drivers/codex.js';
import { makeHelperWorktree } from './chat-worktree.js';
import { authStatuses } from './auth.js';
import { wire } from './session-wire.js';
import { clip } from './session-text.js';
import { acceptAttachments } from './session-attachments.js';

const UNHOMED_DELEGATION_MS = 24 * 60 * 60_000;
const ACTIVE = ['starting', 'working', 'blocked'];
// A parent machine that restarts (every update does) misses a result sent
// meanwhile. Ask again for about ten minutes before the log says so.
const REMOTE_RESULT_TRIES = 20;
const REMOTE_RESULT_RETRY_MS = 30_000;
/** The queue ticket a helper's result goes to its parent under: helper id and the seq of its turn end. */
const RESULT_TICKET = /^local-result-([a-f0-9]{12})-(\d+)$/;

/**
 * The folder a helper from another machine works in: the one it asked for,
 * else its parent's folder at the same place under this machine's home,
 * else this machine's home.
 */
export function remoteHelperFolder(remoteParent, home = homedir()) {
  const cwd = typeof remoteParent?.cwd === 'string' ? remoteParent.cwd : '';
  const theirs = typeof remoteParent?.home === 'string' ? remoteParent.home.replace(/\/+$/, '') : '';
  const mapped = theirs && (cwd === theirs || cwd.startsWith(`${theirs}/`)) ? home + cwd.slice(theirs.length) : cwd;
  return mapped && existsSync(mapped) ? mapped : home;
}

/**
 * Helpers a chat delegates work to (`helm delegate`): starting them, the
 * team counts on their parent, and carrying each result back to it.
 */
/** The parent agent got this helper's latest result: told or read it. `toldFor` is the end it was told about. */
const resultTold = (record) => record?.toldFor !== undefined ? record.toldFor === (record.finishedAt ?? 0)
  // Saved before toldFor existed: any notice or read counts.
  : (record?.notifiedSeq ?? 0) > 0 || (record?.consumedSeq ?? 0) > 0 || (record?.toldSeq ?? 0) > 0;

export class SessionDelegation {
  #sessions;
  #core;
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  /** `<child>:<turn>` whose report to the parent is on its way. */
  #notifying = new Set();
  /** child id -> when its parent last asked for the result (`delegate-result --wait`). */
  #waiters = new Map();
  #listStatuses = new WeakMap();

  listStatus(session) {
    const key = JSON.stringify([session.lastSeq, session.updatedAt, session.status, session.delegation, session.delegationReply]);
    const cached = this.#listStatuses.get(session);
    if (cached?.key === key) return cached.status;
    const status = this.delegationResult(session.id).status;
    this.#listStatuses.set(session, { key, status });
    return status;
  }

  forget(id) { this.#waiters.delete(id); }

  /**
   * A task with no thread to sit under - started from a plain shell, or whose
   * parent is gone - lists on its own. Hiding it left a whole VM team
   * (`helm delegate` run over ssh, then its own children) invisible
   * everywhere. Finished ones drop out after a day; `helm thread` still
   * reaches them.
   */
  unhomedDelegation(s) {
    // A hidden helper (the preferences keeper's) belongs to no chat and is
    // never listed; its starter reads the answer and deletes it.
    if (s.delegation?.hidden) return false;
    // A helper for a chat on another machine shows there, under that chat.
    if (s.delegation?.parentMachine) return false;
    const parentId = s.delegation?.parentId;
    const parent = parentId ? this.#core.index.get(parentId) : null;
    if (parent && !parent.archived) return false;
    const state = s.delegation.status ?? s.status;
    if (!['done', 'error', 'interrupted'].includes(state)) return true;
    return Date.now() - (s.delegation.finishedAt ?? s.updatedAt ?? 0) < UNHOMED_DELEGATION_MS;
  }

  visibleDelegations(parent) {
    return (parent.delegations ?? []).filter((id) => {
      const child = this.#core.index.get(id);
      return child?.delegation?.parentId === parent.id && !child.archived;
    });
  }

  updateTeam(child) {
    if (child.removed) return;
    if (child.delegation?.parentMachine) { this.#pushState(child); return; }
    const parent = this.#core.index.get(child.delegation?.parentId);
    if (!parent) return;
    this.refreshTeam(parent);
  }

  /**
   * The parent's team counts: its delegated children, the subagents its
   * driver reported (`nativeAgents`), and Claude's own subagent cards the
   * driver does not know about. Those cards only add to `working` - one that
   * failed or stopped has no Helm session to answer, so it never asks for you.
   */
  refreshTeam(parent) {
    // A helper here for a chat on another machine belongs to that machine's team.
    const children = [...this.#core.index.values()].filter((session) => session.delegation?.parentId === parent.id
      && !session.delegation.parentMachine && !session.archived);
    // Acknowledgements last for this failure episode. When the same helper
    // works again, its next failure must ask for attention again.
    for (const id of Object.keys(parent.dismissedNativeFailures ?? {})) {
      if (parent.nativeAgents?.[id] !== 'error') delete parent.dismissedNativeFailures[id];
    }
    const native = Object.entries(parent.nativeAgents ?? {});
    for (const child of children) {
      if ((child.delegation.status ?? child.status) !== 'error') delete child.delegation.dismissedFailureAt;
    }
    const remote = (parent.remoteHelpers ?? []).filter((helper) => !helper.archived);
    for (const helper of remote) if (helper.status !== 'error') delete helper.dismissedFailureAt;
    const cards = this.#core.subagents.nativeCards(parent);
    if (cards.length) parent.nativeCards = cards; else delete parent.nativeCards;
    // A card the driver also reported is already counted through the map.
    const unreported = nativeWorking(cards.filter((card) => !this.#core.subagents.hookState(parent, card)));
    // A helper on another machine counts from the state it last sent.
    // A failure its parent agent already has is that agent's to handle, and
    // the agent's reply tells the owner. On 2026-11-11 eight helpers of a
    // lead on why ran out of free limit; the lead ran the work again on Pi,
    // and the owner still saw "8 helper tasks failed" under "Needs you".
    const rows = [...children.map((session) => ({ state: session.delegation.status ?? session.status, team: session.team,
      failed: session.delegation.dismissedFailureAt !== (session.delegation.finishedAt ?? 0) && !resultTold(session.delegation) })),
    ...remote.map((helper) => ({ state: helper.status, team: helper.team,
      failed: helper.dismissedFailureAt !== (helper.finishedAt ?? 0) && !helper.told && !resultTold(helper) }))];
    parent.team = rows.reduce((team, row) => {
      team.working += Number(['working', 'starting'].includes(row.state)) + (row.team?.working ?? 0);
      team.blocked += Number(row.state === 'blocked') + (row.team?.blocked ?? 0);
      team.failed += Number(row.state === 'error' && row.failed) + (row.team?.failed ?? 0);
      return team;
    }, { working: native.filter(([, state]) => state === 'working').length + unreported,
      blocked: native.filter(([, state]) => state === 'blocked').length,
      failed: native.filter(([id, state]) => state === 'error' && !parent.dismissedNativeFailures?.[id]).length });
    this.#sessions.emit('session', parent);
    if (parent.delegation) this.updateTeam(parent);
  }

  /** Acknowledge current child failures without changing their status or history. */
  dismissChildFailures(id) {
    const parent = this.#sessions.get(id);
    const visited = new Set();
    const dismiss = (session) => {
      if (visited.has(session.id)) return;
      visited.add(session.id);
      for (const [agentId, state] of Object.entries(session.nativeAgents ?? {})) {
        if (state === 'error') (session.dismissedNativeFailures ??= {})[agentId] = true;
      }
      for (const helper of session.remoteHelpers ?? []) {
        if (helper.status === 'error') helper.dismissedFailureAt = helper.finishedAt ?? 0;
      }
      for (const child of this.#core.index.values()) {
        if (child.archived || child.delegation?.parentId !== session.id) continue;
        if ((child.delegation.status ?? child.status) === 'error') {
          child.delegation.dismissedFailureAt = child.delegation.finishedAt ?? 0;
        }
        dismiss(child);
      }
      this.refreshTeam(session);
    };
    dismiss(parent);
    this.#core.save();
    return { session: wire(parent) };
  }

  /** Provider history must not rediscover a hidden task as an ordinary chat. */
  isDelegatedConversation(engine, id) {
    return [...this.#core.index.values()].some((s) => s.delegation && s.engine === engine && s.engineSessionId === id);
  }

  hasActiveDelegations(id) {
    if (Object.values(this.#core.index.get(id)?.nativeAgents ?? {}).some(state => ['working', 'blocked'].includes(state))) return true;
    if ((this.#core.index.get(id)?.remoteHelpers ?? []).some((helper) => !helper.archived && ACTIVE.includes(helper.status))) return true;
    return [...this.#core.index.values()].some((s) => s.delegation?.parentId === id && !s.delegation.parentMachine
      && (['starting', 'working', 'blocked'].includes(s.delegation.status ?? s.status) || this.#sessions.hasActiveDelegations(s.id)));
  }

  /** A task owned by its orchestrator, with durable output and configurable permissions. */
  async delegate({ id, cwd, profileId, model, mode, effort, task, attachments = [], callerThreadId, worktree = false, hidden = false, tour = false, remoteParent = null }) {
    if (typeof task !== 'string' || !task.trim() || (!tour && task.length > 32_000)) {
      throw new Error('a subagent task must contain 1–32000 characters');
    }
    // Pictures and files pasted into the task go with its first message.
    // Checked here, so a bad one starts no helper.
    acceptAttachments(attachments);
    // `remoteParent`: the chat that asked lives on another machine
    // (`helm delegate --machine`). This machine only knows what it sent.
    if (remoteParent && id) throw new Error('a helper has one parent chat');
    const parent = id ? this.#sessions.get(id) : null;
    const parentGeneration = parent?.stopGeneration ?? remoteParent?.generation ?? 0;
    const parentMode = parent?.mode ?? remoteParent?.mode;
    const parentEngine = parent?.engine ?? remoteParent?.engine;
    // A Claude chat in a terminal is a parent too: its helpers' results are
    // typed into it like any message. Only a plain shell has no agent to tell.
    if (parent && !parent.driver && !parent.nativeChat) throw new Error('the parent must be an agent session');
    if (parent && callerThreadId && (parent.engine !== 'codex' || parent.engineSessionId !== callerThreadId)) {
      throw new Error('the calling Codex thread does not match the inherited Helm parent; use --parent with the intended orchestrator ID');
    }
    // A folder named by the caller wins (`--cwd`: a worktree beside the
    // parent's checkout); otherwise the child works where its parent does.
    let folder = cwd ?? parent?.cwd ?? (remoteParent ? remoteHelperFolder(remoteParent) : undefined);
    if (typeof folder !== 'string' || !folder.trim()) throw new Error('delegation needs a working folder');
    // No depth cap (the owner's rule: no hidden limits on agents). Depth is
    // still counted for display, and a chain that leads back to itself - a
    // damaged index, never a real request - stops the walk.
    let depth = 1, ancestor = parent;
    const seen = new Set();
    while (ancestor?.delegation && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      depth++;
      ancestor = this.#core.index.get(ancestor.delegation.parentId);
    }
    const profiles = await getProfiles();
    const profile = profiles.find((p) => p.id === profileId && !p.disabled);
    if (!profile || !ENGINES[profile.engine]?.driver) throw new Error('choose a CLI account with a headless driver');
    if (['plan', 'readonly', 'read'].includes(parentMode) && (profile.args ?? []).some((arg) => /^--(?:dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox|yolo)(?:=|$)/.test(arg))) {
      throw new Error('that CLI profile bypasses permissions; choose a profile without bypass flags');
    }
    const auth = (await authStatuses([profile])).get(profile.id);
    if (auth === 'unauthenticated') throw new Error(`${profile.id} is signed out; log in through its CLI first`);
    // Keep the parent's model on the same engine so eligible forks can
    // reuse its cache. Explicit and saved helper choices still win.
    // Another engine uses its own account default.
    const defaults = subagentPrefs(profile);
    model ||= defaults.model || (parentEngine === profile.engine
      ? (parent ? parent.engineModel || parent.model : remoteParent.model) : null) || undefined;
    effort ||= defaults.effort;
    const selectedMode = delegationMode(profile.engine, parentMode, mode, defaults.mode || startPrefs(profile)?.mode, parentEngine);
    // `--worktree`: the child gets its own checkout of the same repository
    // on a new helm/ branch, so several helpers can edit at once without
    // writing over each other, and the parent merges what it wants back.
    // Made after every check above, so a refused request leaves no checkout.
    let checkout = null;
    if (worktree) {
      checkout = await makeHelperWorktree(folder, clip(String(task).trim().split('\n')[0], 40));
      folder = checkout.path;
    }
    // The model the helper will start on (sessions.start): its own, else the account's.
    const codexFork = !tour && codexHelperFork(parent, profiles.find(p => p.id === parent?.profileId), profile, folder, worktree,
      profile.engine === 'codex' ? nativeCodexSocket(profile) : null, model || modelPrefs(profile)?.default || null);
    const delegation = { parentId: parent?.id ?? remoteParent?.id ?? null, parentGeneration, notifyParent: (!!parent || !!remoteParent) && !tour, task: task.trim(), requestedModel: model ?? null, depth, status: 'starting',
      ...(remoteParent ? { parentMachine: remoteParent.machine } : {}),
      ...(codexFork ? { codexFork } : {}),
      ...(checkout ? { worktree: { path: checkout.path, branch: checkout.branch, base: checkout.base, repo: checkout.repo } } : {}),
      ...(hidden && !parent ? { hidden: true } : {}) };
    const child = await this.#sessions.start({ cwd: folder, profileId, model, effort, mode: selectedMode,
      title: clip(task.trim().split('\n')[0], 80), delegation, helperWorktree: checkout });
    if (parent && (parent.stopGeneration ?? 0) !== parentGeneration) {
      await this.#sessions.kill(child.id);
      throw new Error('the parent stopped before this task could start');
    }
    if ((model && child.model !== model) || (selectedMode && child.mode !== selectedMode)) {
      await this.#sessions.kill(child.id);
      throw new Error('the CLI refused the selected subagent model or permissions; no task was sent');
    }
    if (parent) {
      parent.delegations = [...(parent.delegations ?? []), child.id].slice(-100);
      parent.updatedAt = Date.now();
    }
    this.#core.save();
    this.#sessions.emit('session', child);
    this.updateTeam(child);
    if (parent) this.#sessions.emit('session', parent);
    // Codex may keep the parent's context. Helm's own history starts here.
    try { await this.#sessions.input(child.id, task.trim(), attachments?.length ? { attachments } : undefined); }
    catch (error) {
      throw new Error(`subagent ${child.id} could not receive its task: ${error.message}; read it with helm delegate-result ${child.id}`);
    }
    return { session: wire(child) };
  }

  /** Close lost work once. Keep the conversation and use the normal parent receipt. */
  processGone(child, { code = null, signal = null, reason = null } = {}) {
    if (!child.delegation) return;
    if (!ACTIVE.includes(child.delegation.status)) {
      if (code != null || signal) {
        Object.assign(child.delegation, { exitCode: code, signal });
        this.#core.save();
        this.#sessions.emit('session', child);
      }
      return;
    }
    const error = reason || `The helper process exited${code != null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`;
    const turn = this.#sessions.events.activeTurn(child.id);
    const event = this.#sessions.events.append(child.id, {
      type: 'turn.done', turnId: turn?.turnId || `process-exit-${randomBytes(6).toString('hex')}`,
      status: 'error', error, exitCode: code, signal,
    });
    Object.assign(child.delegation, { status: 'error', settledStatus: 'error', summary: error,
      finishedAt: Date.now(), exitCode: code, signal });
    child.status = 'idle';
    child.recovery = { kind: 'error', message: error, at: Date.now() };
    const status = this.#sessions.events.append(child.id, { type: 'status', status: 'idle' });
    child.lastSeq = status.seq;
    delete child.nativeAgents;
    this.#core.save();
    this.updateTeam(child);
    this.#sessions.emit('event', { id: child.id, event });
    this.#sessions.emit('event', { id: child.id, event: status });
    this.#sessions.emit('session', child);
    void this.notifyParent(child, event);
  }

  delegationResult(id, { consume = false, parentId, callerThreadId, parentMachine } = {}) {
    const session = this.#sessions.get(id);
    if (!session.delegation) throw new Error('that session is not a delegated CLI task');
    // Command cards answered beside the task are not its result.
    const all = this.#sessions.events.tail(id, 2000);
    const cards = new Set(all.filter((e) => e.type === 'turn.start' && e.local === true).map((e) => e.turnId));
    const events = cards.size ? all.filter((e) => !cards.has(e.turnId)) : all;
    // The open turn is read from the whole log, not the tail above.
    const active = this.#sessions.events.activeTurn(id);
    const result = delegationOutput(wire(session), events, active);
    const reply = session.delegationReply;
    const start = events.findLast((e) => e.type === 'turn.start');
    if (reply && (!start || start.turnId === reply.turnId)) {
      result.output = reply.output;
      result.truncated = reply.truncated;
      // A reply saved by an older Helm has no final message: keep the one read from the log.
      if (typeof reply.final === 'string') result.final = reply.final;
      const status = session.delegation.status;
      // A saved outcome is the task's end only once the CLI's own turn is.
      // A restart can leave "done" on a helper that is still working.
      const running = ['starting', 'working'].includes(session.status) && !!active;
      if (['done', 'error', 'interrupted'].includes(status) && !running) {
        result.status = status; result.complete = true;
      }
    }
    // Only the owning orchestrator collecting a final result acknowledges
    // delivery. UI/history reads and unrelated inherited CLI environments
    // must not silence the parent's notification.
    const parent = this.#core.index.get(parentId);
    // A parent on another machine reads through its own Helm, which checked
    // the chat there (agent.js checks the asking machine).
    const remoteOwner = consume && !!parentMachine && session.delegation.parentMachine === parentMachine
      && session.delegation.parentId === parentId;
    const owner = remoteOwner || consume && parent && !session.delegation.parentMachine && session.delegation.parentId === parent.id
      && (session.delegation.parentGeneration ?? 0) === (parent.stopGeneration ?? 0)
      && (!callerThreadId || parent.engine === 'codex' && parent.engineSessionId === callerThreadId);
    // A parent still waiting reads again and takes the result itself.
    if (owner && !result.complete) this.#waiters.set(id, Date.now());
    if (owner && result.complete) {
      const completed = events.findLast(e => e.type === 'turn.done' && !String(e.turnId).startsWith('local-'));
      if (completed) {
        const previous = session.delegation.consumedSeq;
        session.delegation.consumedSeq = Math.max(session.delegation.consumedSeq ?? 0, completed.seq);
        // Persist before removing tickets: a restart in between still knows
        // not to revive or deliver a result that the parent already read.
        this.#core.save();
        if (!this.#core.flush()) {
          if (previous === undefined) delete session.delegation.consumedSeq;
          else session.delegation.consumedSeq = previous;
          this.#core.save();
          throw new Error('Could not save the result receipt. Read the result again.');
        }
        this.#waiters.delete(id);
        session.delegation.toldFor = session.delegation.finishedAt ?? 0;
        this.updateTeam(session);
        if (!remoteOwner) this.#dropConsumed(parent);
      }
      result.consumedSeq = session.delegation.consumedSeq;
    }
    return result;
  }

  #dropConsumed(parent) {
    for (const item of [...(this.#core.deliveryState.queue(parent.id) ?? [])]) {
      if (this.#core.deliveryState.delivering(parent.id) === item.turnId) continue;
      if (this.#unread(parent, item.turnId) === '') this.#sessions.dequeue(parent.id, item.turnId);
    }
  }

  #consumedResult(parent, turnId) {
    const match = RESULT_TICKET.exec(turnId ?? '');
    const remote = match && parent.remoteHelpers?.find((helper) => helper.id === match[1]);
    if (remote) return (remote.consumedSeq ?? 0) >= Number(match[2]);
    const child = match && this.#core.index.get(match[1]);
    return !!child && child.delegation?.parentId === parent.id
      && (child.delegation.consumedSeq ?? 0) >= Number(match[2]);
  }

  /**
   * The results a waiting result ticket holds. Results that end while the
   * parent works join one ticket (#queueResult), so one parent turn reads
   * them all; its last edit names each result and its length in the text.
   */
  #parts(parentId, turnId) {
    const events = this.#sessions.events.tail(parentId, 0);
    const last = events.findLast((e) => e.turnId === turnId && (e.type === 'turn.edit' || e.type === 'turn.start'));
    const text = last?.text ?? '';
    if (!Array.isArray(last?.parts)) return { text, parts: [{ turnId, text }] };
    let at = 0;
    const parts = last.parts.map((part) => {
      const block = text.slice(at, at + part.chars);
      at += part.chars + 2;
      return { turnId: part.turnId, text: block };
    });
    return { text, parts };
  }

  /** Write which results a waiting ticket holds, as one edit of its text. */
  #rewrite(parent, turnId, parts) {
    const text = parts.map((part) => part.text).join('\n\n');
    const event = this.#sessions.events.append(parent.id, { type: 'turn.edit', turnId, text,
      parts: parts.map((part) => ({ turnId: part.turnId, chars: part.text.length })) });
    parent.lastSeq = event.seq;
    this.#sessions.emit('event', { id: parent.id, event });
    this.#core.deliveryState.updateTicket(parent.id, turnId, { text });
    return text;
  }

  /**
   * What a result ticket still has to say once the parent read some of its
   * results with `helm delegate-result`: null when it is not a result ticket
   * or nothing in it was read, '' when every result in it was read, else
   * the text left, written back to the ticket.
   */
  #unread(parent, turnId) {
    if (!RESULT_TICKET.test(turnId ?? '')) return null;
    const { parts } = this.#parts(parent.id, turnId);
    const left = parts.filter((part) => !this.#consumedResult(parent, part.turnId));
    if (left.length === parts.length) return null;
    return left.length ? this.#rewrite(parent, turnId, left) : '';
  }

  /**
   * Give a result to the parent. A result ticket still waiting for the
   * parent takes it in: each extra parent turn reads the parent's whole
   * history again. The parent never gets it mid-turn: it waits for the
   * turn to end, like any queued result.
   */
  async #queueResult(parent, ticket, text) {
    const block = text.replace(/\n$/, '');
    // Told already, alone or inside another result's ticket: a restart can
    // report the same turn again.
    if (this.#sessions.events.tail(parent.id, 0).some((e) => e.type === 'turn.edit' && e.parts?.some((part) => part.turnId === ticket))) return;
    // Its own ticket exists: input() answers that it is a duplicate.
    const lead = parent.stoppedAt || this.#sessions.events.turnState(parent.id, ticket) !== null ? null : (this.#core.deliveryState.queue(parent.id) ?? []).findLast((item) =>
      RESULT_TICKET.test(item.turnId) && item.source === 'delegation' && item.delivery === 'queue'
      && (item.stopGeneration ?? 0) === (parent.stopGeneration ?? 0) && this.#core.deliveryState.delivering(parent.id) !== item.turnId);
    if (!lead) {
      await this.#sessions.input(parent.id, text, { turnId: ticket, delivery: 'queue', source: 'delegation' });
      return;
    }
    const { parts } = this.#parts(parent.id, lead.turnId);
    this.#rewrite(parent, lead.turnId, [...parts, { turnId: ticket, text: block }]);
  }

  discardConsumedResult(parent, turnId, item = null) {
    const left = this.#unread(parent, turnId);
    if (left === null) return false;
    if (left) {
      if (item) item.text = left;
      return false;
    }
    if (this.#sessions.events.turnState(parent.id, turnId) === 'open') {
      const event = this.#sessions.events.append(parent.id, { type: 'turn.remove', turnId });
      parent.lastSeq = event.seq;
      this.#sessions.emit('event', { id: parent.id, event });
    }
    return true;
  }

  /** Follow-ups remain on the same task; running agents can be steered without opening a chat. */
  async messageDelegation(parentId, id, data) {
    const child = this.#sessions.get(id);
    if (!child.delegation || child.delegation.parentId !== parentId) throw new Error('that task does not belong to this orchestrator');
    if (typeof data !== 'string' || !data.trim() || data.length > 32_000) throw new Error('a task message must contain 1–32000 characters');
    const d = this.#core.drivers.get(id);
    const turnId = `local-message-${randomBytes(6).toString('hex')}`;
    await this.#sessions.input(id, data.trim(), { turnId });
    if (child.status === 'working' && typeof d?.steer === 'function') {
      if (!this.#core.deliveryState.isSending(id)) await this.#sessions.sendNow(id, turnId);
    }
    return { ok: true };
  }

  #unansweredParent(child, parent, start) {
    // The header AgentMessages.receive puts on every agent message.
    const sender = /^\[Helm agent message [a-f0-9]{32}\]\nFrom [^\n]*\([^/\s()]+\/([^)\s]+)\)\./.exec(start.text ?? '');
    if (sender?.[1] !== parent.id) return false;
    try { return !this.#sessions.sentAgentMessage?.(child.id, parent.id, start.at ?? 0); }
    catch { return true; }
  }

  async notifyParent(child, event) {
    if (child.delegation?.notifyParent !== true || String(event.turnId).startsWith('local-') || this.#sessions.hasActiveDelegations(child.id)
      || (child.delegation.consumedSeq ?? 0) >= event.seq) return;
    // A parent on another machine is checked there when the result lands.
    const away = child.delegation.parentMachine;
    const parent = away ? { id: child.delegation.parentId } : this.#core.index.get(child.delegation?.parentId);
    const gone = () => !away && (!parent || parent.archived || parent.stoppedAt
      || (child.delegation.parentGeneration ?? 0) !== (parent.stopGeneration ?? 0));
    if (gone() || child.archived || child.stoppedAt || child.delegation.notifiedSeq >= event.seq) return;
    // One report per turn, whatever closes it again: a driver repeating its
    // turn.done, a stale or empty turn id, or a restart reading the log back.
    const tail = this.#sessions.events.tail(child.id, 2000);
    const turnId = event.turnId || tail.findLast((e) => e.type === 'turn.start' && !String(e.turnId).startsWith('local-'))?.turnId || null;
    // Direct agent exchanges have their own reply address. A second automatic
    // parent report would spend another turn for the same exchange. A
    // follow-up from the parent itself is more of the task: a helper that
    // ends it without writing back still reports, or the parent waits forever.
    const start = tail.findLast(e => e.type === 'turn.start' && e.turnId === turnId);
    if (start?.source === 'agent' && !this.#unansweredParent(child, parent, start)) return;
    const told = child.delegation.notifiedTurns ?? [];
    // Woken by its own background work (a watcher timing out) after the
    // parent has its result: never another parent turn. Those were nearly
    // always "a stale watcher finished, nothing changed" and each one woke
    // the parent and left a card in its chat. A helper with real news uses
    // `helm say`, which waits for the parent's next turn; the wake-up's text
    // still joins the task's result for anyone who reads it.
    if (isWakeTurn(turnOf(tail, turnId)) && (told.length || child.delegation.notifiedSeq > 0 || child.delegation.consumedSeq > 0)) return;
    const key = `${child.id}:${turnId}`;
    if (turnId && (told.includes(turnId) || this.#notifying.has(key))) return;
    if (turnId) this.#notifying.add(key);
    const ticket = `local-result-${child.id}-${event.seq}`;
    // A parent blocked in `delegate-result --wait` reads again within a
    // second and gets the result there. Telling it as well cost it a second
    // turn for the same report, so give that read the chance to land first.
    // A waiter that gave up (timed out, killed) stops reading, and the
    // notice goes out as before.
    const until = Date.now() + this.#sessions.waiterGraceMs * 5;
    while (Date.now() < until && Date.now() - (this.#waiters.get(child.id) ?? 0) < this.#sessions.waiterGraceMs
      && (child.delegation.consumedSeq ?? 0) < event.seq) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, this.#sessions.waiterGraceMs)));
    }
    if ((child.delegation.consumedSeq ?? 0) >= event.seq || gone()) {
      this.#notifying.delete(key);
      return;
    }
    const sent = () => {
      child.delegation.notifiedSeq = event.seq;
      child.delegation.toldFor = child.delegation.finishedAt ?? 0;
      if (turnId) child.delegation.notifiedTurns = [...(child.delegation.notifiedTurns ?? []), turnId].slice(-50);
      this.updateTeam(child);
      this.#core.save();
    };
    try {
      const result = this.#sessions.delegationResult(child.id);
      // The completion event precedes the driver's idle update. A trailing
      // steering ticket can still make the general snapshot look working.
      const outcome = event.status === 'ok' ? 'done' : event.status;
      // The machine this helper ran on: this one.
      const here = this.#sessions.selfId;
      const machine = away ? this.#sessions.machineName?.(here) ?? here ?? 'another machine' : null;
      const text = resultNotice({ id: child.id, title: child.title, machine, status: outcome, final: result.final, error: result.error });
      if (away) {
        if (!await this.#sendRemoteResult(child, { seq: event.seq, status: outcome, text })) return;
      } else {
        await this.#queueResult(parent, ticket, text);
        // Collecting the result can race driver startup inside input().
        this.#dropConsumed(parent);
      }
      sent();
    } catch (error) { this.#sessions.log(`[${child.id}] could not return task result: ${error.message}`); }
    finally { this.#notifying.delete(key); }
  }

  // ------------------------------------------------- helpers on other machines

  /** child id -> the state last sent to its parent's machine. */
  #pushed = new Map();

  /** A helper for a chat on another machine tells that machine how it is. */
  #pushState(child) {
    const helper = this.remoteState(child);
    const said = JSON.stringify(helper);
    if (this.#pushed.get(child.id) === said || !this.#sessions.remoteRpc) return;
    this.#pushed.set(child.id, said);
    this.#sessions.remoteRpc(child.delegation.parentMachine, 'session.helper-state', { parentId: child.delegation.parentId, helper })
      .catch(() => { if (this.#pushed.get(child.id) === said) this.#pushed.delete(child.id); });
  }

  remoteState(child) {
    return { id: child.id, title: child.title, status: this.delegationResult(child.id).status,
      ...(child.team ? { team: child.team } : {}), ...(child.delegation.finishedAt ? { finishedAt: child.delegation.finishedAt } : {}),
      ...(resultTold(child.delegation) ? { told: true } : {}),
      ...(child.archived ? { archived: true } : {}) };
  }

  /** Give the result to the parent's machine. False when it never answered. */
  async #sendRemoteResult(child, { seq, status, text }) {
    const machine = child.delegation.parentMachine;
    for (let tries = 1; ; tries++) {
      // Read by the parent first: it has the result, so nothing is sent.
      if ((child.delegation.consumedSeq ?? 0) >= seq || child.archived) return false;
      try {
        await this.#sessions.remoteRpc(machine, 'session.helper-result', {
          parentId: child.delegation.parentId, generation: child.delegation.parentGeneration ?? 0,
          helper: this.remoteState(child), seq, status, text });
        return true;
      } catch (error) {
        if (tries >= REMOTE_RESULT_TRIES || /not a helper of that chat|Unknown method/i.test(error.message)) {
          this.#sessions.log(`[${child.id}] could not give the result to its chat on ${machine}: ${error.message}`);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, REMOTE_RESULT_RETRY_MS).unref?.());
      }
    }
  }

  /** The parent's side: a helper started on another machine. */
  addRemoteHelper(parentId, helper) {
    const parent = this.#sessions.get(parentId);
    parent.remoteHelpers = [...(parent.remoteHelpers ?? []).filter((h) => h.id !== helper.id), helper];
    parent.updatedAt = Date.now();
    this.refreshTeam(parent);
    this.#core.save();
  }

  /** Repair saved helper states only after their machine answers a full list. */
  async reconcileRemoteHelpers(parentId) {
    const parent = this.#core.index.get(parentId);
    if (!parent || !this.#sessions.remoteRpc) return;
    const links = (parent.remoteHelpers ?? []).filter((h) => !h.removed && !h.archived);
    await Promise.all([...new Set(links.map((h) => h.machine))].map(async (machine) => {
      let reply;
      try { reply = await this.#sessions.remoteRpc(machine, 'session.list', { parentId, nested: true }); }
      catch { return; }
      if (!Array.isArray(reply?.sessions)) return;
      for (const helper of links.filter((h) => h.machine === machine)) {
        if (reply.sessions.some((s) => s.id === helper.id)) continue;
        this.remoteHelperState(machine, { parentId, helper: { id: helper.id, status: 'interrupted', removed: true } });
      }
    }));
  }

  /** The parent and its record of a helper on `machine`, or null. */
  remoteHelper(id, { parentId, machine } = {}) {
    const parents = parentId ? [this.#core.index.get(parentId)].filter(Boolean) : [...this.#core.index.values()];
    for (const parent of parents) {
      const helper = parent.remoteHelpers?.find((h) => h.id === id && (!machine || h.machine === machine));
      if (helper) return { parent, helper };
    }
    return null;
  }

  #ownRemote(machine, parentId, state) {
    const found = this.remoteHelper(state?.id, { parentId, machine });
    if (!found) throw new Error('that task is not a helper of that chat');
    return found;
  }

  /** A helper on `machine` changed state. */
  remoteHelperState(machine, { parentId, helper: state }) {
    const { parent, helper } = this.#ownRemote(machine, parentId, state);
    if (helper.removed && !state.removed) return { ok: true };
    Object.assign(helper, { title: state.title ?? helper.title, status: state.status, team: state.team,
      removed: state.removed === true, ...(state.result ? { result: state.result } : {}),
      finishedAt: state.finishedAt, archived: state.archived === true, told: state.told === true });
    if (!state.team) delete helper.team;
    if (!state.told) delete helper.told;
    if (!state.archived) delete helper.archived;
    this.refreshTeam(parent);
    this.#core.save();
    return { ok: true };
  }

  /** A helper on `machine` finished: its result starts a parent turn, as a local one does. */
  async remoteHelperResult(machine, { parentId, generation = 0, helper: state, seq, text }) {
    const { parent, helper } = this.#ownRemote(machine, parentId, state);
    if (helper.removed) return { ok: true, skipped: true };
    this.remoteHelperState(machine, { parentId, helper: state });
    if (!Number.isInteger(seq) || typeof text !== 'string' || text.length > 20_000) throw new Error('a helper result needs its number and text');
    // Stopped since, read already, or told before: nothing to say.
    if (parent.archived || parent.stoppedAt || (parent.stopGeneration ?? 0) !== generation
      || (helper.consumedSeq ?? 0) >= seq || (helper.toldSeq ?? 0) >= seq) return { ok: true, skipped: true };
    const ticket = `local-result-${helper.id}-${seq}`;
    await this.#queueResult(parent, ticket, text);
    helper.toldSeq = seq;
    helper.toldFor = helper.finishedAt ?? 0;
    this.refreshTeam(parent);
    this.#dropConsumed(parent);
    this.#core.save();
    return { ok: true };
  }

  /** The parent read a helper's result on the helper's machine. */
  remoteConsumed(parent, id, seq) {
    const helper = parent.remoteHelpers?.find((h) => h.id === id);
    if (!helper || !Number.isInteger(seq)) return;
    helper.consumedSeq = Math.max(helper.consumedSeq ?? 0, seq);
    helper.toldFor = helper.finishedAt ?? 0;
    this.refreshTeam(parent);
    this.#core.save();
    this.#dropConsumed(parent);
  }

  /** Helpers on other machines still at work when their chat stops. */
  runningRemote(parent) {
    return (parent?.remoteHelpers ?? []).filter((helper) => !helper.archived && ACTIVE.includes(helper.status));
  }
}
