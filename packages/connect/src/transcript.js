import { readdir, stat, open } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
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

  if (engine === 'opencode' || engine === 'opencode2') {
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
  if (tailBytes === Infinity) {
    // Full history without allocating the whole rollout. External Codex
    // transcripts can be hundreds of MB after a long-running task.
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try { onLine(JSON.parse(line)); } catch { /* torn final write */ }
    }
    return;
  }
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

async function codexMessages(path, { all = false } = {}) {
  const out = [];
  await readLines(path, (rec) => {
    if (rec.type !== 'response_item') return;
    const p = rec.payload;
    if (!p) return;
    // Codex records tool calls as their own response items rather than as
    // blocks inside an assistant message. Keep them in the conversation so
    // an externally-created thread does not turn into a prose-only summary
    // when it is opened in Helm.
    if (['custom_tool_call', 'function_call', 'local_shell_call', 'web_search_call'].includes(p.type)) {
      const input = p.input ?? p.arguments ?? p.action ?? p.command ?? '';
      out.push({
        role: 'assistant', text: '',
        tools: [{ name: p.name ?? (p.type === 'local_shell_call' ? 'shell' : p.type.replace(/_call$/, '')), input: summariseTool(input) }],
        at: rec.timestamp,
      });
      return;
    }
    if (p.type !== 'message') return;
    // `developer` carries injected instructions, not conversation.
    if (p.role !== 'user' && p.role !== 'assistant') return;

    const { text, tools } = blocks(p.content);
    if (!text && !tools.length) return;
    // Codex prepends a machine-readable context block to the first turn.
    if (p.role === 'user' && text.startsWith('<environment_context>')) return;
    out.push({ role: p.role, text: clip(text), tools, at: rec.timestamp, sourceId: p.id ?? rec.id });
  }, { tailBytes: all ? Infinity : 4 << 20 });
  return out;
}

function summariseTool(input) {
  if (typeof input === 'string') {
    try { return summarise(JSON.parse(input)); } catch { return input.replace(/\s+/g, ' ').slice(0, 120); }
  }
  return summarise(input);
}

/**
 * Session facts the Codex TUI persists in a rollout and uses for `/status`.
 * A resumed app-server does not emit token usage until another model turn,
 * so reading the final token_count is the only accurate answer immediately
 * after an external CLI hands the thread to Helm.
 */
export async function codexSessionState(path) {
  const state = { settings: null, usage: null, rateLimits: null, cliVersion: null };
  if (!path || !existsSync(path)) return state;
  await readLines(path, (rec) => {
    const p = rec.payload;
    if (rec.type === 'session_meta') {
      state.cliVersion = p?.cli_version ?? state.cliVersion;
      if (!state.settings) state.settings = { cwd: p?.cwd, modelProvider: p?.model_provider };
      return;
    }
    if (rec.type === 'turn_context') {
      state.settings = {
        ...(state.settings ?? {}), cwd: p?.cwd, model: p?.model,
        effort: p?.effort ?? p?.collaboration_mode?.settings?.reasoning_effort,
        approvalPolicy: p?.approval_policy, sandboxPolicy: p?.sandbox_policy,
        permissionProfile: p?.permission_profile, personality: p?.personality,
      };
      return;
    }
    if (rec.type === 'event_msg' && p?.type === 'thread_settings_applied') {
      const x = p.thread_settings ?? {};
      state.settings = {
        ...(state.settings ?? {}), cwd: x.cwd, model: x.model,
        effort: x.reasoning_effort, approvalPolicy: x.approval_policy,
        sandboxPolicy: x.sandbox_policy, permissionProfile: x.permission_profile,
        personality: x.personality, serviceTier: x.service_tier,
      };
      return;
    }
    if (rec.type === 'event_msg' && p?.type === 'token_count') {
      const info = p.info ?? {};
      const camel = (x) => x && ({
        inputTokens: x.input_tokens ?? 0,
        cachedInputTokens: x.cached_input_tokens ?? 0,
        cacheWriteInputTokens: x.cache_write_input_tokens ?? 0,
        outputTokens: x.output_tokens ?? 0,
        reasoningOutputTokens: x.reasoning_output_tokens ?? 0,
        totalTokens: x.total_tokens ?? 0,
      });
      state.usage = {
        total: camel(info.total_token_usage), last: camel(info.last_token_usage),
        modelContextWindow: info.model_context_window ?? null,
      };
      state.rateLimits = p.rate_limits ?? state.rateLimits;
    }
  });
  return state;
}

