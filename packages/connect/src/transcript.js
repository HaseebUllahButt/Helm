import { readdir, stat, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expand, HOME } from './paths.js';
import { ENGINES } from './engines.js';

/**
 * Reading a session as a conversation rather than as a terminal.
 *
 * Every CLI writes a structured transcript while it works. Rendering that is
 * far more readable on a phone than scraping the rendered TUI - it survives
 * scrollback, it separates your turns from the agent's, and tool calls can be
 * folded away instead of filling the screen.
 */

const MAX_TEXT = 8000;

// ------------------------------------------------------------------ locating

/** Newest file under `dir` matching `filter`, or null. */
async function newestFile(dir, filter, since = 0) {
  let best = null;
  const walk = async (d, depth = 0) => {
    if (depth > 5) return;
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!filter(e.name)) continue;
      try {
        const s = await stat(full);
        if (s.mtimeMs < since) continue;
        if (!best || s.mtimeMs > best.mtime) best = { path: full, mtime: s.mtimeMs };
      } catch { /* vanished mid-scan */ }
    }
  };
  await walk(dir);
  return best;
}

/** Claude names a project directory after the working directory. */
const claudeProject = (cwd) => expand(cwd).replace(/\//g, '-');

/**
 * Find the transcript a running session is writing to.
 *
 * herdr does not tell us this - it tracks terminals, not the agent's files -
 * so we match on the engine's own layout: the newest transcript for this
 * account, in this directory, written since the session started.
 */
export async function locate({ engine, home, cwd, startedAt = 0 }) {
  const root = expand(home ?? ENGINES[engine]?.defaultHome ?? HOME);
  const slack = 60_000; // the file appears slightly after we start the agent

  if (engine === 'codex') {
    const dir = join(root, 'sessions');
    if (!existsSync(dir)) return null;
    const hit = await newestFile(dir, (n) => n.endsWith('.jsonl'), startedAt - slack);
    return hit?.path ?? null;
  }

  if (engine === 'claude') {
    const dir = join(root, 'projects', claudeProject(cwd));
    if (!existsSync(dir)) return null;
    const hit = await newestFile(dir, (n) => n.endsWith('.jsonl'), startedAt - slack);
    return hit?.path ?? null;
  }

  if (engine === 'opencode') {
    const base = process.env.XDG_DATA_HOME || join(HOME, '.local', 'share');
    for (const name of ['opencode', 'opencode2']) {
      const db = join(base, name, 'opencode.db');
      if (existsSync(db)) return db;
    }
  }
  return null;
}

// ------------------------------------------------------------------- parsing

const clip = (s) => {
  const t = String(s ?? '').trim();
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '\n…' : t;
};

/** Flatten a content array into display text plus the tools it invoked. */
function blocks(content) {
  if (typeof content === 'string') return { text: content, tools: [], thinking: false };
  if (!Array.isArray(content)) return { text: '', tools: [], thinking: false };

  const parts = [];
  const tools = [];
  let thinking = false;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text':
      case 'output_text':
      case 'input_text':
        if (b.text) parts.push(b.text);
        break;
      case 'thinking':
      case 'redacted_thinking':
        thinking = true;
        break;
      case 'tool_use':
        tools.push({ name: b.name, input: summarise(b.input) });
        break;
      case 'tool_result':
        // The result belongs to the call above it, not to a new turn.
        break;
    }
  }
  return { text: parts.join('\n\n'), tools, thinking };
}

/** One short line describing what a tool was asked to do. */
function summarise(input) {
  if (!input || typeof input !== 'object') return '';
  const first = input.command ?? input.file_path ?? input.path ??
                input.pattern ?? input.query ?? input.url ?? '';
  return String(first).replace(/\s+/g, ' ').slice(0, 120);
}

async function readLines(path, onLine, { tailBytes = 4 << 20 } = {}) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A partial first line is unavoidable when reading a tail; drop it.
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onLine(JSON.parse(line)); } catch { /* torn write at the tail */ }
    }
  } finally {
    await fh.close();
  }
}

async function codexMessages(path) {
  const out = [];
  await readLines(path, (rec) => {
    if (rec.type !== 'response_item') return;
    const p = rec.payload;
    if (!p || p.type !== 'message') return;
    // `developer` carries injected instructions, not conversation.
    if (p.role !== 'user' && p.role !== 'assistant') return;

    const { text, tools } = blocks(p.content);
    if (!text && !tools.length) return;
    // Codex prepends a machine-readable context block to the first turn.
    if (p.role === 'user' && text.startsWith('<environment_context>')) return;
    out.push({ role: p.role, text: clip(text), tools, at: rec.timestamp });
  });
  return out;
}

async function claudeMessages(path) {
  const out = [];
  await readLines(path, (rec) => {
    if (rec.type !== 'user' && rec.type !== 'assistant') return;
    if (rec.isSidechain) return; // a subagent's transcript, not this conversation
    const msg = rec.message;
    if (!msg) return;

    const { text, tools, thinking } = blocks(msg.content);
    if (!text && !tools.length) return;
    // Tool results arrive as user turns; they are not something you said.
    if (rec.type === 'user' && !text) return;
    if (rec.type === 'user' && text.startsWith('<')) return;

    out.push({
      role: rec.type, text: clip(text), tools,
      thinking, at: rec.timestamp,
    });
  });
  return out;
}

function opencodeMessages(db, sessionId) {
  const out = [];
  try {
    const conn = new DatabaseSync(db, { readOnly: true });
    const rows = conn.prepare(
      `SELECT m.id, m.role, m.time_created FROM message m
        WHERE m.session_id = ? ORDER BY m.time_created ASC LIMIT 400`
    ).all(sessionId);
    for (const r of rows) {
      const parts = conn.prepare(
        `SELECT type, text, tool FROM part WHERE message_id = ? ORDER BY rowid`
      ).all(r.id);
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
      const tools = parts.filter((p) => p.type === 'tool').map((p) => ({ name: p.tool, input: '' }));
      if (!text && !tools.length) continue;
      out.push({ role: r.role, text: clip(text), tools, at: r.time_created });
    }
    conn.close();
  } catch { /* schema drift or a locked database */ }
  return out;
}

/** Read a transcript as a list of messages, oldest first. */
export async function messages({ engine, path, sessionId, limit = 120 }) {
  if (!path || !existsSync(path)) return [];
  let all = [];
  if (engine === 'codex') all = await codexMessages(path);
  else if (engine === 'claude') all = await claudeMessages(path);
  else if (engine === 'opencode') all = opencodeMessages(path, sessionId);
  return all.slice(-limit);
}
