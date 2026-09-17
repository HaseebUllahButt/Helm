import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELM_DIR } from './paths.js';

/**
 * What a brain knows.
 *
 * A brain is one agent for a whole network rather than one per folder - one
 * per machine, living on the machine it acts from - so the first question it
 * raises is the one nobody has a good answer to: how do
 * you give an agent "everything that is going on" without handing it every
 * transcript on every machine? A busy laptop here holds 182 threads. Pasting
 * even their tails into a prompt is both ruinous and useless.
 *
 * The answer is three layers, and only the first one is context:
 *
 *   1. A digest. One line per session - machine, folder, engine, title,
 *      status, cost, and what it last did - refreshed in the background and
 *      prepended to what the owner types. A hundred threads is a couple of
 *      thousand tokens, so the brain knows the shape of the network without
 *      being asked and without a tool call.
 *   2. Depth on request. `helm thread <id>` reads a conversation's tail,
 *      `helm digest --json` the whole thing structurally. The brain pulls
 *      what the digest made it curious about.
 *   3. Its hands: `helm say`, `helm spawn`. Same CLI, so the agent's own
 *      Bash tool is the only integration - which is why this works the same
 *      on Claude Code, Codex, opencode and Devin, and why the permission
 *      card you already answer on your phone is the brain's guardrail too.
 *
 * The line per session is derived, never generated: no model is called to
 * summarise anything. `lastLine` reads the tail of the event log a session
 * already writes. A digest costs one cheap RPC per machine.
 *
 * Offline machines stay in the digest from `snapshot.json`, marked with when
 * they were last seen. A brain that silently omits a sleeping laptop does not
 * have a gap in its knowledge, it has a wrong answer - it will tell you
 * nothing is running there.
 */

const SNAPSHOT = join(HELM_DIR, 'snapshot.json');

/**
 * Enough of a session id to say which one, short enough to type.
 *
 * The two prefixed kinds need care. `found:<engine>:<id>` carries the engine
 * in the middle, so stripping one prefix and taking six characters names the
 * engine rather than the thread - every Claude row in a machine's history
 * would come out as "claude". A pane id is already both short and meaningful,
 * so it is kept whole.
 */
export const shortId = (id) => {
  const s = String(id);
  if (s.startsWith('found:')) return s.split(':').slice(2).join(':').slice(0, 6);
  if (s.startsWith('pane:')) return s.slice(5);
  return s.slice(0, 6);
};

const oneLine = (s, n = 90) => {
  const line = String(s ?? '').split('\n').map((x) => x.trim()).find(Boolean) ?? '';
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
};

