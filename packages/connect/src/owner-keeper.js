/**
 * The keeper: keeps the owner's preferences (protocol/owner.js) fresh from
 * what the owner says in chats.
 *
 * It has to cost little and never surprise, so:
 * - One machine runs it, the same one by every machine's reckoning
 *   (keeperMachine), and at most about once a day, and only when the owner
 *   wrote something in a chat since the last run. "Run now" skips the wait.
 * - It reads only what is new: each machine answers OWNER_WORDS with the
 *   owner's own messages after the seq this keeper last read there (the
 *   index in owner-keeper.json). Agents' words, helpers and Helm's notes are
 *   left out.
 * - A small model writes the new list through Helm's normal helper path, as
 *   a hidden helper: no chat in Running, nothing in the sidebar, deleted when
 *   it answers. It gets no files and no tools - everything it needs is in
 *   the task - and only its reply is used: Helm checks the lines and writes
 *   the list. So the model never touches a project, only the list.
 * - No reasons, tags or dates go in the list; what changed is kept beside it
 *   (`learned`) for the owner to see in Settings.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { M } from '@helm/protocol';
import { stripBrief } from '@helm/protocol/brief';
import { loadOwner, editOwner, cleanLines, MAX_LINE } from '../../protocol/owner.js';
import { HELM_DIR } from './paths.js';
import { modesFor, defaultMode } from './modes.js';

export const KEEPER_FILE = join(HELM_DIR, 'owner-keeper.json');
export const KEEPER_DIR = join(HELM_DIR, 'keeper');
/** About once a day: a little less, so a daily check does not slip an hour each day. */
export const KEEP_EVERY_MS = 20 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
/** The list the keeper keeps: short, because it rides along in every chat. */
export const KEEP_LINES = 12;
// What the model reads, at most. Newest first wins when a busy day has more.
const MAX_MESSAGE = 600;
const MAX_INPUT = 24_000;
const PER_MACHINE = 400;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The machine that runs the keeper: the network's home (a vm), else the
 * oldest machine. Every machine works this out from the same roster, so
 * exactly one of them thinks it is the keeper.
 */
export function keeperMachine(net) {
  const all = Object.values(net?.machines ?? {}).filter((m) => m?.id && !net.revoked?.[m.id]);
  const order = (a, b) => (a.kind === 'vm' ? 0 : 1) - (b.kind === 'vm' ? 0 : 1)
    || (a.addedAt ?? a.updatedAt ?? 0) - (b.addedAt ?? b.updatedAt ?? 0) || String(a.id).localeCompare(String(b.id));
  return all.sort(order)[0] ?? null;
}

/**
 * The owner's own words in a message, or null. Helm's notes, agent messages
 * (which arrive as a turn too) and slash commands are not the owner talking.
 */
