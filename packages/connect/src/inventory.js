import { readdir, stat, open } from 'node:fs/promises';
import { existsSync, readdirSync, readlinkSync, readFileSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { HOME, HELM_DIR, expand, collapse } from './paths.js';
import { ENGINES, isInteractiveProc } from './engines.js';
import { sessionActivity } from './transcript.js';
import { claudeLiveSessions, claudeLiveStatus } from './external-process.js';
import { processList, processCwd, openFiles } from './procinfo.js';
import { bareTitle } from './titles.js';
import { opencodeServiceSessions } from './opencode-service.js';

/**
 * Sessions that already exist on this machine, whether or not helm started
 * them.
 *
 * The point of the phone is to be a view onto all the work happening across
 * your machines - including the session you started by hand at the keyboard an
 * hour ago. Each CLI keeps its own history in its own format; this reads all of
 * them and presents one list.
 */

const PER_ENGINE = 40;

/**
 * Read the head of a file and hand back its first `wanted` lines.
 *
 * These histories run to megabytes, so we never read one whole. But a single
 * line can still be large - codex writes its entire system prompt into the
 * first record - so we grow the read until we have what we need.
 */
async function headLines(path, wanted = 1, cap = 1 << 20, info = {}) {
  const fh = await open(path, 'r');
  try {
    let size = 64 << 10;
    let text = '';
    while (true) {
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(size), 0, size, 0);
      text = buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      // The final fragment is only complete if we stopped on a newline.
      if (lines.length > wanted || bytesRead < size || size >= cap) {
        info.filled = bytesRead === size;
        return lines.slice(0, Math.max(wanted, lines.length - 1));
      }
      size = Math.min(size * 4, cap);
    }
  } finally {
    await fh.close();
  }
}

/**
 * headLines, parsed, and remembered. Every chat list asks for the opening
 * lines of a few hundred histories, and a history only ever grows at its end:
 * re-reading and re-parsing those openings (Codex puts its whole system
 * prompt in the first) was most of a pass. A read that filled its buffer
 * cannot change while the file is the same file and does not shrink; a short
 * file is read again once it changes size.
 */
const heads = new Map();
async function headRecords(path, wanted) {
  const st = await stat(path);
  const key = `${path}\0${wanted}`, file = `${st.dev}:${st.ino}`, hit = heads.get(key);
  if (hit && hit.file === file && (hit.filled ? st.size >= hit.size : st.size === hit.size)) return hit.records;
  const info = {};
  const records = (await headLines(path, wanted, undefined, info)).map(parse);
  heads.delete(key); heads.set(key, { file, size: st.size, filled: info.filled, records });
  if (heads.size > 4096) heads.delete(heads.keys().next().value);
  return records;
}

/**
 * The whole lines in the last `bytes` of a file: where a long history keeps
 * what it is doing now, without reading the megabytes before it.
 */
async function tailLines(path, bytes = 256 << 10) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(size - start), 0, size - start, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    // A read that starts mid-file starts mid-line.
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await fh.close();
  }
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

/**
 * One walk of /proc, shared by every lookup in an inventory pass. Answering
 * each transcript with its own walk cost ~40ms apiece - 80 Claude files made
 * the recent list take seconds of synchronous time. `inventory()` drops it
 * on the way in, so no pass sees a process table older than itself.
 */
let procSnap = null;
function procs() {
  if (procSnap) return procSnap;
  const list = processList();
  // Only processes that look like one of the CLIs. Reading every descriptor
  // of every process (a browser alone holds hundreds) was most of a chat
  // list pass on Linux too, not only for lsof on macOS. Names must stand
  // alone: a bare `pi` or `omp` matched every Chromium (`--crashpad-handler-pid`).
  const names = /(?:^|[\s/._@-])(?:claude|codex|opencode|devin|grok|cursor|pi|omp|muse|gemini|kimi|agy|antigravity)(?:$|[\s/._@-])/;
  const candidates = list.filter(({ argv }) => names.test(argv.slice(0, 3).join(' '))).map((p) => p.pid);
  const files = new Map();
  for (const f of openFiles(candidates, (path) => /\.(jsonl|db)$/.test(path))) {
    if (f.write && !files.has(f.path)) files.set(f.path, f.pid);
  }
  procSnap = { at: Date.now(), files, list };
  return procSnap;
}

/** The process holding a rollout open, when this OS exposes process fds. */
function writerPid(path) {
  return procs().files.get(path) ?? null;
}

