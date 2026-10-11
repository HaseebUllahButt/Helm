import { readdir, readFile, stat, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expand } from './paths.js';

/**
 * Claude Code's own subagents (its Agent/Task tool), read from the files it
 * leaves beside a conversation.
 *
 * They are not Helm sessions: nothing here can message, stop or resume one.
 * Each run is `<projects>/<project>/<sessionId>/subagents/agent-<id>.jsonl`
 * plus an `agent-<id>.meta.json` naming its type, model and worktree. A long
 * subagent's file runs to megabytes, so only its head and tail are read, and
 * only again once its size or mtime moves.
 */

const HEAD_BYTES = 64 << 10;
const TAIL_BYTES = 256 << 10;
// An end_turn this fresh may still be followed by a queued message; one more
// poll settles it, rather than flashing "Finished" between two replies.
const DONE_GRACE_MS = 5_000;
// No write for this long without an ending: the process that ran it is gone
// (an interrupted parent, a closed terminal). A quiet tool call can hold a
// subagent silent for minutes, so this errs long, never forever.
export const NATIVE_STALE_MS = 10 * 60_000;
// The newest runs a thread shows; a session that spawned hundreds keeps its
// payload small, and the oldest are history no one is waiting on.
const MAX_AGENTS = 24;
const MAX_RESULT = 4000;
const MAX_LINE = 160;
const MAX_ACTIVITY = 8;

const AGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

const oneLine = (s, max = MAX_LINE) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
const clipText = (s) => {
  const t = String(s ?? '').trim();
  return t.length > MAX_RESULT ? t.slice(0, MAX_RESULT) + '\n…' : t;
};
const when = (v) => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };

/** `<dir>/<sessionId>.jsonl` -> `<dir>/<sessionId>/subagents`. */
export const subagentsDir = (transcript) =>
  typeof transcript === 'string' && transcript.endsWith('.jsonl') ? join(transcript.slice(0, -'.jsonl'.length), 'subagents') : null;

/**
 * Where a conversation Helm drives keeps its subagents, when it has no
 * transcript path on record. Claude names the project folder after the
 * working directory with every non-alphanumeric character as a dash; older
 * builds (and transcript.js `locate`) only replaced slashes.
 */
export function findSubagentsDir({ home, cwd, sessionId }) {
  if (!home || !cwd || !sessionId || !AGENT_ID.test(sessionId)) return null;
  const projects = join(expand(home), 'projects');
  const full = expand(cwd);
  for (const name of new Set([full.replace(/[^a-zA-Z0-9]/g, '-'), full.replace(/\//g, '-')])) {
    const dir = join(projects, name, sessionId, 'subagents');
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Text and tool calls of one record's content, as short display lines. */
function lines(content) {
  if (typeof content === 'string') return { text: content, tools: [] };
  if (!Array.isArray(content)) return { text: '', tools: [] };
  const text = [], tools = [];
  for (const b of content) {
    if (b?.type === 'text' && b.text) text.push(b.text);
    else if (b?.type === 'tool_use') {
      const input = b.input ?? {};
      const what = input.description ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? '';
      tools.push(oneLine(`${b.name}${what ? `: ${what}` : ''}`));
    }
  }
  return { text: text.join('\n\n'), tools };
}

const parseLines = (text, { dropFirst = false, dropLast = false } = {}) => {
  const raw = text.split('\n');
  if (dropFirst) raw.shift();
  if (dropLast) raw.pop();
  const out = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn by the read window or a live write */ }
  }
  return out;
};

/** Head and tail records; a small file is read once, whole. */
async function readEnds(path, size) {
  const fh = await open(path, 'r');
  try {
    const read = async (start, length) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, start);
      return buf.subarray(0, bytesRead).toString('utf8');
    };
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const all = parseLines(await read(0, size));
      return { head: all, tail: all };
    }
    return {
      head: parseLines(await read(0, HEAD_BYTES), { dropLast: true }),
      tail: parseLines(await read(size - TAIL_BYTES, TAIL_BYTES), { dropFirst: true }),
    };
  } finally {
    await fh.close();
  }
}