async function claudeMessages(path, { all = false } = {}) {
  const found = [];
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

    found.push({
      role: rec.type, text: clip(text), tools,
      thinking, at: rec.timestamp, sourceId: msg.id ?? rec.uuid,
    });
  }, { tailBytes: all ? Infinity : 4 << 20 });
  // Claude may persist successive snapshots of a streaming message. The
  // last copy has the complete text/tool set.
  const out = [], byId = new Map();
  for (const message of found) {
    if (!message.sourceId) { out.push(message); continue; }
    const at = byId.get(message.sourceId);
    if (at == null) { byId.set(message.sourceId, out.length); out.push(message); }
    else out[at] = message;
  }
  return out;
}

function tableColumns(conn, table) {
  try { return new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)); }
  catch { return new Set(); }
}

function json(value) {
  if (!value || typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function opencodeMessages(db, sessionId, { all = false } = {}) {
  const out = [];
  try {
    const conn = new DatabaseSync(db, { readOnly: true });
    const messageCols = tableColumns(conn, 'message');
    const modern = messageCols.has('data');
    const cap = all ? '' : ' LIMIT 400';
    const rows = conn.prepare(modern
      ? `SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC${cap}`
      : `SELECT id, role, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC${cap}`
    ).all(sessionId);
    for (const r of rows) {
      const message = modern ? json(r.data) ?? {} : r;
      const parts = conn.prepare(modern
        ? `SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id`
        : `SELECT type, text, tool FROM part WHERE message_id = ? ORDER BY rowid`
      ).all(r.id).map((p) => modern ? json(p.data) ?? {} : p);
      const text = parts.filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text).filter(Boolean).join('\n\n');
      const tools = parts.filter((p) => p.type === 'tool').map((p) => ({
        name: p.tool ?? p.name ?? 'tool', input: summarise(p.state?.input ?? p.input),
      }));
      if (!text && !tools.length) continue;
      out.push({ role: message.role, text: clip(text), tools, at: r.time_created, sourceId: r.id });
    }
    conn.close();
  } catch { /* schema drift or a locked database */ }
  return out;
}

/** OpenCode 2 stores one complete provider-neutral payload per message. */
function opencode2Messages(db, sessionId, { all = false } = {}) {
  const out = [];
  try {
    const conn = new DatabaseSync(db, { readOnly: true });
    const cap = all ? '' : ' LIMIT 400';
    const rows = conn.prepare(
      `SELECT id, type, data, time_created FROM session_message
        WHERE session_id = ? ORDER BY seq ASC${cap}`
    ).all(sessionId);
    for (const r of rows) {
      const message = json(r.data) ?? {};
      const content = Array.isArray(message.content) ? message.content : [];
      const text = [
        ...(typeof message.text === 'string' ? [message.text] : []),
        ...content.filter((p) => p?.type === 'text').map((p) => p.text).filter(Boolean),
      ].join('\n\n');
      const tools = content
        .filter((p) => p?.type === 'tool' || p?.type === 'tool_use')
        .map((p) => ({
          name: p.name ?? p.tool ?? p.toolName ?? 'tool',
          input: summarise(p.state?.input ?? p.input ?? p.arguments),
        }));
      if (!text && !tools.length) continue;
      out.push({
        role: r.type === 'assistant' ? 'assistant' : 'user',
        text: clip(text), tools, at: r.time_created, sourceId: r.id,
      });
    }
    conn.close();
  } catch { /* preview schema drift or a locked database */ }
  return out;
}

function devinMessages(db, sessionId, { all = false } = {}) {
  const out = [];
  try {
    const conn = new DatabaseSync(db, { readOnly: true });
    const cap = all ? '' : ' LIMIT 400';
    const rows = conn.prepare(
      `SELECT node_id, chat_message, created_at FROM message_nodes
        WHERE session_id = ? ORDER BY node_id ASC${cap}`
    ).all(sessionId);
    // Devin persists successive snapshots of one streaming message. Keep the
    // final snapshot for each message id, then restore conversation order.
    const latest = new Map();
    for (const r of rows) {
      const m = json(r.chat_message);
      if (!m || !['user', 'assistant'].includes(m.role)) continue;
      const key = m.message_id ?? `${r.node_id}`;
      latest.set(key, { ...r, message: m });
    }
    for (const r of [...latest.values()].sort((a, b) => a.node_id - b.node_id)) {
      const m = r.message;
      const text = typeof m.content === 'string' ? m.content : blocks(m.content).text;
      const tools = (m.tool_calls ?? []).map((t) => ({
        name: t.name ?? t.function?.name ?? 'tool',
        input: summarise(t.arguments ?? t.function?.arguments),
      }));
      if (!text && !tools.length) continue;
      // Cache keepalives and injected summaries are implementation detail,
      // not messages the owner typed into the conversation.
      if (m.role === 'user' && m.metadata?.telemetry?.source === 'cache_keepalive') continue;
      out.push({ role: m.role, text: clip(text), tools, at: m.created_at ?? r.created_at, sourceId: m.message_id ?? String(r.node_id) });
    }
    conn.close();
  } catch { /* schema drift or a locked database */ }
  return out;
}

/** A persisted, provider-neutral status answer for a session being monitored. */
export async function sessionSnapshot({ engine, path, sessionId, cwd, monitored = true }) {
  const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
  // The answer renders as Markdown, so what a provider stored cannot become
  // markup of its own.
  const esc = (v) => String(v ?? '').replace(/([\\`*_{}\[\]()<>#+.!|])/g, '\\$1');
  const code = (v) => `\`${String(v ?? '').replace(/`/g, '\\`')}\``;
  const lines = [
    `**Provider:** ${esc(engine)}`,
    `**Session:** ${esc(sessionId)}`,
    `**Directory:** ${code(cwd)}`,
    monitored ? '**State:** running outside Helm (live monitor)' : '**State:** resumed in Helm',
  ];
  let usage = null;
  try {
    if (engine === 'claude') {
      const seen = new Map();
      let model = null;
      await readLines(path, (r) => {
        const m = r.message;
        if (r.type !== 'assistant' || !m) return;
        model = m.model ?? model;
        seen.set(m.id ?? r.uuid ?? `${seen.size}`, m.usage ?? {});
      }, { tailBytes: Infinity });
      let input = 0, output = 0, cacheRead = 0;
      for (const x of seen.values()) {
        input += Number(x.input_tokens ?? 0);
        output += Number(x.output_tokens ?? 0);
        cacheRead += Number(x.cache_read_input_tokens ?? 0);
      }
      if (model) lines.splice(1, 0, `**Model:** ${esc(model)}`);
      usage = { input, output, cacheRead };
    } else if (engine === 'opencode' || engine === 'opencode2') {
      const conn = new DatabaseSync(path, { readOnly: true });
      const table = engine === 'opencode2' ? 'session_v2' : 'session';
      const cols = tableColumns(conn, table);
      const totals = cols.has('tokens_input')
        ? conn.prepare(`SELECT tokens_input AS input, tokens_output AS output, tokens_cache_read AS cacheRead, cost, model FROM ${table} WHERE id = ?`).get(sessionId)
        : null;
      conn.close();
      if (totals?.model) lines.splice(1, 0, `**Model:** ${esc(opencodeModel(totals.model) ?? totals.model)}`);
      if (totals) usage = totals;
    } else if (engine === 'devin') {
      const conn = new DatabaseSync(path, { readOnly: true });
      const row = conn.prepare(`SELECT model, agent_mode FROM sessions WHERE id = ?`).get(sessionId);
      const records = conn.prepare(`SELECT chat_message FROM message_nodes WHERE session_id = ?`).all(sessionId);
      conn.close();
      if (row?.model) lines.splice(1, 0, `**Model:** ${esc(row.model)}`);
      if (row?.agent_mode) lines.splice(2, 0, `**Mode:** ${esc(row.agent_mode)}`);
      const seen = new Map();
      usage = { input: 0, output: 0, cacheRead: 0 };
      for (const record of records) {
        const m = json(record.chat_message);
        if (m?.role !== 'assistant' || !m.message_id) continue;
        seen.set(m.message_id, m.metadata?.metrics ?? {});
      }
      for (const x of seen.values()) {
        usage.input += Number(x.input_tokens ?? 0);
        usage.output += Number(x.output_tokens ?? 0);
        usage.cacheRead += Number(x.cache_read_tokens ?? 0);
      }
    }
  } catch { /* status remains useful even if a provider changes its schema */ }
  let out = `### Session status\n\n${lines.join('  \n')}`;
  if (usage) {
    const usageLines = [
      `**Input:** ${fmt(usage.input)}`,
      `**Cached input:** ${fmt(usage.cacheRead)}`,
      `**Output:** ${fmt(usage.output)}`,
      ...(usage.cost != null ? [`**Cost:** $${Number(usage.cost).toFixed(4)}`] : []),
    ];
    out += `\n\n### Session usage\n\n${usageLines.join('  \n')}`;
  }
  return out;
}

function opencodeModel(v) {
  if (typeof v !== 'string' || !v) return null;
  if (!v.startsWith('{')) return v;
  try { const x = JSON.parse(v); return x.id ?? x.modelID ?? null; } catch { return null; }
}

/** Read a transcript as a list of messages, oldest first. */
export async function messages({ engine, path, sessionId, limit = 120, all = false }) {
  if (!path || !existsSync(path)) return [];
  let found = [];
  if (engine === 'codex') found = await codexMessages(path, { all });
  else if (engine === 'claude') found = await claudeMessages(path, { all });
  else if (engine === 'opencode') found = opencodeMessages(path, sessionId, { all });
  else if (engine === 'opencode2') found = opencode2Messages(path, sessionId, { all });
  else if (engine === 'devin') found = devinMessages(path, sessionId, { all });
  return all ? found : found.slice(-limit);
}
