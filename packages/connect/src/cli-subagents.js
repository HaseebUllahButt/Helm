import { readdir, stat, open } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { expand } from './paths.js';
import { nativeStatus } from './native-subagents.js';

/**
 * The subagents other CLIs start, read from each CLI's own records - the
 * Codex, OpenCode and Cursor counterparts of `native-subagents.js` (Claude).
 *
 * Each CLI keeps a child as a conversation of its own that points back at
 * the one that started it:
 *
 *   codex     state_<n>.sqlite `thread_spawn_edges` parent -> child thread,
 *             the child's rollout file holds its conversation
 *   opencode  opencode.db `session_v2.parent_id` (OpenCode 2), or
 *             `session.parent_id` (OpenCode 1)
 *   cursor    projects/<p>/agent-transcripts/<parent>/subagents/<child>.jsonl
 *
 * A card has the same shape as a Claude one, so the app draws every CLI's
 * helpers the same way. `target` is what the parent calls the child when it
 * is asked to pass a message on.
 */

const MAX_AGENTS = 24;
const MAX_LINE = 160;
const TAIL_BYTES = 128 << 10;

const oneLine = (s, max = MAX_LINE) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/** The last `bytes` of a file as whole JSON lines, oldest first. */
async function tailRecords(path, bytes = TAIL_BYTES) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn by a live write */ }
    }
    return out;
  } finally {
    await fh.close();
  }
}

const withDb = (path, read) => {
  let conn;
  try {
    conn = new DatabaseSync(path, { readOnly: true });
    return read(conn);
  } catch { return null; } finally { try { conn?.close(); } catch { /* already closed */ } }
};

const hasTable = (conn, name) => !!conn.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

// ------------------------------------------------------------------ codex

/** The newest `state_<n>.sqlite` under a Codex home. */
export function codexStateDb(home) {
  const dir = expand(home || '~/.codex');
  let names = [];
  try { names = readdirSync(dir); } catch { return null; }
  const found = names.map((name) => /^state_(\d+)\.sqlite$/.exec(name)).filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return found.length ? join(dir, found[0][0]) : null;
}

/** Where a Codex child's last turn got to, from its rollout's own markers. */
async function codexPhase(path) {
  let phase = null, model = null, last = '';
  for (const rec of await tailRecords(path)) {
    const p = rec.payload ?? {};
    if (rec.type === 'turn_context' && p.model) model = p.model;
    if (rec.type === 'event_msg') {
      if (p.type === 'task_started') phase = 'working';
      else if (p.type === 'task_complete') { phase = 'done'; if (p.last_agent_message) last = p.last_agent_message; }
      else if (p.type === 'turn_aborted') phase = 'interrupted';
      else if (p.type === 'error') phase = 'error';
    }
    if (rec.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const text = (p.content ?? []).map((b) => b?.text).filter(Boolean).join(' ');
      if (text) last = text;
    }
  }
  return { phase, model, last };
}

