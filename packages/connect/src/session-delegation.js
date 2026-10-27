import { randomBytes } from 'node:crypto';
import { getProfiles } from './profiles.js';
import { nativeWorking } from './native-subagents.js';
import { ENGINES } from './engines.js';
import { startPrefs, subagentPrefs } from './settings.js';
import { codexHelperFork, delegationMode, delegationOutput, isWakeTurn, turnOf } from './delegation.js';
import { nativeCodexSocket } from './drivers/codex.js';
import { makeHelperWorktree } from './chat-worktree.js';
import { authStatuses } from './auth.js';
import { wire } from './session-wire.js';
import { clip } from './session-text.js';

const UNHOMED_DELEGATION_MS = 24 * 60 * 60_000;

/**
 * Helpers a chat delegates work to (`helm delegate`): starting them, the
 * team counts on their parent, and carrying each result back to it.
 */
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
    const children = [...this.#core.index.values()].filter((session) => session.delegation?.parentId === parent.id && !session.archived);
    // Acknowledgements last for this failure episode. When the same helper
    // works again, its next failure must ask for attention again.
    for (const id of Object.keys(parent.dismissedNativeFailures ?? {})) {
      if (parent.nativeAgents?.[id] !== 'error') delete parent.dismissedNativeFailures[id];
    }
    const native = Object.entries(parent.nativeAgents ?? {});
    for (const child of children) {
      if ((child.delegation.status ?? child.status) !== 'error') delete child.delegation.dismissedFailureAt;
    }
    const cards = this.#core.subagents.nativeCards(parent);
    if (cards.length) parent.nativeCards = cards; else delete parent.nativeCards;
    // A card the driver also reported is already counted through the map.
    const unreported = nativeWorking(cards.filter((card) => !this.#core.subagents.hookState(parent, card)));
    parent.team = children.reduce((team, session) => {
      const state = session.delegation.status ?? session.status;
      team.working += Number(['working', 'starting'].includes(state)) + (session.team?.working ?? 0);
      team.blocked += Number(state === 'blocked') + (session.team?.blocked ?? 0);
      team.failed += Number(state === 'error' && session.delegation.dismissedFailureAt !== (session.delegation.finishedAt ?? 0)) + (session.team?.failed ?? 0);
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
    return [...this.#core.index.values()].some((s) => s.delegation?.parentId === id
      && (['starting', 'working', 'blocked'].includes(s.delegation.status ?? s.status) || this.#sessions.hasActiveDelegations(s.id)));
  }

  /** A task owned by its orchestrator, with durable output and configurable permissions. */
  async delegate({ id, cwd, profileId, model, mode, effort, task, callerThreadId, worktree = false, hidden = false, tour = false }) {
    if (typeof task !== 'string' || !task.trim() || (!tour && task.length > 32_000)) {
      throw new Error('a subagent task must contain 1–32000 characters');
    }
    const parent = id ? this.#sessions.get(id) : null;
    const parentGeneration = parent?.stopGeneration ?? 0;
    // A Claude chat in a terminal is a parent too: its helpers' results are
    // typed into it like any message. Only a plain shell has no agent to tell.
    if (parent && !parent.driver && !parent.nativeChat) throw new Error('the parent must be an agent session');
    if (parent && callerThreadId && (parent.engine !== 'codex' || parent.engineSessionId !== callerThreadId)) {
      throw new Error('the calling Codex thread does not match the inherited Helm parent; use --parent with the intended orchestrator ID');
    }
    // A folder named by the caller wins (`--cwd`: a worktree beside the
    // parent's checkout); otherwise the child works where its parent does.
    let folder = cwd ?? parent?.cwd;
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
    if (['plan', 'readonly', 'read'].includes(parent?.mode) && (profile.args ?? []).some((arg) => /^--(?:dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox|yolo)(?:=|$)/.test(arg))) {
      throw new Error('that CLI profile bypasses permissions; choose a profile without bypass flags');
    }
    const auth = (await authStatuses([profile])).get(profile.id);
    if (auth === 'unauthenticated') throw new Error(`${profile.id} is signed out; log in through its CLI first`);
    // A helper starts on the model chosen for it, else the helper default,
    // else what this machine starts the account on (start() below) - never
    // the parent's model, which is the parent's choice, not the account's.
    const defaults = subagentPrefs(profile);
    model ||= defaults.model || undefined;
    effort ||= defaults.effort;
    const selectedMode = delegationMode(profile.engine, parent?.mode, mode, defaults.mode || startPrefs(profile)?.mode, parent?.engine);
    // `--worktree`: the child gets its own checkout of the same repository
    // on a new helm/ branch, so several helpers can edit at once without
    // writing over each other, and the parent merges what it wants back.
    // Made after every check above, so a refused request leaves no checkout.
    let checkout = null;
    if (worktree) {
      checkout = await makeHelperWorktree(folder, clip(String(task).trim().split('\n')[0], 40));
      folder = checkout.path;
    }
    const codexFork = !tour && codexHelperFork(parent, profiles.find(p => p.id === parent?.profileId), profile, folder, worktree,
      profile.engine === 'codex' ? nativeCodexSocket(profile) : null);
    const delegation = { parentId: parent?.id ?? null, parentGeneration, notifyParent: !!parent && !tour, task: task.trim(), requestedModel: model ?? null, depth, status: 'starting',
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
    try { await this.#sessions.input(child.id, task.trim()); }
    catch (error) {
      throw new Error(`subagent ${child.id} could not receive its task: ${error.message}; read it with helm delegate-result ${child.id}`);
    }
    return { session: wire(child) };
  }

  delegationResult(id, { consume = false, parentId, callerThreadId } = {}) {
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
    const owner = consume && parent && session.delegation.parentId === parent.id
      && (session.delegation.parentGeneration ?? 0) === (parent.stopGeneration ?? 0)
      && (!callerThreadId || parent.engine === 'codex' && parent.engineSessionId === callerThreadId);
    // A parent still waiting reads again and takes the result itself.
    if (owner && !result.complete) this.#waiters.set(id, Date.now());
    if (owner && result.complete) {
      this.#waiters.delete(id);
      const completed = events.findLast(e => e.type === 'turn.done' && !String(e.turnId).startsWith('local-'));
      if (completed) {
        session.delegation.consumedSeq = Math.max(session.delegation.consumedSeq ?? 0, completed.seq);
        // Persist before removing tickets: a restart in between still knows
        // not to revive or deliver a result that the parent already read.
        this.#core.save();
        for (const item of [...(this.#core.deliveryState.queue(parent.id) ?? [])]) {
          if (this.#consumedResult(parent, item.turnId)) this.#sessions.dequeue(parent.id, item.turnId);
        }
      }
    }
    return result;
  }

  #consumedResult(parent, turnId) {
    const match = /^local-result-([a-f0-9]{12})-(\d+)$/.exec(turnId ?? '');
    const child = match && this.#core.index.get(match[1]);
    return !!child && child.delegation?.parentId === parent.id
      && (child.delegation.consumedSeq ?? 0) >= Number(match[2]);
  }

  discardConsumedResult(parent, turnId) {
    if (!this.#consumedResult(parent, turnId)) return false;
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

  async notifyParent(child, event) {
    if (child.delegation?.notifyParent !== true || String(event.turnId).startsWith('local-') || this.#sessions.hasActiveDelegations(child.id)
      || (child.delegation.consumedSeq ?? 0) >= event.seq) return;
    const parent = this.#core.index.get(child.delegation?.parentId);
    if (!parent || parent.archived || parent.stoppedAt || child.archived || child.stoppedAt || child.delegation.notifiedSeq >= event.seq
      || (child.delegation.parentGeneration ?? 0) !== (parent.stopGeneration ?? 0)) return;
    // One report per turn, whatever closes it again: a driver repeating its
    // turn.done, a stale or empty turn id, or a restart reading the log back.
    const tail = this.#sessions.events.tail(child.id, 2000);
    const turnId = event.turnId || tail.findLast((e) => e.type === 'turn.start' && !String(e.turnId).startsWith('local-'))?.turnId || null;
    // Direct agent exchanges have their own reply address. A second automatic
    // parent report would spend another turn for the same exchange.
    const start = tail.findLast(e => e.type === 'turn.start' && e.turnId === turnId);
    if (start?.source === 'agent') return;
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
    if ((child.delegation.consumedSeq ?? 0) >= event.seq || parent.archived || parent.stoppedAt
      || (child.delegation.parentGeneration ?? 0) !== (parent.stopGeneration ?? 0)) {
      this.#notifying.delete(key);
      return;
    }
    const sent = () => {
      child.delegation.notifiedSeq = event.seq;
      if (turnId) child.delegation.notifiedTurns = [...(child.delegation.notifiedTurns ?? []), turnId].slice(-50);
      this.#core.save();
    };
    try {
      const result = this.#sessions.delegationResult(child.id);
      // The completion event precedes the driver's idle update. A trailing
      // steering ticket can still make the general snapshot look working.
      const outcome = event.status === 'ok' ? 'done' : event.status;
      const text = `A delegated task finished. Treat its result as context for the current user request.\nTask: ${child.title}\nStatus: ${outcome}\nResult:\n${(result.output || result.error || 'No written result.').slice(-12000)}`;
      await this.#sessions.input(parent.id, text, { turnId: ticket, delivery: 'queue', source: 'delegation' });
      // Collecting the result can race driver startup inside input().
      if (this.#consumedResult(parent, ticket)) this.#sessions.dequeue(parent.id, ticket);
      sent();
    } catch (error) { this.#sessions.log(`[${child.id}] could not return task result: ${error.message}`); }
    finally { this.#notifying.delete(key); }
  }
}