/**
 * Interactive CLIs that can own a session without Helm knowing about them.
 *
 * Database-backed agents do not keep a session-specific file descriptor like
 * Codex and Claude do. On Linux the safe identity is instead the executable,
 * its working directory, and the fact that it is the interactive command (not
 * an ACP child, one-shot run, or shared server). Inventory assigns such a
 * process only to the newest session in that directory.
 *
 * Which argv counts as "interactive" is per-engine - ENGINES[id].proc - so a
 * `grok agent stdio` helm spawned itself, a `pi --mode rpc` wire process, or
 * a cursor-agent running as bare `node` never masquerade as a TUI someone
 * is typing into.
 */
function interactiveProcesses(engine) {
  const out = new Map();
  for (const { pid, argv } of procs().list) {
    try {
      if (!isInteractiveProc(engine, argv)) continue;
      const cwd = processCwd(pid);
      if (cwd && !out.has(cwd)) out.set(cwd, Number(pid));
    } catch { /* process exited or belongs to another user */ }
  }
  return out;
}

/** Newest files first, capped - we never want to stat an entire history. */
async function newest(dir, filter, limit, required = () => false) {
  const out = [];
  const walk = async (d, depth = 0) => {
    if (depth > 5) return;
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (filter(e.name)) {
        try { out.push({ path: full, mtime: (await stat(full)).mtimeMs }); } catch { /* vanished */ }
      }
    }
  };
  await walk(dir);
  const sorted = out.sort((a, b) => b.mtime - a.mtime);
  return sorted.filter((f, i) => i < limit || required(f.path));
}

// -------------------------------------------------------------------- codex

async function codex(home, account, limit) {
  const codexHome = expand(home);
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return [];

  // The index carries human titles; the rollouts carry the working directory.
  const titles = new Map();
  const indexFile = join(expand(home), 'session_index.jsonl');
  if (existsSync(indexFile)) {
    try {
      const fh = await open(indexFile, 'r');
      const text = await fh.readFile('utf8');
      await fh.close();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.id) titles.set(r.id, r.thread_name);
        } catch { /* partial write at the tail */ }
      }
    } catch { /* index is a nicety, not a requirement */ }
  }

  let locked = [];
  try { locked = readdirSync(join(codexHome, 'thread-writer-locks')).filter(x => x.endsWith('.lock')).map(x => x.slice(0, -5)); } catch {}
  const files = await newest(root, (n) => n.endsWith('.jsonl'), limit,
    path => procs().files.has(path) || locked.some(id => path.endsWith(`${id}.jsonl`)));
  const out = [];
  for (const f of files) {
    try {
      const meta = (await headRecords(f.path, 1))[0];
      if (meta?.type !== 'session_meta') continue;
      const p = meta.payload ?? {};
      // Codex native children write their own rollouts too. SessionSource
      // serializes SubAgent as {subagent: ...}; these belong to the parent's
      // task timeline, not another row in the owner's recent history.
      if ((p.source && typeof p.source === 'object' && Object.hasOwn(p.source, 'subagent'))
        || p.thread_source === 'subagent' || p.threadSource === 'subagent') continue;
      const pid = writerPid(f.path);
      const active = !!pid || existsSync(join(codexHome, 'thread-writer-locks', `${p.session_id ?? p.id}.lock`));
      out.push({
        engine: 'codex',
        account,
        id: p.session_id ?? p.id,
        title: titles.get(p.session_id ?? p.id) || basename(p.cwd ?? '') || 'Codex chat',
        cwd: collapse(p.cwd ?? HOME),
        updatedAt: f.mtime,
        // Kept machine-side by the inventory RPC. Sessions uses the exact
        // file to monitor a CLI that still owns this thread; guessing the
        // newest transcript in the folder can select an unrelated chat.
        transcript: f.path,
        active,
        writerPid: pid,
      });
    } catch { /* not a rollout we understand */ }
  }
  return out;
}

// ------------------------------------------------------------------- claude