export async function codexSubagents({ home, threadId, now = Date.now() }) {
  const db = codexStateDb(home);
  if (!db || !threadId) return [];
  const rows = withDb(db, (conn) => {
    if (!hasTable(conn, 'thread_spawn_edges')) return [];
    return conn.prepare(
      `SELECT e.child_thread_id AS id, e.status AS edge, t.rollout_path AS rollout, t.created_at_ms AS created,
              t.agent_nickname AS nickname, t.agent_role AS role, t.agent_path AS path, t.title AS title,
              t.first_user_message AS prompt, t.model AS model
         FROM thread_spawn_edges e LEFT JOIN threads t ON t.id = e.child_thread_id
        WHERE e.parent_thread_id = ? ORDER BY t.created_at_ms DESC LIMIT ?`,
    ).all(threadId, MAX_AGENTS);
  }) ?? [];
  const out = [];
  for (const r of rows) {
    if (!r.rollout || !existsSync(r.rollout)) continue;
    try {
      const info = await stat(r.rollout);
      const { phase, model, last } = await codexPhase(r.rollout);
      const status = nativeStatus(phase ?? 'working', info.mtimeMs, now);
      // Codex names each helper (a nickname) and its task (the agent path).
      const task = r.path ? r.path.split('/').filter(Boolean).at(-1)?.replace(/_/g, ' ') : '';
      out.push({
        id: r.id, native: true, engine: 'codex',
        title: oneLine(task || r.title || r.prompt, 80) || r.nickname || 'Helper',
        agentType: r.nickname || r.role || null, model: r.model || model || null, status,
        startedAt: Math.round(Number(r.created) || info.birthtimeMs || info.mtimeMs), updatedAt: Math.round(info.mtimeMs),
        branch: null, toolUseId: null, last: oneLine(last, 200),
        target: r.path || r.nickname || r.id, path: r.rollout,
      });
    } catch { /* vanished mid-read */ }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

// --------------------------------------------------------------- opencode

/** Every OpenCode database under the data folder, as the inventory finds them. */
export function opencodeDbs(dataHome) {
  const base = expand(dataHome || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'));
  try { return readdirSync(base).filter((d) => d.startsWith('opencode')).map((d) => join(base, d, 'opencode.db')).filter(existsSync); }
  catch { return []; }
}

const json = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

export function opencodeSubagents({ dataHome, sessionId, engine = 'opencode2', now = Date.now() }) {
  if (!sessionId) return [];
  for (const db of opencodeDbs(dataHome)) {
    const found = withDb(db, (conn) => {
      const v2 = hasTable(conn, 'session_v2');
      const table = v2 ? 'session_v2' : 'session';
      const rows = conn.prepare(
        `SELECT id, title, agent, model, time_created AS created, time_updated AS updated
           FROM ${table} WHERE parent_id = ? ORDER BY time_created DESC LIMIT ?`,
      ).all(sessionId, MAX_AGENTS);
      if (!rows.length) return null;
      return rows.map((r) => {
        // The newest row says where it got to: OpenCode closes a run with
        // an `idle` row naming the outcome, and stamps `time.completed` on
        // each reply as it ends.
        let phase = 'working', last = '', model = null, updated = Number(r.updated) || now;
        if (v2 && hasTable(conn, 'session_message')) {
          const m = conn.prepare(`SELECT type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 1`).get(r.id);
          const reply = conn.prepare(`SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1`).get(r.id);
          const data = json(reply?.data) ?? {};
          const end = m?.type === 'idle' ? json(m.data) ?? {} : null;
          phase = end ? (end.outcome === 'succeeded' ? 'done' : /abort|cancel|interrupt/i.test(end.outcome ?? '') ? 'interrupted' : 'error')
            : m?.type === 'assistant' ? (data.error ? 'error' : data.time?.completed ? 'done' : 'working') : 'working';
          last = (data.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
          model = data.model?.id ?? null;
          updated = Math.max(updated, Number(m?.time_created) || 0);
        }
        const configured = json(r.model);
        return {
          id: r.id, native: true, engine,
          title: oneLine(r.title, 80) || r.agent || 'Helper', agentType: r.agent || null,
          model: model || configured?.id || configured?.modelID || (typeof r.model === 'string' && !configured ? r.model : null),
          status: nativeStatus(phase, updated, now),
          startedAt: Number(r.created) || now, updatedAt: updated,
          branch: null, toolUseId: null, last: oneLine(last, 200),
          target: r.id, path: db,
        };
      });
    });
    if (found) return found.sort((a, b) => a.startedAt - b.startedAt);
  }
  return [];
}

// ----------------------------------------------------------------- cursor

/** `<home>/projects/<project>/agent-transcripts/<chat>/subagents`, whichever project holds the chat. */
export function cursorSubagentsDir({ home, chatId }) {
  if (!chatId || !/^[A-Za-z0-9_-]{1,80}$/.test(chatId)) return null;
  const projects = join(expand(home || '~/.cursor'), 'projects');
  let names = [];
  try { names = readdirSync(projects); } catch { return null; }
  for (const name of names) {
    const dir = join(projects, name, 'agent-transcripts', chatId, 'subagents');
    if (existsSync(dir)) return dir;
  }
  return null;
}

const cursorText = (content) => (Array.isArray(content) ? content : [content])
  .map((b) => typeof b === 'string' ? b : b?.type === 'text' ? b.text : '').filter(Boolean).join('\n\n');

/** Cursor wraps what was asked in tags; the request is inside `<user_query>`. */
export const cursorPrompt = (text) => (/<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)?.[1] ?? text).trim();

/** A Cursor subagent file as messages: role, text and the tools it called. */
export async function cursorMessages(path) {
  const { readFile } = await import('node:fs/promises');
  const out = [];
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const role = rec.role ?? rec.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = rec.message?.content ?? rec.content;
    const blocks = Array.isArray(content) ? content : [];
    const tools = blocks.filter((b) => b?.type === 'tool_use' || b?.type === 'tool_call')
      .map((b) => ({ name: b.name ?? 'tool', input: oneLine(b.input?.command ?? b.input?.path ?? b.input?.file_path ?? b.input?.query ?? '', 120) }));
    const raw = cursorText(content);
    const text = role === 'user' ? cursorPrompt(raw) : raw;
    if (!text && !tools.length) continue;
    out.push({ role, text, tools });
  }
  return out;
}

export async function cursorSubagents({ home, chatId, now = Date.now() }) {
  const dir = cursorSubagentsDir({ home, chatId });
  if (!dir) return [];
  let names = [];
  try { names = await readdir(dir); } catch { return []; }
  const files = [];
  for (const name of names) {
    const id = /^([A-Za-z0-9_-]+)\.jsonl$/.exec(name)?.[1];
    if (!id) continue;
    try { files.push({ id, path: join(dir, name), info: await stat(join(dir, name)) }); } catch { /* vanished */ }
  }
  const out = [];
  for (const { id, path, info } of files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, MAX_AGENTS)) {
    try {
      const messages = await cursorMessages(path);
      const first = messages.find((m) => m.role === 'user');
      const end = messages.at(-1);
      // Cursor writes no stop marker: a last word from the agent, gone
      // quiet, is a finished run.
      const phase = end?.role === 'assistant' && end.text ? 'done' : 'working';
      out.push({
        id, native: true, engine: 'cursor',
        title: oneLine(first?.text.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '', 80) || 'Subagent',
        agentType: null, model: null, status: nativeStatus(phase, info.mtimeMs, now),
        startedAt: Math.round(info.birthtimeMs || info.mtimeMs), updatedAt: Math.round(info.mtimeMs),
        branch: null, toolUseId: null, last: oneLine([...messages].reverse().find((m) => m.role === 'assistant' && m.text)?.text, 200),
        target: id, path,
      });
    } catch { /* unreadable */ }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

// ------------------------------------------------- from the chat's own log

/**
 * The helpers a chat Helm drives started, as its event log recorded them:
 * every CLI's spawn arrives as a `subagent` item. This is all Helm knows of
 * a CLI that keeps no record of its children it can read (Devin, Grok,
 * Gemini...), and it covers the moment before a CLI has written one.
 */
export function eventSubagents(events, { engine, now = Date.now() } = {}) {
  const cards = new Map();
  for (const e of events) {
    // Codex marks every agent call a `subagent` item - waiting on one,
    // messaging one - but only a spawn is a new helper.
    if (e.type === 'item.start' && e.kind === 'subagent' && !e.parentId && !(engine === 'codex' && !/spawn/i.test(e.name ?? ''))) {
      const input = e.input && typeof e.input === 'object' ? e.input : {};
      const task = input.description ?? input.task_name ?? input.prompt ?? input.message ?? '';
      cards.set(e.id, {
        id: e.id, native: true, engine, fromLog: true,
        title: oneLine(String(task).split('\n')[0], 80) || e.name || 'Helper',
        agentType: input.subagent_type ?? input.agent_type ?? null, model: input.model ?? null,
        status: 'working', startedAt: e.at ?? now, updatedAt: e.at ?? now, branch: null, toolUseId: e.id, last: '',
        threadId: null, prompt: typeof input.prompt === 'string' ? input.prompt : typeof input.message === 'string' ? input.message : '',
      });
      continue;
    }
    const card = e.id && cards.get(e.id);
    if (!card) continue;
    if (e.at) card.updatedAt = e.at;
    // The driver's own word on a helper outlives its spawn call.
    if (e.type === 'subagent.status') {
      card.status = e.status === 'idle' ? 'done' : e.status;
      card.reported = true;
      continue;
    }
    if (e.type === 'item.update' && e.agent) {
      if (e.agent.id) card.threadId = e.agent.id;
      if (e.agent.summary) card.last = oneLine(e.agent.summary, 200);
      if (e.agent.model) card.model = e.agent.model;
    }
    if (e.type === 'item.done') {
      if (!card.reported) card.status = e.status === 'error' ? 'error' : e.status === 'declined' ? 'interrupted' : 'done';
      if (e.output) card.last = oneLine(String(e.output).replace(/<\/?subagent\b[^>]*>/g, ''), 200);
      // OpenCode's task names the child session it ran in.
      const child = /sessionID="([A-Za-z0-9_-]+)"/.exec(String(e.output ?? ''))?.[1];
      if (child) card.threadId = child;
    }
  }
  return [...cards.values()].map(({ reported, ...card }) => card);
}

/** CLIs whose records Helm reads a chat's subagents from. */
export const SUBAGENT_ENGINES = new Set(['claude', 'codex', 'opencode', 'opencode2', 'cursor']);

/**
 * What a helper was asked, without the wrapping its CLI adds: Claude files
 * a message passed on by the parent as the coordinator's, OpenCode opens a
 * child's task by telling it what it is.
 */
export const unwrapCoordinator = (text) =>
  (/^The coordinator sent a message while you were working:\n([\s\S]*?)\n\nAddress this before completing your current task\.?$/.exec(text ?? '')?.[1] ?? text ?? '')
    .replace(/^You are a subagent spawned by another session\.\n/, '');

const AGENT_HEADER = /^Message Type: [A-Z_]+\nTask name: [^\n]*\nSender: [^\n]*\nPayload:\n?/;

/**
 * A Codex child's own conversation. A forked child's rollout begins with a
 * copy of its parent's chat; its own part starts at the first message the
 * parent sent it. Codex stores those messages sealed, so the words of any
 * Helm passed on are filled in from `sent`, and the rest name the sender.
 */
export async function codexChildMessages(path, { sent = [] } = {}) {
  const { messages } = await import('./transcript.js');
  const all = await messages({ engine: 'codex', path, all: true });
  const notes = [];
  const { readFile } = await import('node:fs/promises');
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.includes('"agent_message"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const p = rec.payload ?? {};
    if (rec.type !== 'response_item' || p.type !== 'agent_message') continue;
    const plain = (p.content ?? []).filter((b) => b?.type === 'input_text').map((b) => b.text).join('').replace(AGENT_HEADER, '').trim();
    notes.push({ at: Date.parse(rec.timestamp ?? '') || 0, from: p.author, plain, task: /^Message Type: NEW_TASK/.test(p.content?.[0]?.text ?? '') });
  }
  if (!notes.length) return all;
  const begin = notes[0].at;
  const own = all.filter((m) => (Date.parse(m.at ?? '') || 0) >= begin && !(m.role === 'user' && /^<environment_context>/.test(m.text)));
  const pending = [...sent];
  for (const note of notes) {
    // A Helm message went in shortly before the parent passed it on.
    const i = pending.findIndex((m) => m.at <= note.at + 1000);
    const text = note.plain || (!note.task && i >= 0 ? pending[i].text : '') || (note.task ? 'New task from the main chat.' : 'Message from the main chat.');
    if (!note.task && i >= 0) pending.splice(i, 1);
    own.push({ role: 'user', text, tools: [], at: new Date(note.at).toISOString() });
  }
  return own.sort((a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0));
}

/**
 * What the parent is asked to do with a message for one of its helpers:
 * pass it on, unchanged, with its own tool for that. The tag lets the app
 * show it as a message to the helper rather than a turn of its own.
 */
export function relayToSubagent(engine, card, text) {
  const name = card.title.replace(/"/g, "'");
  const how = engine === 'claude'
    ? `Pass it on unchanged with SendMessage (to: "${card.target}")`
    : engine === 'codex'
      ? `Pass it on unchanged to your agent ${card.target}: use send_message if it is still working, or followup_task if it has finished`
      : `Pass it on unchanged with your task tool: task_id "${card.target}"${card.agentType ? `, subagent_type "${card.agentType}"` : ''}, and this message as the prompt`;
  return `<subagent-message to="${card.target}" title="${name}">\n${text}\n</subagent-message>\n\n`
    + `The owner wrote this in Helm to your helper "${name}". ${how}. Do not do the work yourself. When its reply comes back, answer with one short line.`;
}
