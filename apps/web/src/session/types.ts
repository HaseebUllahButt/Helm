/**
 * The conversation as the app sees it, reduced from helm's session events.
 *
 * A driver turns an agent's own protocol into a small vocabulary of events
 * (see packages/connect/src/drivers/index.js); this is the state those
 * events build: turns of items, and the prompts still waiting on a person.
 */

export interface HelmEvent { seq: number; at: number; type: string; [k: string]: any }

export type ItemKind = 'text' | 'thinking' | 'tool' | 'command' | 'edit' | 'subagent' | 'error';
export type ItemStatus = 'streaming' | 'ok' | 'error' | 'declined';

export interface Change { path: string; kind: string; diff: string }

/** What the engine says about a spawned agent, while it runs and when it lands. */
export interface AgentInfo {
  id?: string;
  status?: string;
  /** What it is doing *now*. Claude rewrites this as the child works. */
  description?: string;
  lastTool?: string;
  toolUses?: number;
  tokens?: number;
  summary?: string;
}

/**
 * Fold one engine update into what is already known about a spawned agent.
 *
 * This has to merge rather than replace. The engines send a fat frame while
 * the agent works (`lastTool`, `toolUses`, `tokens`) and a thin one when it
 * lands (`status`, `summary`) - so assigning the new object over the old
 * threw away every number the run had accumulated at the exact moment the
 * run finished and the numbers became worth reading. Seen in a real run:
 *
 *   {status:running, description:"List .ts files", lastTool:"Bash", tokens:8531}
 *   {status:running}                          <- wiped it
 *   {status:completed, summary:"Found 2 ..."}  <- and again
 */
export function foldAgent(prev: AgentInfo | undefined, next: AgentInfo): AgentInfo {
  return { ...prev, ...next };
}

export interface Item {
  id: string;
  kind: ItemKind;
  turnId?: string;
  /** Set when this item ran inside a subagent: the id of its `subagent` card. */
  parentId?: string;
  agent?: AgentInfo;
  /** Prose, thinking, or command output as it streams. */
  text: string;
  /** Tools: the name, and the input either parsed or as partial JSON. */
  name?: string;
  input?: any;
  inputJson?: string;
  command?: string;
  cwd?: string;
  changes?: Change[];
  status: ItemStatus;
  output?: string;
  exitCode?: number;
  error?: string;
  elapsed?: number;
  result?: any;
  startedAt: number;
  doneAt?: number;
}

/**
 * `usage` is kept because the cached figure is what a mid-thread model or
 * effort change would throw away: both invalidate the provider's messages
 * cache, so the whole conversation is written to cache again at the write
 * rate. Knowing how much is cached is the difference between warning about
 * that and guessing at it.
 */
export interface TurnUsage { input?: number; output?: number; cacheRead?: number }

export interface TurnEnd {
  status: 'ok' | 'interrupted' | 'error';
  costUsd?: number;
  durationMs?: number;
  error?: string;
  usage?: TurnUsage;
}

export interface Turn {
  id: string;
  text: string;
  at: number;
  /** Still in helm's outbox: accepted, but the agent has not seen it yet. */
  queued?: boolean;
  attachments?: { filename: string; mime: string; data?: string; bytes?: number; missing?: boolean }[];
  items: Item[];
  done?: TurnEnd;
}

export interface QuestionOption { label: string; description?: string; preview?: string }
export interface Question {
  question: string;
  header?: string;
  id?: string;
  multiSelect?: boolean;
  secret?: boolean;
  options: QuestionOption[];
}

export interface PermissionOption { id: string; role: 'allow' | 'allow-always' | 'deny' | 'custom'; label: string }

export interface Permission {
  requestId: string;
  itemId?: string;
  /** The subagent item this request came from, when a child agent is asking. */
  parentId?: string;
  kind: 'tool' | 'command' | 'edit' | 'question' | 'plan';
  tool?: string;
  title: string;
  detail?: any;
  reason?: string;
  input?: any;
  questions?: Question[];
  options: PermissionOption[];
  defaultTo: 'allow' | 'deny';
  allowEdit?: boolean;
  seq: number;
  /** When the request was raised - "waiting 12m" is computed from it. */
  at?: number;
}

/** What the person chose; the driver turns it into the CLI's wire shape. */
export interface Decision {
  option: 'allow' | 'always' | 'deny';
  message?: string;
  answers?: Record<string, string>;
  updatedInput?: any;
}

export interface LogState {
  turns: Turn[];
  pending: Permission[];
  /** The agent's state as of the last event: working, blocked, idle. */
  status: string;
  last: number;
  loaded: boolean;
  limits?: any;
}

export const emptyLog = (): LogState => ({ turns: [], pending: [], status: 'idle', last: 0, loaded: false });

// ------------------------------------------------------------------ reduce

const findItem = (turns: Turn[], id: string): Item | undefined => {
  for (let i = turns.length - 1; i >= 0; i--) {
    const it = turns[i].items.find((x) => x.id === id);
    if (it) return it;
  }
  return undefined;
};

const turnFor = (turns: Turn[], turnId?: string): Turn | undefined =>
  (turnId && turns.find((t) => t.id === turnId)) || turns[turns.length - 1];

/**
 * Apply one event. Mutates in place for speed - deltas arrive many times a
 * second - and the hook clones the top-level object to re-render.
 */