async function claude(home, account, limit) {
  const root = join(expand(home), 'projects');
  if (!existsSync(root)) return [];

  const live = claudeLiveSessions(home);
  const files = await newest(root, (n) => n.endsWith('.jsonl'), limit * 2,
    path => live.has(basename(path, '.jsonl')));
  const out = [];
  for (const f of files) {
    if (f.path.includes('/subagents/')) continue;
    const id = basename(f.path, '.jsonl');
    if (out.length >= limit && !live.has(id)) continue;
    let cwd = null;
    let title = '';
    let sidechain = false;

    // Claude records the working directory and the opening message on the
    // first real turn; the leading lines are session bookkeeping.
    for (const r of await headRecords(f.path, 24)) {
      if (!r) continue;
      if (r.summary) title ||= String(r.summary);
      if (r.type !== 'user') continue;
      if (r.isSidechain) { sidechain = true; break; }
      cwd ??= r.cwd;
      const content = r.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.find((c) => c?.type === 'text')?.text ?? ''
          : '';
      // A chat helm started opens with helm's own notes to the agent; the
      // name belongs to what the owner typed after them.
      const said = text.replace(/^(?:\[helm [^\]\n]*\]\n\n)+/, '').trim();
      if (said && !said.startsWith('<')) { title ||= said; break; }
    }
    // A sidechain file is a subagent's transcript, not a session you resume.
    if (sidechain || !cwd) continue;

    const owners = live.get(id) ?? [];
    const pid = owners[0]?.pid ?? writerPid(f.path);
    out.push({
      engine: 'claude',
      account,
      id,
      title: title.replace(/\s+/g, ' ').slice(0, 90) || basename(cwd),
      cwd: collapse(cwd),
      updatedAt: f.mtime,
      transcript: f.path,
      active: !!pid,
      writerPid: pid,
      liveStatus: claudeLiveStatus(owners),
    });
  }
  return out;
}

// ------------------------------------------------------------------- devin

function devin(home, account, limit) {
  // Devin's CLI keeps a real database like opencode's, one directory deeper:
  // <XDG_DATA_HOME>/<account dir>/cli/sessions.db. Its clock is seconds, not
  // the milliseconds everything else here reports.
  const base = process.env.XDG_DATA_HOME || join(HOME, '.local', 'share');
  const candidates = [];
  try {
    for (const d of readdirSync(base)) {
      if (d.startsWith('devin')) candidates.push(join(base, d, 'cli', 'sessions.db'));
    }
  } catch { /* no XDG data dir here */ }

  const out = [];
  const active = interactiveProcesses('devin');
  const claimed = new Set();
  for (const db of candidates) {
    if (!existsSync(db)) continue;
    try {
      const conn = new DatabaseSync(db, { readOnly: true });
      // `hidden` is recent enough that a CLI a few versions old lacks it;
      // select it only if it is there rather than lose the store over a flag.
      let rows;
      try {
        rows = conn.prepare(
          `SELECT id, title, working_directory, model, last_activity_at, hidden
             FROM sessions ORDER BY last_activity_at DESC LIMIT ?`
        ).all(Number.isFinite(limit) ? limit : -1);
      } catch {
        rows = conn.prepare(
          `SELECT id, title, working_directory, model, last_activity_at, 0 AS hidden
             FROM sessions ORDER BY last_activity_at DESC LIMIT ?`
        ).all(Number.isFinite(limit) ? limit : -1);
      }
      const acct = `${account}:${basename(join(db, '..', '..'))}`;
      for (const r of rows) {
        if (r.hidden) continue;
        const at = Number(r.last_activity_at) || 0;
        const cwd = r.working_directory ?? HOME;
        const pid = active.get(cwd);
        const isActive = !!pid && !claimed.has(cwd);
        if (isActive) claimed.add(cwd);
        out.push({
          engine: 'devin',
          account: acct,
          id: r.id,
          title: r.title || basename(r.working_directory ?? '') || 'Devin chat',
          cwd: collapse(cwd),
          updatedAt: at < 1e12 ? at * 1000 : at,
          model: r.model,
          transcript: db,
          active: isActive,
          writerPid: isActive ? pid : null,
        });
      }
      conn.close();
    } catch { /* a locked or half-migrated db is not worth failing over */ }
  }
  return out;
}

// ----------------------------------------------------------------- opencode

/**
 * opencode stores the model as a JSON object, not a name:
 * `{"id":"…","providerID":"…","variant":"…"}`. Passed through whole, it landed
 * in the session list where the model goes and filled the row with JSON.
 */
const opencodeModel = (v) => {
  if (typeof v !== 'string' || !v) return null;
  if (!v.startsWith('{')) return v;
  try { return JSON.parse(v).id ?? null; } catch { return null; }
};

