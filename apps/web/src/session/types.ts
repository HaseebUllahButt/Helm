/**
 * The conversation as the app sees it, reduced from helm's session events.
 *
 * A driver turns an agent's own protocol into a small vocabulary of events
 * (see packages/connect/src/drivers/index.js); this is the state those
 * events build: turns of items, and the prompts still waiting on a person.
 */

export interface HelmEvent { seq: number; at: number; type: string; [k: string]: any }

export type ItemKind = 'text' | 'thinking' | 'tool' | 'command' | 'edit' | 'subagent' | 'error' | 'visual';
/**
 * A saved page. `placement: 'canvas'` asks for it beside the chat; `url`
 * makes it a live page whose saved snapshot is only a link to it.
 */
export interface Visual { ref: string; title: string; height: number; bytes: number; placement?: 'canvas'; url?: string }
export type ItemStatus = 'streaming' | 'ok' | 'error' | 'declined';

export interface Change { path: string; kind: string; diff: string }

/** What the engine says about a spawned agent, while it runs and when it lands. */
export interface AgentInfo {
  id?: string;
  model?: string;
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

/** A background helper still marked running after its agent stopped would shimmer forever. */
function stopAgents(turns: Turn[], seq: number) {
  for (const turn of turns) for (const it of turn.items) {
    if (it.kind !== 'subagent' || !['running', 'pendingInit', 'working'].includes(it.agent?.status ?? '')) continue;
    it.agent = foldAgent(it.agent, { status: 'stopped' });
    touch(turn, it, seq);
  }
}

/** Any compaction still marked running is over: a newer one has started or ended. */
function closeCompactions(turns: Turn[], at: number, seq: number) {
  for (const turn of turns) for (const it of turn.items) {
    if (it.status !== 'streaming' || it.kind !== 'tool' || (it.name !== 'compact' && it.name !== 'contextCompaction')) continue;
    it.status = 'ok';
    it.doneAt = at;
    touch(turn, it, seq);
  }
}

export interface Item {
  id: string;
  kind: ItemKind;
  turnId?: string;
  /** Set when this item ran inside a subagent: the id of its `subagent` card. */
  parentId?: string;
  /**
   * The event that last changed this item or one inside it. Items change in
   * place, so this is how a drawn step knows it can skip drawing again.
   */
  revision?: number;
  agent?: AgentInfo;
  /** Prose, thinking, or command output as it streams. */
  text: string;
  /** Tools: the name, and the input either parsed or as partial JSON. */
  name?: string;
  input?: any;
  inputJson?: string;
  command?: string;
  /** What the engine says a command does: read, search, listFiles. */
  actions?: { type: string; name?: string; path?: string; query?: string }[];
  cwd?: string;
  changes?: Change[];
  status: ItemStatus;
  output?: string;
  exitCode?: number;
  error?: string;
  elapsed?: number;
  result?: any;
  visual?: Visual;
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
export interface TurnUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; inputIncludesCache?: boolean }

export interface TurnEnd {
  status: 'ok' | 'interrupted' | 'error';
  costUsd?: number;
  durationMs?: number;
  error?: string;
  usage?: TurnUsage;
}

export interface Turn {
  checkpoint?: string;
  id: string;
  /** Last event that changed this turn; items are mutated while streaming. */
  revision?: number;
  text: string;
  at: number;
  /** Still in helm's outbox: accepted, but the agent has not seen it yet. */
  queued?: boolean;
  /** How it was asked to go: `queue` waits for the task to finish. */
  delivery?: 'auto' | 'queue' | 'steer';
  references?: string[];
  /** Handed to the CLI mid-turn: it can no longer be withdrawn. */
  delivered?: boolean;
  /** Used by the CLI inside a running turn; it lives at a seam in that turn. */
  steered?: boolean;
  /** Answered by helm itself - complete on arrival, never a live turn. */
  local?: boolean;
  /** The agent began it by itself, after this background work ended. */
  cause?: { summary: string; status: string }[];
  /**
   * The turn still running when this one landed, and how many of its items
   * existed then: the chat renders this turn at that seam, so the running
   * turn's later output flows below the answer instead of over it.
   */
  insideOf?: string;
  insideAt?: number;
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
  /** Copied-in turns left off screen; their replies go with them. */
  hidden?: Set<string>;
}

export const emptyLog = (): LogState => ({ turns: [], pending: [], status: 'idle', last: 0, loaded: false });

// ------------------------------------------------------------------ reduce

/** Marks an item, the subagent cards it sits inside, and its turn as changed. */
function touch(turn: Turn, item: Item, seq: number) {
  turn.revision = seq;
  let it: Item | undefined = item;
  for (let hops = 0; it && hops <= turn.items.length; hops++) {
    it.revision = seq;
    const parent: string | undefined = it.parentId;
    it = parent ? turn.items.find((x) => x.id === parent) : undefined;
  }
}

const findItem = (turns: Turn[], id: string, revision: number): Item | undefined => {
  for (let i = turns.length - 1; i >= 0; i--) {
    const it = turns[i].items.find((x) => x.id === id);
    if (it) { touch(turns[i], it, revision); return it; }
  }
  return undefined;
};

/** What Codex sends ahead of the owner's words and stores as a user message. */
const CODEX_CONTEXT = /^(?:<environment_context>|<user_instructions>|<permissions instructions>|<skills_instructions>|# AGENTS\.md instructions for )/;

/**
 * A turn copied in from the CLI's own file that is not a message to show:
 * Codex's instructions, or a copy of a message still being answered live
 * (older daemons copied a chat's file in while showing it live, leaving the
 * message twice and the live reply above the copy).
 */
const hiddenCopy = (turns: Turn[], e: HelmEvent): boolean => {
  if (!e.imported) return false;
  const text = String(e.text ?? '').trim();
  if (CODEX_CONTEXT.test(text)) return true;
  return !!text && turns.some((t) => !t.done && !t.queued && t.text.trim() === text);
};

const turnFor = (turns: Turn[], turnId?: string): Turn | undefined =>
  (turnId && turns.find((t) => t.id === turnId)) || turns[turns.length - 1];

/**
 * The last turn still open that a helm-answered turn can land inside -
 * never a queued ticket (that is a composer row, not a stream), never
 * another local answer (it is already done), never the turn itself.
 */
const hostFor = (turns: Turn[], target?: Turn): Turn | undefined => {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t === target || t.done || t.local || t.queued || t.steered) continue;
    return t;
  }
  return undefined;
};