export function apply(state: LogState, e: HelmEvent): void {
  if (e.seq <= state.last) return;
  state.last = e.seq;
  switch (e.type) {
    case 'turn.start': {
      const id = e.turnId ?? String(e.seq);
      // helm posts the owner's message the moment it is sent, so it shows
      // at once instead of when the agent gets round to echoing it - a
      // message queued behind a running turn can wait minutes for that.
      // The agent then announces the same turn under its own id, without
      // the attachment. Adopting the local turn rather than pushing a
      // second one is what keeps a message from showing up twice.
      //
      // The scan is backwards and not just at the tail: with two queued
      // messages the first echo arrives while the second is still the last
      // turn, so only looking at the end duplicated every queued send.
      // The oldest still-open match takes it, so two identical queued
      // messages stay in the order they were sent.
      const echo = (e.text ?? '').trim();
      let open: Turn | undefined;
      for (let i = 0; i < state.turns.length; i++) {
        const t = state.turns[i];
        if (!t.id.startsWith('local-') || t.items.length || t.done) continue;
        // Compared trimmed: helm strips the trailing newline off what it
        // sends, and the CLI echoes the prompt back with it still attached.
        // A prefix match covers the one case where the text sent and the
        // text echoed differ on purpose: an agent that cannot see images
        // gets their names appended before the send.
        const mine = t.text.trim();
        if (mine === echo || (mine && echo.startsWith(mine + '\n'))) { open = t; break; }
      }
      if (open) { open.id = id; open.queued = false; return; }
      state.turns.push({ id, text: e.text ?? '', at: e.at, items: [], attachments: e.attachments ?? [], queued: e.queued === true });
      return;
    }
    case 'item.start': {
      const turn = turnFor(state.turns, e.turnId);
      if (!turn) return;
      if (turn.items.some((x) => x.id === e.id)) return;
      turn.items.push({
        id: e.id, kind: e.kind, turnId: e.turnId, text: '', status: 'streaming', startedAt: e.at,
        name: e.name, input: e.input, command: e.command, cwd: e.cwd, changes: e.changes,
        parentId: e.parentId, agent: e.agent,
      });
      return;
    }
    case 'item.delta': {
      const it = findItem(state.turns, e.id);
      if (!it) return;
      if (it.kind === 'tool' || it.kind === 'subagent') it.inputJson = (it.inputJson ?? '') + e.text;
      else it.text += e.text;
      return;
    }
    case 'item.update': {
      const it = findItem(state.turns, e.id);
      if (!it) return;
      const { type: _t, seq: _s, at: _a, id: _i, agent, ...rest } = e;
      Object.assign(it, rest);
      if (agent) it.agent = foldAgent(it.agent, agent);
      return;
    }
    case 'item.done': {
      const it = findItem(state.turns, e.id);
      if (!it) return;
      it.status = e.status ?? 'ok';
      it.doneAt = e.at;
      if (e.output != null) it.output = e.output;
      if (e.exitCode != null) it.exitCode = e.exitCode;
      if (e.error) it.error = e.error;
      if (e.changes) it.changes = e.changes;
      if (e.result !== undefined) it.result = e.result;
      return;
    }
    case 'permission.request':
      if (!state.pending.some((p) => p.requestId === e.requestId)) {
        const { type: _t, ...rest } = e;
        state.pending.push(rest as Permission);
      }
      return;
    case 'permission.resolved':
      state.pending = state.pending.filter((p) => p.requestId !== e.requestId);
      return;
    case 'turn.accept': {
      // A queued ticket steered into the live turn: it is a transcript
      // bubble now, not a queue row.
      const turn = state.turns.find((t) => t.id === e.turnId);
      if (turn) turn.queued = false;
      return;
    }
    case 'turn.done': {
      const turn = turnFor(state.turns, e.turnId);
      // An older daemon closed withdrawn and stop-cleared tickets with an
      // interrupted turn.done on the `local-` turn. The message was never
      // sent, so the bubble is removed rather than rendered as stopped -
      // turn.remove is the shape a current daemon sends for the same thing.
      if (turn && turn.id === e.turnId && turn.id.startsWith('local-')
        && e.status === 'interrupted'
        && /^(?:withdrawn|stopped) before it was sent$/i.test(e.error ?? '')) {
        state.turns = state.turns.filter((t) => t.id !== e.turnId);
        return;
      }
      if (turn) {
        // The turn's error is usually the same sentence an `error` event
        // already put in the transcript ("Not logged in - run /login"), and
        // printing it twice reads like two things went wrong. Keep the item,
        // which sits where it happened, and let the footer say only that the
        // turn failed.
        const shown = turn.items.some((it) => it.kind === 'error' && it.text === e.error);
        turn.done = {
          status: e.status, costUsd: e.costUsd, durationMs: e.durationMs,
          error: shown ? undefined : e.error, usage: e.usage,
        };
      }
      // Anything still streaming in this turn is over too.
      for (const it of turn?.items ?? []) if (it.status === 'streaming') { it.status = e.status === 'interrupted' ? 'ok' : it.status === 'streaming' ? 'ok' : it.status; it.doneAt ??= e.at; }
      return;
    }
    case 'turn.remove':
      state.turns = state.turns.filter((turn) => turn.id !== e.turnId);
      return;
    case 'status':
      state.status = e.status;
      return;
    case 'limits':
      state.limits = { ...(state.limits ?? {}), ...e };
      return;
    case 'error': {
      const turn = state.turns[state.turns.length - 1];
      const item: Item = { id: `err-${e.seq}`, kind: 'error', text: e.message ?? 'error', status: 'error', startedAt: e.at };
      if (turn && !turn.done) turn.items.push(item);
      else state.turns.push({ id: `sys-${e.seq}`, text: '', at: e.at, items: [item], done: { status: 'error' } });
      return;
    }
    default:
      return;
  }
}