async function opencode(home, account, engine = 'opencode', limit, separateV1 = true) {
  // opencode keeps a real database, so this is the one engine where we get
  // titles, cost and model without parsing anything.
  const base = process.env.XDG_DATA_HOME || join(HOME, '.local', 'share');
  const candidates = [];
  try {
    for (const d of readdirSync(base)) {
      if (d.startsWith('opencode')) candidates.push(join(base, d, 'opencode.db'));
    }
  } catch { /* no XDG data dir here */ }

  const out = [];
  const service = engine === 'opencode2' ? await opencodeServiceSessions() : new Map();
  const active = service.available ? new Map() : interactiveProcesses(engine);
  const claimed = new Set();
  for (const db of candidates) {
    if (!existsSync(db)) continue;
    try {
      const conn = new DatabaseSync(db, { readOnly: true });
      let rows;
      try {
        if (engine === 'opencode2') {
          // Keep migrated history reachable when V1 is no longer installed.
          // With both engines present, V1 lists its history; a live V2 owner
          // still wins for a migrated conversation currently resumed there.
          const hasV1 = !!conn.prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session'`
          ).get();
          rows = conn.prepare(
            `SELECT id, title, directory, time_updated, agent, model
               FROM session_v2
              ${hasV1 && separateV1 ? `WHERE id NOT IN (SELECT id FROM session)${service.size ? ` OR id IN (${[...service].map(() => '?').join(',')})` : ''}` : ''}
              ORDER BY time_updated DESC`
          ).all(...(hasV1 && separateV1 ? service.keys() : []));
        } else {
          rows = conn.prepare(
            `SELECT id, title, directory, time_updated, agent, model
               FROM session ORDER BY time_updated DESC`
          ).all();
        }
      } catch {
        if (engine === 'opencode2') {
          conn.close();
          continue;
        }
        // OpenCode 2 stores model/agent in message.data and keeps aggregate
        // token columns on session. Inventory only needs the stable fields.
        rows = conn.prepare(
          `SELECT id, title, directory, time_updated, NULL AS agent, NULL AS model
             FROM session ORDER BY time_updated DESC`
        ).all();
      }
      for (const [index, r] of rows.entries()) {
        if (index >= limit && !service.has(r.id) && (!active.has(r.directory) || claimed.has(r.directory))) continue;
        const cwd = r.directory ?? HOME;
        const pid = active.get(cwd);
        const shared = service.has(r.id);
        const isActive = shared || (!!pid && !claimed.has(cwd));
        if (isActive) claimed.add(cwd);
        out.push({
          engine,
          account: `${account}:${basename(join(db, '..'))}`,
          id: r.id,
          title: r.title || (engine === 'opencode2' ? 'OpenCode 2 chat' : 'opencode chat'),
          cwd: collapse(cwd),
          updatedAt: Number(r.time_updated) || 0,
          model: opencodeModel(r.model),
          transcript: db,
          active: isActive,
          writerPid: shared ? null : isActive ? pid : null,
          ...(shared ? { serviceActive: true, liveStatus: service.get(r.id) } : {}),
        });
      }
      conn.close();
    } catch { /* a locked or half-migrated db is not worth failing over */ }
  }
  return out;
}

// ----------------------------------------------------------------- pi / omp

/**
 * The model and thinking level a pi-family conversation runs with - what
 * the CLI itself picks back up when the conversation is resumed. Neither is
 * in the header: a `model_change` / `thinking_level_change` record says when
 * the owner switched, and every reply names the model that wrote it. The
 * latest of either wins, written the way pi takes it (`provider/id`).
 */
const piSeen = new Map();
async function piSettings(path) {
  // Remembered until the history changes: it is read whole on every pass.
  let stamp = '';
  try { const st = await stat(path); stamp = `${st.size}:${st.mtimeMs}`; } catch { /* read below says so */ }
  const hit = piSeen.get(path);
  if (stamp && hit?.stamp === stamp) return hit.value;
  const value = await readPiSettings(path);
  if (stamp) { piSeen.delete(path); piSeen.set(path, { stamp, value }); if (piSeen.size > 1024) piSeen.delete(piSeen.keys().next().value); }
  return value;
}
async function readPiSettings(path) {
  let model;
  let effort;
  const take = (r) => {
    if (r?.type === 'model_change' && r.modelId) model = r.provider ? `${r.provider}/${r.modelId}` : r.modelId;
    else if (r?.type === 'thinking_level_change' && r.thinkingLevel) effort = r.thinkingLevel;
    else if (r?.type === 'message' && r.message?.role === 'assistant') {
      const m = r.message;
      if (m.model) model = m.provider ? `${m.provider}/${m.model}` : m.model;
      if (m.thinkingLevel) effort = m.thinkingLevel;
    }
  };
  try {
    // A short history is read whole; a long one by its start and its end.
    const tail = 256 << 10;
    const { size } = await stat(path);
    const lines = size > tail ? [...await headLines(path, 40), ...await tailLines(path, tail)] : await tailLines(path, tail);
    for (const line of lines) take(parse(line));
  } catch { /* unreadable: say nothing rather than guess */ }
  return { model, effort };
}