export function ownerText(raw) {
  const text = stripBrief(String(raw ?? '')).replace(/\s+/g, ' ').trim();
  if (text.length < 6 || /^(\[Helm|<helm|\/)/.test(text)) return null;
  return clip(text, MAX_MESSAGE);
}

/**
 * What the owner wrote on this machine since the keeper last read it.
 *
 * Reads each chat's event file for its `turn.start` lines only, and only for
 * chats that changed since `since`. `read` is chat id -> the last seq the
 * keeper saw; the answer carries the new one even when nothing in between was
 * the owner's, so a busy chat is not read again from the start.
 */
export function ownerWords(sessions, { dir, since = 0, read = {} } = {}) {
  const chats = [];
  for (const s of sessions) {
    if (!s?.driver || s.delegation || s.brain || s.engine === 'shell' || (s.updatedAt ?? 0) <= since) continue;
    let body;
    try { body = readFileSync(join(dir, `${s.id}.jsonl`), 'utf8'); } catch { continue; }
    const after = Number(read?.[s.id]) || 0;
    let last = after;
    const texts = [];
    for (const raw of body.split('\n')) {
      if (!raw.includes('"turn.start"')) continue;
      let e;
      try { e = JSON.parse(raw); } catch { continue; }
      if (e.type !== 'turn.start' || !(e.seq > after)) continue;
      last = Math.max(last, e.seq);
      if ((e.at ?? 0) <= since || e.local || e.wake) continue;
      // A message is logged when sent and again when the CLI echoes it.
      const said = ownerText(e.text);
      if (said && !texts.includes(said)) texts.push(said);
    }
    if (last > after) chats.push({ id: s.id, title: clip(String(s.title ?? ''), 80), last, texts: texts.slice(-40) });
  }
  return { chats };
}

/** What the small model is asked. Everything it may use is in here. */
export function keeperTask(lines, chats) {
  const messages = [];
  let size = 0;
  // Newest chats first into the budget, then shown oldest first.
  for (const chat of [...chats].reverse()) {
    for (const text of [...chat.texts].reverse()) {
      const entry = `[${chat.title || 'chat'}] ${text}`;
      if (size + entry.length > MAX_INPUT) break;
      size += entry.length;
      messages.unshift(entry);
    }
  }
  return [
    'You keep a short list of the owner\'s lasting preferences: how they want agents to talk to them and how they like work done. Helm gives this list to every agent on every machine.',
    '',
    'Current list:',
    ...(lines.length ? lines.map((l) => `- ${l}`) : ['(empty)']),
    '',
    'Messages the owner wrote in chats since the list was last updated:',
    ...messages,
    '',
    'Decide whether these messages hold a lasting rule that the list does not have yet. A lasting rule is what the owner wants from agents in general, in any project. The owner often says one with "always", "never", "from now on", "remember", "again" or "I keep telling you".',
    '- For each lasting rule the list does not have, add one short line. When a rule changes an existing line, rewrite that line instead. Merge lines that say the same thing.',
    '- Leave out the task at hand, facts about one project, file and machine names, and anything secret or personal: passwords, keys, tokens, addresses, account details.',
    `- At most ${KEEP_LINES} short lines. No reasons, tags, dates or notes.`,
    '- Do not use any tools, and do not read or change any file. Answer from this message alone.',
    '',
    'Examples:',
    '"Never deploy on a Friday, I keep saying this" adds the line "- Never deploy on a Friday."',
    '"Fix the login bug on the settings page" changes nothing: it is a task, not a rule.',
    '',
    'If there is no new lasting rule, reply with exactly: NO CHANGE',
    'Otherwise reply with the whole new list and nothing else: one line per item, each starting with "- ".',
  ].join('\n');
}

// Shapes a secret takes. A line holding one is dropped, never kept "masked".
const SECRET = /(-----BEGIN|\b(?:sk|pk|ghp|gho|github_pat|xox[abp]|AKIA)[-_][A-Za-z0-9]|\b(?:password|passwd|token|secret|api[ _-]?key)\s*[:=]|[A-Za-z0-9+/_-]{32,})/i;

/**
 * The new list from the model's reply, or null for "leave it as it is".
 * Anything the reply does not hold as list lines is ignored, and an empty
 * list never replaces a real one: a model that lost the thread must not wipe
 * what the owner has.
 */
export function parseKeeperReply(reply, current = []) {
  const text = String(reply ?? '').trim();
  if (!text || /^NO CHANGE\b/i.test(text)) return null;
  const items = text.split('\n').filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l));
  const lines = cleanLines(items).filter((l) => l.length <= MAX_LINE && !SECRET.test(l)).slice(0, KEEP_LINES);
  if (!lines.length) return null;
  const same = lines.length === current.length && lines.every((l, i) => l === current[i]);
  return same ? null : lines;
}

/** The first account here with a small model, Claude and Codex first. */
export function pickKeeperAgent(agents = []) {
  const rank = (e) => { const i = ['claude', 'codex', 'gemini'].indexOf(e); return i < 0 ? 9 : i; };
  const row = agents.filter((a) => a.available && a.cheapModel).sort((a, b) => rank(a.engine) - rank(b.engine))[0];
  if (!row) return null;
  const modes = modesFor(row.engine);
  // Read only where the CLI has it; else asking first, so a tool it should
  // not want would wait (and the run would stop) rather than run.
  const mode = modes.find((m) => ['readonly', 'read'].includes(m.id))?.id
    ?? modes.find((m) => m.short === 'ask')?.id ?? defaultMode(row.engine);
  return { profileId: row.id, model: row.cheapModel, mode, engine: row.engine };
}

/**
 * One question to a hidden helper, and its answer. The helper is deleted
 * whatever happens, so nothing of it stays behind in Helm.
 */
export async function askHidden(sessions, { profileId, model, mode, task, cwd = KEEPER_DIR, timeoutMs = 5 * 60_000, pollMs = 1500 }) {
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const { session } = await sessions.delegate({ id: null, cwd, profileId, model, mode, task, hidden: true });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = sessions.delegationResult(session.id);
      if (r.pending) throw new Error('the model asked to use a tool');
      if (r.complete) {
        if (r.status !== 'done') throw new Error(r.error || `the model stopped (${r.status})`);
        return r.output;
      }
      if (Date.now() > deadline) throw new Error('the model took too long');
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    await sessions.kill(session.id).catch(() => {});
  }
}

export class OwnerKeeper {
  #running = false;

