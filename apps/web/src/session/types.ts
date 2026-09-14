/**
 * The conversation as the app sees it, reduced from helm's session events.
 *
 * A driver turns an agent's own protocol into a small vocabulary of events
 * (see packages/connect/src/drivers/index.js); this is the state those
 * events build: turns of items, and the prompts still waiting on a person.
 */

export interface HelmEvent { seq: number; at: number; type: string; [k: string]: any }

export type ItemKind = 'text' | 'thinking' | 'tool' | 'command' | 'edit' | 'error';
export type ItemStatus = 'streaming' | 'ok' | 'error' | 'declined';

export interface Change { path: string; kind: string; diff: string }

export interface Item {
  id: string;
  kind: ItemKind;
  turnId?: string;
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

export interface TurnEnd { status: 'ok' | 'interrupted' | 'error'; costUsd?: number; durationMs?: number; error?: string }

export interface Turn {
  id: string;
  text: string;
  at: number;
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
    case 'turn.start':
      state.turns.push({ id: e.turnId ?? String(e.seq), text: e.text ?? '', at: e.at, items: [] });
      return;
    case 'item.start': {
      const turn = turnFor(state.turns, e.turnId);
      if (!turn) return;
      if (turn.items.some((x) => x.id === e.id)) return;
      turn.items.push({
        id: e.id, kind: e.kind, turnId: e.turnId, text: '', status: 'streaming', startedAt: e.at,
        name: e.name, input: e.input, command: e.command, cwd: e.cwd, changes: e.changes,
      });
      return;
    }
    case 'item.delta': {
      const it = findItem(state.turns, e.id);
      if (!it) return;
      if (it.kind === 'tool') it.inputJson = (it.inputJson ?? '') + e.text;
      else it.text += e.text;
      return;
    }
    case 'item.update': {
      const it = findItem(state.turns, e.id);
      if (!it) return;
      const { type: _t, seq: _s, at: _a, id: _i, ...rest } = e;
      Object.assign(it, rest);
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
        const { type: _t, at: _a, ...rest } = e;
        state.pending.push(rest as Permission);
      }
      return;
    case 'permission.resolved':
      state.pending = state.pending.filter((p) => p.requestId !== e.requestId);
      return;
    case 'turn.done': {
      const turn = turnFor(state.turns, e.turnId);
      if (turn) {
        // The turn's error is usually the same sentence an `error` event
        // already put in the transcript ("Not logged in - run /login"), and
        // printing it twice reads like two things went wrong. Keep the item,
        // which sits where it happened, and let the footer say only that the
        // turn failed.
        const shown = turn.items.some((it) => it.kind === 'error' && it.text === e.error);
        turn.done = {
          status: e.status, costUsd: e.costUsd, durationMs: e.durationMs,
          error: shown ? undefined : e.error,
        };
      }
      // Anything still streaming in this turn is over too.
      for (const it of turn?.items ?? []) if (it.status === 'streaming') { it.status = e.status === 'interrupted' ? 'ok' : it.status === 'streaming' ? 'ok' : it.status; it.doneAt ??= e.at; }
      return;
    }
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