export function ago(at, now = Date.now()) {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/**
 * Rebuild the items of a conversation from its event log.
 *
 * Events are flat and incremental - an `item.start` names a tool while its
 * arguments arrive as `item.delta` and land as `item.update`, and a whole
 * sentence from the model arrives as nothing but deltas - so nothing useful
 * can be read off any single event. Both readers below fold first, then look.
 */
export function fold(events = []) {
  const items = new Map();
  const turns = [];
  let pending = null;
  for (const e of events) {
    switch (e.type) {
      case 'turn.start':
        turns.push({ turnId: e.turnId, text: e.text ?? '', items: [], status: null, costUsd: null });
        break;
      case 'item.start': {
        const item = { id: e.id, kind: e.kind, name: e.name ?? null, text: '', input: e.input ?? null, status: null };
        items.set(e.id, item);
        if (!turns.length) turns.push({ turnId: e.turnId, text: '', items: [], status: null, costUsd: null });
        turns[turns.length - 1].items.push(item);
        break;
      }
      case 'item.delta': {
        const item = items.get(e.id);
        // A tool's arguments stream as deltas too, but `item.update` delivers
        // them parsed - so only text is worth accumulating here.
        if (item && (item.kind === 'text' || item.kind === 'thinking')) item.text += e.text ?? '';
        break;
      }
      case 'item.update': {
        const item = items.get(e.id);
        if (item && e.input) item.input = e.input;
        break;
      }
      case 'item.done': {
        const item = items.get(e.id);
        if (item) { item.status = e.status; item.output = e.output; item.error = e.error; }
        break;
      }
      case 'permission.request':
        pending = e;
        break;
      case 'permission.resolved':
        if (pending?.requestId === e.requestId) pending = null;
        break;
      case 'turn.done': {
        const turn = turns.find((t) => t.turnId === e.turnId) ?? turns[turns.length - 1];
        if (turn) { turn.status = e.status; turn.costUsd = e.costUsd ?? null; }
        break;
      }
      default:
        break;
    }
  }
  return { items, turns, pending };
}

/** A tool as it reads in a list: `Read(README.md)` rather than `Read`. */
export function toolLabel(item) {
  const name = item.name || item.kind || 'tool';
  const input = item.input && typeof item.input === 'object' ? item.input : null;
  const arg = input
    ? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description
    : null;
  return arg ? `${name}(${oneLine(String(arg), 60)})` : String(name);
}

/**
 * What a driven session is doing, for its one line in the digest.
 *
 * Ordered by what the owner would want to know first: a session waiting on a
 * person is the only thing in the digest that needs anything, so what it is
 * waiting for outranks whatever it was saying beforehand. Then the tool still
 * running, then the last thing it actually said.
 */
export function lastLine(events = []) {
  const { turns, pending } = fold(events.slice(-400));
  if (pending) return `waiting: ${oneLine(pending.title || pending.detail || pending.tool || 'a permission')}`;

  const items = turns.flatMap((t) => t.items);
  const running = [...items].reverse()
    .find((i) => i.status === null && i.kind !== 'text' && i.kind !== 'thinking');
  if (running) return `running: ${toolLabel(running)}`;

  const said = [...items].reverse().find((i) => i.kind === 'text' && i.text.trim());
  if (said) return oneLine(said.text);

  const failed = [...items].reverse().find((i) => i.status === 'error');
  if (failed) return `failed: ${oneLine(failed.error || failed.output || toolLabel(failed))}`;

  const last = turns[turns.length - 1];
  return last?.text ? `asked: ${oneLine(last.text)}` : null;
}

/**
 * A conversation as lines, for `helm thread`.
 *
 * The brain reads this with its eyes rather than a parser, so it is prose and
 * tool calls instead of JSON - and it is folded, so a sentence that arrived as
 * forty deltas is one line rather than forty.
 */
export function readThread(events = [], { limit = 40 } = {}) {
  const { turns, pending } = fold(events);
  const out = [];
  for (const t of turns) {
    if (t.text) out.push(`> ${oneLine(t.text, 400)}`);
    for (const i of t.items) {
      if (i.kind === 'text' || i.kind === 'thinking') {
        if (i.text.trim()) out.push(`  ${oneLine(i.text, 400)}`);
      } else {
        const mark = i.status === 'error' ? '!' : i.status === 'declined' ? 'x' : i.status ? '·' : '…';
        out.push(`  ${mark} ${toolLabel(i)}`);
        if (i.status === 'error' && i.error) out.push(`      ${oneLine(i.error, 200)}`);
      }
    }
    if (t.status && t.status !== 'ok') out.push(`  (${t.status})`);
    else if (t.costUsd) out.push(`  ($${Number(t.costUsd).toFixed(2)})`);
  }
  if (pending) out.push(`  ? asks: ${oneLine(pending.title || pending.detail || 'a permission')}`);
  return out.slice(-Math.max(1, limit));
}

/**
 * This machine's own contribution to the digest: its session list, plus the
 * derived line for each driven session. Archived threads are left out - the
 * owner filed them away, and the brain should not bring them back up.
 */
export function localDigest(sessions, events) {
  return sessions
    .filter((s) => !s.archived && s.status !== 'exited')
    .map((s) => {
      let last = null;
      // `since` returns the events themselves, not a wrapper around them.
      // This read used to be wrong and wrapped in a catch that said nothing,
      // so every digest line was silently blank - which looked exactly like
      // "nothing has happened in that session" and is why the test below
      // uses a real EventLog rather than a stand-in that agrees with me.
      if (!String(s.id).startsWith('pane:') && !String(s.id).startsWith('found:')) {
        // The tail, raw: `lastLine` reads the last few hundred events and
        // nothing else, so hydrating every attachment in a long thread - on
        // every digest, for every session - bought nothing.
        try { last = lastLine(events.tail?.(s.id, 400) ?? events.since(s.id, 0) ?? []); } catch { last = null; }
      }
      return {
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        engine: s.engine,
        model: s.model ?? null,
        status: s.status,
        adopted: !!s.adopted,
        costUsd: s.costUsd ?? null,
        updatedAt: s.updatedAt ?? null,
        pending: s.pending ?? 0,
        last,
      };
    });
}

// ------------------------------------------------------------------ snapshot

/**
 * The last thing every machine said about itself, kept on disk so a machine
 * that is asleep still appears - dimmed and dated, rather than missing.
 */
export function readSnapshot(file = SNAPSHOT) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { machines: {} }; }
}