/**
 * Apply one event. Mutates in place for speed - deltas arrive many times a
 * second - and the hook clones the top-level object to re-render.
 */
export function apply(state: LogState, e: HelmEvent): void {
  if (e.seq <= state.last) return;
  state.last = e.seq;
  switch (e.type) {
    case 'history.reset': {
      Object.assign(state, emptyLog(), { last: e.seq, loaded: true, status: 'idle' });
      return;
    }
    case 'turn.checkpoint': {
      const turn = state.turns.find(t => t.id === e.turnId);
      if (turn) { turn.checkpoint = e.checkpoint; turn.revision = e.seq; }
      return;
    }
    case 'turn.start': {
      const id = e.turnId ?? String(e.seq);
      if (hiddenCopy(state.turns, e)) { (state.hidden ??= new Set()).add(id); return; }
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
      // Claude echoes a command in its own markup; it is matched as typed.
      const echo = commandText(e.text ?? '').trim();
      let open: Turn | undefined;
      // A turn the agent began by itself echoes nothing the owner sent, and
      // helm's own ticket is a message of its own: two identical waiting
      // messages are two rows, not one.
      for (let i = 0; !e.wake && !id.startsWith('local-') && i < state.turns.length; i++) {
        const t = state.turns[i];
        if (t.items.length || t.done || t.steered) continue;
        // An echo that names its message is that message, whatever it says.
        if (e.inputId != null) { if (t.id === e.inputId) { open = t; break; } continue; }
        if (!t.id.startsWith('local-')) continue;
        // Compared trimmed: helm strips the trailing newline off what it
        // sends, and the CLI echoes the prompt back with it still attached.
        // A prefix match covers the one case where the text sent and the
        // text echoed differ on purpose: an agent that cannot see images
        // gets their names appended before the send.
        const mine = t.text.trim();
        if (mine === echo || (mine && echo.startsWith(mine + '\n'))) { open = t; break; }
      }
      // A helm-answered turn is complete on arrival. If another turn is
      // still streaming, appending it would put every later item of that
      // turn *above* the answer - pinning it at the bottom while work piles
      // up over it. Record the open turn it landed inside and how much of
      // it existed, so the chat can host it at that seam instead.
      const host = e.local ? hostFor(state.turns, open) : undefined;
      if (open) {
        open.revision = e.seq;
        open.id = id;
        open.queued = false;
        open.checkpoint = e.checkpoint ?? open.checkpoint;
        if (e.local) {
          open.local = true;
          open.insideOf = host?.id;
          open.insideAt = host?.items.length;
        }
        return;
      }
      const turn: Turn = { id, revision: e.seq, text: e.text ?? '', at: e.at, items: [], attachments: e.attachments ?? [], queued: e.queued === true, delivery: e.delivery, references: e.references, checkpoint: e.checkpoint };
      if (Array.isArray(e.cause) && e.cause.length) turn.cause = e.cause;
      if (e.local) {
        turn.local = true;
        turn.insideOf = host?.id;
        turn.insideAt = host?.items.length;
      }
      state.turns.push(turn);
      return;
    }
    case 'item.start': {
      if (state.hidden?.has(e.turnId)) return;
      const turn = turnFor(state.turns, e.turnId);
      if (!turn) return;
      if (turn.items.some((x) => x.id === e.id)) return;
      turn.revision = e.seq;
      // One compaction runs at a time. A restart of helm mid-compaction left
      // the old marker open, spinning on after the new one finished.
      if (e.kind === 'tool' && (e.name === 'compact' || e.name === 'contextCompaction')) closeCompactions(state.turns, e.at, e.seq);
      const item: Item = {
        id: e.id, kind: e.kind, turnId: e.turnId, text: '', status: 'streaming', startedAt: e.at,
        name: e.name, input: e.input, command: e.command, actions: e.actions, cwd: e.cwd, changes: e.changes,
        parentId: e.parentId, agent: e.agent, visual: e.visual,
      };
      turn.items.push(item);
      touch(turn, item, e.seq);
      return;
    }
    case 'item.delta': {
      const it = findItem(state.turns, e.id, e.seq);
      if (!it) return;
      if (it.kind === 'tool' || it.kind === 'subagent') it.inputJson = (it.inputJson ?? '') + e.text;
      else it.text += e.text;
      return;
    }
    case 'item.update': {
      const it = findItem(state.turns, e.id, e.seq);
      if (!it) return;
      const { type: _t, seq: _s, at: _a, id: _i, agent, ...rest } = e;
      Object.assign(it, rest);
      if (agent) it.agent = foldAgent(it.agent, agent);
      return;
    }
    case 'item.done': {
      const it = findItem(state.turns, e.id, e.seq);
      if (!it) return;
      it.status = e.status ?? 'ok';
      it.doneAt = e.at;
      if (e.output != null) it.output = e.output;
      if (e.exitCode != null) it.exitCode = e.exitCode;
      if (e.error) it.error = e.error;
      if (e.changes) it.changes = e.changes;
      if (e.result !== undefined) it.result = e.result;
      if (it.kind === 'tool' && (it.name === 'compact' || it.name === 'contextCompaction')) closeCompactions(state.turns, e.at, e.seq);
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
    case 'turn.deliver': {
      const turn = state.turns.find((t) => t.id === e.turnId);
      if (turn) { turn.delivered = true; turn.revision = e.seq; }
      return;
    }
    case 'turn.edit': {
      const turn = state.turns.find((entry) => entry.id === e.turnId);
      if (turn?.queued && !turn.delivered) {
        turn.text = e.text;
        if (e.attachments) turn.attachments = e.attachments;
        turn.revision = e.seq;
      }
      return;
    }
    case 'turn.images': {
      const turn = state.turns.find((entry) => entry.id === e.turnId);
      if (turn) {
        turn.text = e.text ?? turn.text;
        turn.attachments = e.attachments ?? turn.attachments;
        turn.revision = e.seq;
      }
      return;
    }
    case 'turn.accept': {
      // The CLI used a message typed mid-turn: it is a transcript bubble
      // now, not a queue row, at the point the turn had reached - the rest
      // of the turn's work flows below it, the way it does in the CLI.
      const turn = state.turns.find((t) => t.id === e.turnId);
      if (!turn) return;
      turn.revision = e.seq;
      turn.queued = false;
      turn.steered = true;
      const host = hostFor(state.turns, turn);
      if (host && !turn.insideOf) {
        turn.insideOf = host.id;
        turn.insideAt = host.items.length;
      }
      return;
    }
    case 'turn.done': {
      // helm closes its own ticket for a message the agent already took up
      // under an id of its own. That ticket is gone; falling back to the
      // last turn marked the reply still running as finished, and a message
      // typed into it then had no turn to sit inside and stuck to the bottom.
      if (e.turnId?.startsWith('local-') && !state.turns.some((t) => t.id === e.turnId)) return;
      if (state.hidden?.has(e.turnId)) return;
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
        turn.revision = e.seq;
        // The turn's error is usually the same sentence an `error` event
        // already put in the transcript ("Not logged in - run /login"), and
        // printing it twice reads like two things went wrong. Keep the item,
        // which sits where it happened, and let the footer say only that the
        // turn failed.
        const shown = turn.items.some((it) => it.kind === 'error' && it.text === e.error);
        // A waiting message that failed - refused by the CLI, or lost when
        // it exited - leaves the queue for the transcript, where its error
        // and a resend can be seen, instead of vanishing from both.
        if (e.status !== 'ok' && turn.id === e.turnId) turn.queued = false;
        turn.done = {
          status: e.status, costUsd: e.costUsd, durationMs: e.durationMs,
          error: shown ? undefined : e.error, usage: e.usage,
        };
      }
      // Anything still streaming in this turn is over too.
      for (const it of turn?.items ?? []) if (it.status === 'streaming') { it.status = e.status === 'interrupted' ? 'ok' : it.status === 'streaming' ? 'ok' : it.status; it.doneAt ??= e.at; touch(turn!, it, e.seq); }
      // A stop ends the agent's background helpers with it.
      if (e.status === 'interrupted') stopAgents(state.turns, e.seq);
      return;
    }
    case 'turn.remove':
      state.turns = state.turns.filter((turn) => turn.id !== e.turnId);
      return;
    case 'status':
      state.status = e.status;
      // The process is gone, and every helper it was running went with it.
      if (e.status === 'exited') stopAgents(state.turns, e.seq);
      return;
    case 'limits':
      state.limits = { ...(state.limits ?? {}), ...e };
      return;
    case 'error': {
      const turn = state.turns[state.turns.length - 1];
      const item: Item = { id: `err-${e.seq}`, kind: 'error', text: e.message ?? 'error', status: 'error', startedAt: e.at };
      if (turn && !turn.done) { turn.items.push(item); turn.revision = e.seq; }
      else state.turns.push({ id: `sys-${e.seq}`, revision: e.seq, text: '', at: e.at, items: [item], done: { status: 'error' } });
      return;
    }
    default:
      return;
  }
}

/**
 * A command as typed ("/rpc-action-items for today"), from Claude's record of
 * it. A skill run as a command opens with <command-message>, a built-in one
 * with <command-name>. Anything else comes back as it was.
 */
export function commandText(text: string): string {
  const command = text.match(/^\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>\s*([^<]*?)\s*<\/command-name>/);
  if (!command) return text;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim();
  return args ? `${command[1]} ${args}` : command[1];
}