/** What the records say, before time is taken into account. */
function summarise(head, tail) {
  const first = head.find((r) => r.type === 'user' && r.message);
  const prompt = first ? lines(first.message.content).text : '';
  let phase = null, model = null, final = null, error = null;
  const activity = [];
  for (const rec of tail) {
    const msg = rec.message;
    if (rec.type === 'assistant' && msg) {
      model = msg.model ?? model;
      const { text, tools } = lines(msg.content);
      if (text) {
        activity.push(oneLine(text));
        // One reply arrives as several lines sharing its id: keep them whole.
        final = final?.id === msg.id ? { id: msg.id, text: `${final.text}\n\n${text}` } : { id: msg.id, text };
      }
      activity.push(...tools);
      if (rec.isApiErrorMessage || rec.error) { phase = 'error'; error = text || String(rec.error ?? 'Provider error'); continue; }
      const reason = msg.stop_reason;
      phase = ['end_turn', 'stop_sequence', 'max_tokens'].includes(reason) ? 'done' : 'working';
    } else if (rec.type === 'user' && msg) {
      const { text } = lines(msg.content);
      // Claude Code's own marker for Esc or a stopped parent.
      phase = /^\[Request interrupted by user/.test(text.trim()) ? 'interrupted' : 'working';
      if (phase === 'working' && text) final = null; // a follow-up opens a new answer
    }
  }
  return {
    phase, model, prompt,
    startedAt: when(head.find((r) => r.timestamp)?.timestamp),
    result: phase === 'error' ? error : final?.text ?? '',
    activity: activity.filter(Boolean).slice(-MAX_ACTIVITY),
  };
}

// path -> { stamp, parsed, meta }; a file that has not moved is not re-read.
const cache = new Map();

async function readAgent(dir, id, info) {
  const path = join(dir, `agent-${id}.jsonl`);
  info ??= await stat(path);
  const stamp = `${info.size}:${info.mtimeMs}`;
  let hit = cache.get(path);
  if (hit?.stamp !== stamp) {
    const meta = await readFile(join(dir, `agent-${id}.meta.json`), 'utf8').then(JSON.parse).catch(() => null);
    const { head, tail } = await readEnds(path, info.size);
    hit = { stamp, meta: meta && typeof meta === 'object' ? meta : {}, parsed: summarise(head, tail), birth: info.birthtimeMs || info.mtimeMs };
    cache.set(path, hit);
    if (cache.size > 1024) cache.delete(cache.keys().next().value);
  }
  return { ...hit, mtime: info.mtimeMs };
}

/** The settled state, now: the file's last word, aged by its mtime. */
export function nativeStatus(phase, mtime, now = Date.now()) {
  const quiet = now - mtime;
  if (phase === 'done') return quiet < DONE_GRACE_MS ? 'working' : 'done';
  if (phase === 'error' || phase === 'interrupted') return phase;
  return quiet > NATIVE_STALE_MS ? 'interrupted' : 'working';
}

function entry(id, { meta, parsed, birth, mtime }, now, detail) {
  const status = nativeStatus(parsed.phase, mtime, now);
  const title = oneLine(meta.description, 80) || oneLine(parsed.prompt.split('\n')[0], 80) || meta.agentType || 'Subagent';
  const out = {
    id, native: true, title,
    agentType: typeof meta.agentType === 'string' ? meta.agentType : null,
    model: parsed.model ?? (typeof meta.model === 'string' ? meta.model : null),
    status, startedAt: Math.round(parsed.startedAt ?? birth), updatedAt: Math.round(mtime),
    branch: typeof meta.worktreeBranch === 'string' ? meta.worktreeBranch : null,
    toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : null,
    last: oneLine(status === 'working' ? parsed.activity.at(-1) : parsed.result || parsed.activity.at(-1), 200),
  };
  if (!detail) return out;
  return {
    ...out, result: clipText(parsed.result), activity: parsed.activity,
    task: clipText(parsed.prompt).slice(0, 1200),
    worktree: typeof meta.worktreePath === 'string' ? meta.worktreePath : null,
  };
}

/**
 * The subagents under `dir`, oldest first: the newest MAX_AGENTS runs, each
 * a read-only card. A missing folder is simply none.
 */
export async function nativeSubagents(dir, { now = Date.now(), limit = MAX_AGENTS } = {}) {
  if (!dir) return [];
  let names;
  try { names = await readdir(dir); } catch { return []; }
  // Pick the newest by mtime before opening any: a folder of hundreds of
  // old runs costs a stat each, not a read each.
  const files = [];
  for (const name of names) {
    const id = AGENT_FILE.exec(name)?.[1];
    if (!id) continue;
    try { files.push({ id, info: await stat(join(dir, name)) }); } catch { /* vanished mid-scan */ }
  }
  const found = [];
  for (const { id, info } of files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, limit)) {
    try { found.push(entry(id, await readAgent(dir, id, info), now, false)); } catch { /* vanished or unreadable */ }
  }
  return found.sort((a, b) => a.startedAt - b.startedAt);
}

/** One subagent with its result and a short activity tail, or null. */
export async function nativeSubagent(dir, id, { now = Date.now() } = {}) {
  if (!dir || typeof id !== 'string' || !AGENT_ID.test(id)) return null;
  try { return entry(id, await readAgent(dir, id), now, true); } catch { return null; }
}

/** How many of these are still running. */
export const nativeWorking = (agents) => (agents ?? []).filter((a) => a.status === 'working').length;

/** Whether any is still running or waiting on an approval. */
export const nativeActive = (agents) => (agents ?? []).some((a) => a.status === 'working' || a.status === 'blocked');