/**
 * Pi-family session logs: <home>/sessions/<dash-cwd>/<ts>_<uuid>.jsonl, whose
 * header record carries `id` and `cwd` outright. omp writes an extra `title`
 * record first. A live writer either holds the file open or shows up as an
 * interactive process in the session's directory.
 */
async function piFamily(engine, home, account, limit) {
  const root = join(expand(home), ENGINES[engine]?.sessionsDir ?? 'sessions');
  if (!existsSync(root)) return [];

  const files = await newest(root, (n) => n.endsWith('.jsonl'), limit * 2);
  const active = interactiveProcesses(engine);
  const claimed = new Set();
  const out = [];
  for (const f of files) {
    try {
      let meta = null;
      let title = '';
      for (const r of await headRecords(f.path, 40)) {
        if (!r) continue;
        if (r.type === 'session') meta = r;
        else if (r.type === 'title' && r.title) title ||= String(r.title);
        else if (r.type === 'session_name' && r.name) title ||= String(r.name);
        else if (r.type === 'message' && !title) {
          const msg = r.message;
          if (msg?.role === 'user') {
            const text = Array.isArray(msg.content)
              ? msg.content.find((c) => c?.type === 'text')?.text ?? ''
              : String(msg.content ?? '');
            if (text.trim()) title = text.trim();
          }
        }
        if (meta?.id && title) break;
      }
      if (!meta?.id) continue;
      const cwd = meta.cwd ?? meta.workingDirectory ?? HOME;
      const { model, effort } = await piSettings(f.path);
      let pid = writerPid(f.path);
      if (!pid) {
        const p = active.get(cwd);
        if (p && !claimed.has(cwd)) { claimed.add(cwd); pid = p; }
      }
      out.push({
        engine,
        account,
        id: meta.id,
        title: title.replace(/\s+/g, ' ').slice(0, 90) || basename(cwd),
        cwd: collapse(cwd),
        updatedAt: f.mtime,
        model,
        effort,
        transcript: f.path,
        active: !!pid,
        writerPid: pid,
      });
      if (out.length >= limit) break;
    } catch { /* not a session log we understand */ }
  }
  return out;
}

// -------------------------------------------------------------------- grok

/**
 * Grok keeps one directory per session under sessions/<encoded cwd>/<uuid>:
 * summary.json holds id, cwd, model and message counts, chat_history.jsonl
 * the conversation. active_sessions.json names the ids with a live process.
 */
async function grok(home, account, limit) {
  const root = join(expand(home), 'sessions');
  if (!existsSync(root)) return [];

  const activeIds = new Set();
  try {
    const live = JSON.parse(readFileSync(join(expand(home), 'active_sessions.json'), 'utf8'));
    for (const e of Array.isArray(live) ? live : []) {
      const id = typeof e === 'string' ? e : e?.id ?? e?.session_id ?? e?.info?.id;
      if (id) activeIds.add(id);
    }
  } catch { /* absent between runs */ }

  const summaries = await newest(root, (n) => n === 'summary.json', limit * 2);
  const active = interactiveProcesses('grok');
  const claimed = new Set();
  const out = [];
  for (const f of summaries) {
    try {
      const s = JSON.parse(readFileSync(f.path, 'utf8'));
      const id = s?.info?.id ?? s?.id;
      if (!id) continue;
      const cwd = s.info?.cwd ?? HOME;
      const transcript = join(f.path, '..', 'chat_history.jsonl');
      let pid = existsSync(transcript) ? writerPid(transcript) : null;
      if (!pid && activeIds.has(id)) {
        const p = active.get(cwd);
        if (p && !claimed.has(cwd)) { claimed.add(cwd); pid = p; }
      }
      out.push({
        engine: 'grok',
        account,
        id,
        title: (s.session_summary || '').replace(/\s+/g, ' ').slice(0, 90) || basename(cwd),
        cwd: collapse(cwd),
        updatedAt: Date.parse(s.updated_at ?? '') || f.mtime,
        model: s.current_model_id ?? undefined,
        transcript: existsSync(transcript) ? transcript : null,
        // The id list says the session is live; it still only counts when a
        // process can be pinned to it - the monitor needs an owner to watch.
        active: !!pid,
        writerPid: pid,
      });
      if (out.length >= limit) break;
    } catch { /* a summary we do not understand */ }
  }
  return out;
}