export function writeSnapshot(snap, file = SNAPSHOT) {
  mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(snap, null, 2), { mode: 0o600 });
  return snap;
}

/**
 * Merge what answered now with what was remembered, so the result covers
 * every machine in the roster whether or not it is up.
 */
export function mergeSnapshot(previous, fresh, now = Date.now()) {
  const machines = { ...(previous?.machines ?? {}) };
  for (const [id, entry] of Object.entries(fresh)) {
    machines[id] = { ...entry, at: now };
  }
  return { at: now, machines };
}

// -------------------------------------------------------------------- render

const STATUS = { blocked: 'NEEDS YOU', working: 'working', idle: 'idle', shell: 'terminal', unknown: 'idle' };
const money = (n) => (typeof n === 'number' && n > 0 ? `$${n.toFixed(2)}` : '');
const collapse = (p) => String(p ?? '').replace(/^\/home\/[^/]+/, '~');

/**
 * The digest as the brain reads it. Deliberately plain text and deliberately
 * short: this is prepended to what the owner types, so every line has to earn
 * a place in every message.
 */
export function render(snap, { roster = {}, now = Date.now(), limit = 12 } = {}) {
  const out = [];
  const ids = Object.keys({ ...roster, ...(snap?.machines ?? {}) });
  if (!ids.length) return 'No machines in this network yet.';

  let blocked = 0;
  for (const id of ids) {
    const entry = snap?.machines?.[id];
    const name = roster[id]?.name ?? entry?.name ?? id.slice(0, 6);
    const online = !!roster[id]?.online;
    const sessions = entry?.sessions ?? [];
    const when = online ? '' : ` · last seen ${ago(entry?.at, now)}`;
    out.push(`${name} (${online ? 'online' : 'offline'}${when})`);
    if (!sessions.length) { out.push('  nothing running'); continue; }

    const byFolder = new Map();
    for (const s of sessions) {
      const key = collapse(s.cwd || '~');
      if (!byFolder.has(key)) byFolder.set(key, []);
      byFolder.get(key).push(s);
    }
    for (const [cwd, list] of byFolder) {
      out.push(`  ${cwd}`);
      for (const s of list.slice(0, limit)) {
        if (s.status === 'blocked') blocked += 1;
        const bits = [
          shortId(s.id).padEnd(6),
          (STATUS[s.status] ?? s.status).padEnd(9),
          s.engine,
          s.model ? `(${s.model})` : '',
          JSON.stringify(oneLine(s.title, 60)),
          money(s.costUsd),
          ago(s.updatedAt, now),
          s.adopted ? '[not started by helm]' : '',
        ].filter(Boolean);
        out.push(`    ${bits.join(' ')}`);
        if (s.last) out.push(`           ${s.last}`);
      }
      if (list.length > limit) out.push(`    … ${list.length - limit} more in this folder`);
    }
  }
  const head = blocked
    ? `${blocked} session${blocked === 1 ? '' : 's'} waiting on you.`
    : 'Nothing is waiting on you.';
  return `${head}\n\n${out.join('\n')}`;
}