  /**
   * self/name/network: this machine and the roster. words(params) answers
   * OWNER_WORDS here; rpc(env, method, params) reaches another machine.
   * agents() lists this machine's accounts; ask(task) runs the model;
   * changed(record) passes a new list to the other machines.
   */
  constructor({ self, name, network, words, rpc, agents, ask, changed = () => {}, file = KEEPER_FILE, now = Date.now, log = () => {} }) {
    Object.assign(this, { self, name, network, words, rpc, agents, ask, changed, file, now, log });
  }

  #load() {
    if (!existsSync(this.file)) return { read: {} };
    try { const s = JSON.parse(readFileSync(this.file, 'utf8')); return { ...s, read: s.read ?? {} }; } catch { return { read: {} }; }
  }

  #save(state) {
    mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 }); renameSync(temporary, this.file); }
    finally { rmSync(temporary, { force: true }); }
  }

  /** What Settings shows: where it runs, whether it is on, how its last run went. */
  status() {
    const keeper = keeperMachine(this.network());
    const here = keeper?.id === this.self();
    const state = here ? this.#load() : {};
    return {
      machine: keeper?.id ?? null, name: keeper?.name ?? null, here,
      on: loadOwner().keeper !== false, running: here && this.#running,
      ...(here ? { lastRunAt: state.lastRunAt ?? null, result: state.result ?? null } : {}),
    };
  }

  /** The daemon's timer: run when it is this machine's turn, it is on, and a day has gone by. */
  async maybeRun() {
    if (this.#running || keeperMachine(this.network())?.id !== this.self() || loadOwner().keeper === false) return null;
    const { lastRunAt = 0 } = this.#load();
    if (this.now() - lastRunAt < KEEP_EVERY_MS) return null;
    return this.run();
  }

  /** "Run now" from Settings. Starts and answers at once; Settings watches status(). */
  runNow() {
    if (keeperMachine(this.network())?.id !== this.self()) throw new Error('the keeper runs on another machine');
    if (!this.#running) void this.run().catch(() => {});
    return this.status();
  }

  async run() {
    if (this.#running) return null;
    this.#running = true;
    const startedAt = this.now();
    const state = this.#load();
    const finish = (result, advance) => {
      const next = { ...state, lastRunAt: startedAt, result };
      if (advance) Object.assign(next, advance);
      this.#save(next);
      return result;
    };
    try {
      const net = this.network();
      const since = state.since ?? startedAt - DAY;
      const read = { ...state.read };
      const chats = [];
      for (const m of Object.values(net?.machines ?? {})) {
        if (!m?.id || net.revoked?.[m.id]) continue;
        const params = { since, read: state.read[m.id] ?? {} };
        let answer;
        try {
          answer = m.id === this.self() ? await this.words(params) : await this.rpc(m.id, M.OWNER_WORDS, params);
        } catch (error) {
          // Asleep, or too old to know the question: its chats wait for the next run.
          this.log(`[keeper] ${m.name ?? m.id}: ${error.message}`);
          continue;
        }
        const seen = { ...(read[m.id] ?? {}) };
        for (const chat of answer?.chats ?? []) {
          if (typeof chat?.id !== 'string' || !Number.isFinite(chat.last)) continue;
          seen[chat.id] = chat.last;
          const texts = (Array.isArray(chat.texts) ? chat.texts : []).filter((t) => typeof t === 'string').map((t) => clip(t, MAX_MESSAGE));
          if (texts.length) chats.push({ title: String(chat.title ?? ''), texts });
        }
        // An index that only grows: keep the chats read most recently.
        read[m.id] = Object.fromEntries(Object.entries(seen).slice(-PER_MACHINE));
      }
      if (!chats.length) return finish('nothing new', { since: startedAt, read });
      const agent = pickKeeperAgent(await this.agents());
      if (!agent) return finish('failed: no account on this machine has a small model');
      const record = loadOwner();
      const reply = await this.ask({ ...agent, task: keeperTask(record.lines, chats) });
      const lines = parseKeeperReply(reply, record.lines);
      // The owner may have turned it off while the model was thinking.
      if (lines && loadOwner().keeper !== false) {
        const { record: next, changed } = editOwner({ lines }, {
          by: 'keeper', where: this.name(), now: this.now(),
          why: `Learned from ${chats.length} new chat${chats.length === 1 ? '' : 's'}`,
        });
        if (changed) this.changed(next);
        return finish(changed ? 'changed' : 'no change', { since: startedAt, read });
      }
      return finish('no change', { since: startedAt, read });
    } catch (error) {
      this.log(`[keeper] ${error.message}`);
      return finish(`failed: ${String(error.message).slice(0, 160)}`);
    } finally {
      this.#running = false;
    }
  }
}