// ------------------------------------------------------------------ cursor

/**
 * Cursor keeps one directory per chat under chats/<projectHash>/<chatId>:
 * meta.json carries title, cwd and timestamps; store.db is a protobuf blob
 * store helm does not decode. acp-sessions/<id> is the same record kept by
 * `cursor-agent acp` runs.
 */
async function cursor(home, account, limit) {
  const out = [];
  const active = interactiveProcesses('cursor');
  const claimed = new Set();

  const readMeta = (dir, depth = 0) => {
    const rows = [];
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return rows; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory() && depth < 3) rows.push(...readMeta(full, depth + 1));
      else if (e.isFile() && e.name === 'meta.json') rows.push(full);
    }
    return rows;
  };

  for (const base of ['chats', 'acp-sessions']) {
    const root = join(expand(home), base);
    if (!existsSync(root)) continue;
    for (const file of readMeta(root)) {
      try {
        const m = JSON.parse(readFileSync(file, 'utf8'));
        if (!m?.cwd || m.hasConversation === false) continue;
        const id = basename(join(file, '..'));
        const cwd = m.cwd;
        const store = join(file, '..', 'store.db');
        let pid = existsSync(store) ? writerPid(store) : null;
        if (!pid) {
          const p = active.get(cwd);
          if (p && !claimed.has(cwd)) { claimed.add(cwd); pid = p; }
        }
        out.push({
          engine: 'cursor',
          account,
          id,
          title: (m.title || '').replace(/\s+/g, ' ').slice(0, 90) || basename(cwd),
          cwd: collapse(cwd),
          updatedAt: Number(m.updatedAtMs ?? m.updated_at ?? 0) || (() => { try { return statSync(file).mtimeMs; } catch { return 0; } })(),
          transcript: existsSync(store) ? store : null,
          active: !!pid,
          writerPid: pid,
        });
      } catch { /* a meta we do not understand */ }
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

// --------------------------------------------------------------------- agy

/**
 * Antigravity keeps one protobuf-step database per conversation under
 * conversations/<id>.db plus a flat index, conversation_summaries.db, that
 * carries everything inventory needs: id, generated title, workspace URIs,
 * last-write time and an idle flag. The step payloads are protobuf, so the
 * conversation db is only useful as a writer-lock handle - not a transcript.
 */
async function agy(home, account, limit) {
  // `home` is the gemini root (GEMINI_CLI_HOME); agy's own store sits under
  // it, but tolerate being handed the store directory itself.
  const root = basename(expand(home)) === 'antigravity-cli' ? expand(home) : join(expand(home), 'antigravity-cli');
  const db = join(root, 'conversation_summaries.db');
  if (!existsSync(db)) return [];

  const active = interactiveProcesses('agy');
  const claimed = new Set();
  const out = [];
  try {
    const conn = new DatabaseSync(db, { readOnly: true });
    const rows = conn.prepare(
      `SELECT conversation_id, title, preview, workspace_uris,
              last_modified_time, not_fully_idle, killed
         FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?`
    ).all(Number.isFinite(limit) ? limit : -1);
    conn.close();
    for (const r of rows) {
      const id = r.conversation_id;
      if (!id) continue;
      let cwd = HOME;
      try {
        const uris = JSON.parse(r.workspace_uris ?? '[]');
        const uri = Array.isArray(uris) ? uris[0] : uris;
        if (typeof uri === 'string' && uri) cwd = decodeURIComponent(uri.replace(/^file:\/\//, ''));
      } catch { /* a bare path, or nothing */ }
      const conv = join(root, 'conversations', `${id}.db`);
      let pid = existsSync(conv) ? writerPid(conv) : null;
      if (!pid) {
        const p = active.get(cwd);
        if (p && !claimed.has(cwd)) { claimed.add(cwd); pid = p; }
      }
      // 'YYYY-MM-DD HH:MM:SS.nnnnnnnnn+00:00' - Date.parse chokes on the
      // nanosecond fraction, so it is trimmed to milliseconds first.
      const stamp = String(r.last_modified_time ?? '');
      const updatedAt = Date.parse(stamp.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')) || 0;
      out.push({
        engine: 'agy',
        account,
        id,
        title: (r.title || r.preview || '').replace(/\s+/g, ' ').slice(0, 90) || basename(cwd),
        cwd: collapse(cwd),
        updatedAt,
        transcript: existsSync(conv) ? conv : null,
        // The flag describes activity, but is trusted only while a process
        // owns this conversation. A stale database flag cannot revive it.
        active: !!pid && !r.killed,
        liveStatus: r.not_fully_idle == null ? null
          : Number(r.not_fully_idle) === 1 ? 'working' : Number(r.not_fully_idle) === 0 ? 'idle' : null,
        writerPid: pid,
      });
    }
  } catch { /* schema drift or a locked db is not worth failing over */ }
  return out;
}

// ------------------------------------------------------------- antigravity

/**
 * The managed ACP agent keeps one sqlite database per conversation under
 * <GEMINI_HOME>/antigravity-acp/conversations/<id>.db, with a sibling
 * <id>.meta carrying the session's cwd as JSON. There is no title table -
 * the row names the folder it worked in, and the .db is the writer-lock
 * handle for liveness, same deal as agy's protobuf store.
 */
async function antigravity(home, account, limit) {
  const root = join(expand(home), 'antigravity-acp', 'conversations');
  if (!existsSync(root)) return [];

  const active = interactiveProcesses('antigravity');
  const claimed = new Set();
  const out = [];
  // The .db's mtime is the recency signal, so it is what gets sorted and
  // capped - an unsorted readdir page could keep the newest conversation
  // out of the list entirely.
  for (const f of await newest(root, (n) => n.endsWith('.db'), limit * 2)) {
    const id = basename(f.path, '.db');
    const conv = f.path;
    let cwd = HOME;
    try {
      const m = JSON.parse(readFileSync(join(root, `${id}.meta`), 'utf8'));
      if (typeof m.cwd === 'string' && m.cwd) cwd = m.cwd;
    } catch { /* a db without a readable meta */ }
    const dir = cwd;
    let pid = writerPid(conv);
    if (!pid) {
      const p = active.get(dir);
      if (p && !claimed.has(dir)) { claimed.add(dir); pid = p; }
    }
    out.push({
      engine: 'antigravity',
      account,
      id,
      title: basename(dir) || 'Antigravity chat',
      cwd: collapse(dir),
      updatedAt: Math.floor(f.mtime),
      transcript: conv,
      active: !!pid,
      writerPid: pid,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// -------------------------------------------------------------------- muse

/**
 * Muse logs at <XDG data>/muse/sessions/YYYY/MM/DD/<uuid>/session.jsonl, a
 * record-per-line event log. The rows helm needs - an id, a directory, a
 * title - ride ordinary record fields; anything absent stays absent rather
 * than guessed.
 */
async function muse(home, account, limit) {
  const base = process.env.XDG_DATA_HOME || join(HOME, '.local', 'share');
  const root = join(base, 'muse', 'sessions');
  if (!existsSync(root)) return [];

  const files = await newest(root, (n) => n === 'session.jsonl', limit);
  const active = interactiveProcesses('muse');
  const claimed = new Set();
  const out = [];
  for (const f of files) {
    try {
      let cwd = null;
      let title = '';
      for (const r of await headRecords(f.path, 30)) {
        if (!r) continue;
        const rec = r.record ?? r;
        cwd ??= rec.cwd ?? rec.workdir ?? rec.working_directory ?? rec.root;
        if (!title) {
          const text = rec.text ?? rec.prompt ?? rec.message;
          if (typeof text === 'string' && text.trim() && !text.startsWith('<')) title = text.trim();
        }
        if (cwd && title) break;
      }
      const dir = cwd ?? HOME;
      const id = basename(join(f.path, '..'));
      let pid = writerPid(f.path);
      if (!pid) {
        const p = active.get(dir);
        if (p && !claimed.has(dir)) { claimed.add(dir); pid = p; }
      }
      out.push({
        engine: 'muse',
        account,
        id,
        title: title.replace(/\s+/g, ' ').slice(0, 90) || (cwd ? basename(cwd) : 'Muse chat'),
        cwd: collapse(dir),
        updatedAt: f.mtime,
        transcript: f.path,
        active: !!pid,
        writerPid: pid,
      });
    } catch { /* not a session log we understand */ }
  }
  return out;
}

// ---------------------------------------------------------------- public API

/**
 * Every past session this machine knows about, newest first.
 * @param {Array} profiles  so we scan each configured account, not just the default
 */
/**
 * A chat that ran under the system's temporary folder is a test or a check
 * someone's tool made - a sandboxed daemon, a "reply with ok" probe - not a
 * conversation the owner had. Left in, they bury the owner's own chats under
 * rows named "tmp" and "scratchpad", which is what the owner complained of.
 * Applied where the daemon hands rows to the owner (agent.js, sessions.js),
 * not here: this module's tests build their fixtures under that folder.
 */
export function scratchFolder(cwd) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const dir = resolve(expand(cwd));
  // Helm's own folders too: a helper's worktree or a deleted quick chat's
  // scratch folder is Helm's business, never a chat the owner started.
  for (const root of [resolve(tmpdir()), resolve(HELM_DIR)]) {
    if (dir === root || dir.startsWith(root + '/')) return true;
  }
  return false;
}

export async function inventory(profiles = [], { limit = PER_ENGINE } = {}) {
  procSnap = null;
  const seen = new Set();
  const jobs = [];

  for (const p of profiles) {
    const engine = ENGINES[p.engine];
    if (!engine || engine.plain) continue;

    const home = p.env?.[engine.homeEnv] ?? engine.defaultHome;
    const key = `${p.engine}:${home}`;
    if (seen.has(key)) continue; // two aliases onto the same account
    seen.add(key);

    if (p.engine === 'codex') jobs.push(codex(home, p.id, limit));
    else if (p.engine === 'claude') jobs.push(claude(home, p.id, limit));
    else if (p.engine === 'opencode' || p.engine === 'opencode2') {
      jobs.push(Promise.resolve(opencode(home, p.id, p.engine, limit, profiles.some((p) => p.engine === 'opencode'))));
    }
    else if (p.engine === 'devin') jobs.push(Promise.resolve(devin(home, p.id, limit)));
    else if (p.engine === 'pi' || p.engine === 'omp') jobs.push(piFamily(p.engine, home, p.id, limit));
    else if (p.engine === 'grok') jobs.push(grok(home, p.id, limit));
    else if (p.engine === 'cursor') jobs.push(Promise.resolve(cursor(home, p.id, limit)));
    else if (p.engine === 'agy') jobs.push(Promise.resolve(agy(home, p.id, limit)));
    else if (p.engine === 'antigravity') jobs.push(Promise.resolve(antigravity(home, p.id, limit)));
    else if (p.engine === 'muse') jobs.push(muse(home, p.id, limit));
  }

  const all = (await Promise.allSettled(jobs)).flatMap((r) => r.status === 'fulfilled' ? r.value : []);
  await Promise.all(all.map(async (s) => Object.assign(s, await sessionActivity({
    engine: s.engine, path: s.transcript, sessionId: s.id, active: s.active, updatedAt: s.updatedAt,
    liveStatus: s.liveStatus,
  }))));
  // The sqlite readers scan shared data dirs, so a second account of the same
  // engine returns the same rows; the id, not the account, says which they are.
  const known = new Set();
  for (const s of all) if (s.title) s.title = bareTitle(s.title) || s.title;
  return all
    .filter((s) => s.id)
    .filter((s) => {
      const key = `${s.engine}:${s.id}`;
      if (known.has(key)) return false;
      known.add(key);
      return true;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Page only after owner-visible filters, so hidden test chats do not consume a page. */
export function inventoryPage(rows, { limit = 40, query = '', visible = () => true } = {}) {
  const size = Number.isSafeInteger(limit) && limit > 0 ? limit : 40;
  const search = String(query).trim().toLowerCase();
  const matches = rows.filter(visible).filter((s) => {
    const text = `${s.title} ${s.cwd} ${ENGINES[s.engine]?.label ?? s.engine}`.toLowerCase();
    return text.includes(search);
  });
  const recent = matches.slice(0, size);
  const included = new Set(recent);
  return { recent: [...recent, ...matches.filter((s) => s.active && !included.has(s))], hasMore: matches.length > size };
}