/**
 * One line of "how is the network right now", prepended to what the owner
 * sends the brain.
 *
 * The whole digest is not prepended, and that is the point. It would put a
 * screenful of machine state in front of every message the owner typed - in
 * the transcript they read as well as in the model's context - and most turns
 * do not need it. A line is enough to tell the brain whether the picture is
 * worth fetching; `helm digest` fetches it. Small always, complete on demand.
 */
export function summaryLine(snap, { roster = {}, now = Date.now() } = {}) {
  const ids = Object.keys({ ...roster, ...(snap?.machines ?? {}) });
  let blocked = 0, working = 0, offline = 0;
  for (const id of ids) {
    if (!roster[id]?.online) offline += 1;
    for (const s of snap?.machines?.[id]?.sessions ?? []) {
      if (s.status === 'blocked') blocked += 1;
      else if (s.status === 'working') working += 1;
    }
  }
  const when = new Date(now).toISOString().replace('T', ' ').slice(0, 16);
  const bits = [
    `${ids.length} machine${ids.length === 1 ? '' : 's'}${offline ? `, ${offline} offline` : ''}`,
    blocked ? `${blocked} waiting on you` : null,
    working ? `${working} working` : null,
  ].filter(Boolean);
  return `[helm ${when} · ${bits.join(' · ')}]`;
}

/**
 * What a brain is told once, when its thread is opened.
 *
 * It is a first user message rather than a system prompt because helm drives
 * four different CLIs and only some of them take one - and because a message
 * survives `--resume`, so the brain still knows what it is after a restart.
 */
export function brief(name) {
  return `You are a brain of a helm network: an agent with a view of every machine in it, rather than one agent per folder. Each machine in the network can have one of these, and you are ${name}'s.

You are running on ${name}. Your tools for the network are the \`helm\` CLI, through your shell:

  helm digest              every machine, folder, and running session, with what each last did
  helm digest --json       the same, structurally
  helm thread <id>         the recent conversation of one session (-n for more lines)
  helm say <id> <text>     send a prompt into an existing session
  helm spawn <machine> <folder> <account> <text>   start a new session and prompt it
  helm machines            the roster

Session ids are the short ids \`helm digest\` prints. Ordinary shell commands run on ${name}; to do something on another machine, spawn or talk to a session there.

Every message from the owner is prefixed with a one-line status. Run \`helm digest\` when that line, or the question, suggests you need the detail - do not guess at what is running.

You act on this network. Prefer doing the thing over describing it, say plainly what you did, and ask before anything destructive.`;
}

// ------------------------------------------------------------------ its hands

/**
 * A `helm` on the brain's PATH that is the one running it.
 *
 * The brain's abilities are whatever the `helm` it can reach supports, and
 * the `helm` on a machine's PATH is the installed one - which is behind the
 * daemon whenever a deploy has not happened yet. Driven for real the first
 * time, that showed up as the brain reporting `unknown command "digest"` and
 * then trying to work around it with `helm status`, which is a confusing way
 * to learn that a machine is out of date.
 *
 * So the brain gets its own: a one-line shim, written next to the network
 * key, that runs this daemon's own CLI with this daemon's own node. It cannot
 * be out of step with the code that wrote it.
 */
export function ensureShim(dir = join(HELM_DIR, 'bin')) {
  const cli = fileURLToPath(new URL('../bin/helm.js', import.meta.url));
  const shim = join(dir, 'helm');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o700 });
  return dir;
}

/** That shim in front of whatever else the machine has. */
export function pathWithShim(path = process.env.PATH ?? '') {
  return `${ensureShim()}:${path}`;
}
