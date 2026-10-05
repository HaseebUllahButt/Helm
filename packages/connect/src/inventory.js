import { readdir, stat, open } from 'node:fs/promises';
import { existsSync, readdirSync, readlinkSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOME, expand, collapse } from './paths.js';
import { ENGINES, isInteractiveProc } from './engines.js';
import { sessionActivity } from './transcript.js';
import { promptTitle } from './titles.js';

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
async function headLines(path, wanted = 1, cap = 1 << 20) {
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
        return lines.slice(0, Math.max(wanted, lines.length - 1));
      }
      size = Math.min(size * 4, cap);
    }
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
  const files = new Map();
  const list = [];
  let pids = [];
  try { pids = readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch { /* not Linux */ }
  for (const pid of pids) {
    const dir = `/proc/${pid}/fd`;
    try {
      for (const fd of readdirSync(dir)) {
        try {
          const target = readlinkSync(join(dir, fd));
          if (target.startsWith('/') && !files.has(target)) files.set(target, Number(pid));
        } catch { /* fd closed */ }
      }
    } catch { /* another user's, or gone */ }
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      if (argv.length) list.push({ pid: Number(pid), argv });
    } catch { /* gone */ }
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
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (!out.has(cwd)) out.set(cwd, Number(pid));
    } catch { /* process exited or belongs to another user */ }
  }
  return out;
}

/** Newest files first, capped - we never want to stat an entire history. */
async function newest(dir, filter, limit) {
  const out = [];
  const walk = async (d, depth = 0) => {
    if (depth > 5) return;
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (filter(e.name)) {
        try {
          const s = await stat(full);
          out.push({ path: full, mtime: s.mtimeMs, size: s.size });
        } catch { /* vanished */ }
      }
    }
  };
  await walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// -------------------------------------------------------------------- codex

/**
 * The names Codex itself gave its threads.
 *
 * Two stores, because Codex moved: `session_index.jsonl` carried
 * `thread_name` for TUI sessions, and the newer `state_<n>.sqlite` keeps a
 * `threads` table whose `name` is the generated name and whose `title` is
 * the opening message. The index only ever covered about half the rollouts
 * on this laptop, which is why so many rows were named for their folder.
 */
async function codexNames(codexHome) {
  const names = new Map(); // id -> { name, prompt }
  const indexFile = join(codexHome, 'session_index.jsonl');
  if (existsSync(indexFile)) {
    try {
      const fh = await open(indexFile, 'r');
      const text = await fh.readFile('utf8');
      await fh.close();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.id && r.thread_name) names.set(r.id, { name: String(r.thread_name), prompt: '' });
        } catch { /* partial write at the tail */ }
      }
    } catch { /* index is a nicety, not a requirement */ }
  }
  let db = null;
  try {
    db = readdirSync(codexHome)
      .filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0] ?? null;
  } catch { /* no home */ }
  if (!db) return names;
  try {
    const conn = new DatabaseSync(join(codexHome, db), { readOnly: true });
    try {
      let rows;
      try {
        rows = conn.prepare('SELECT id, name, title, first_user_message FROM threads').all();
      } catch {
        rows = conn.prepare('SELECT id, NULL AS name, title, NULL AS first_user_message FROM threads').all();
      }
      for (const r of rows) {
        if (!r.id) continue;
        const prior = names.get(r.id);
        names.set(r.id, {
          name: (r.name && String(r.name).trim()) || prior?.name || '',
          // A thread helm started opens with helm's own notes to the agent;
          // the name belongs to what the owner typed after them.
          prompt: String(r.first_user_message || r.title || '').replace(/^(?:\[helm [^\]\n]*\]\n\n)+/, ''),
        });
      }
    } finally { conn.close(); }
  } catch { /* a locked or half-migrated db is not worth failing over */ }
  return names;
}

async function codex(home, account) {
  const codexHome = expand(home);
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return [];

  // Codex's own names live beside the rollouts; the rollouts carry the
  // working directory.
  const names = await codexNames(codexHome);

  const files = await newest(root, (n) => n.endsWith('.jsonl'), PER_ENGINE);
  const out = [];
  for (const f of files) {
    try {
      const meta = parse((await headLines(f.path, 1))[0]);
      if (meta?.type !== 'session_meta') continue;
      const p = meta.payload ?? {};
      // Codex native children write their own rollouts too. SessionSource
      // serializes SubAgent as {subagent: ...}; these belong to the parent's
      // task timeline, not another row in the owner's recent history.
      if ((p.source && typeof p.source === 'object' && Object.hasOwn(p.source, 'subagent'))
        || p.thread_source === 'subagent' || p.threadSource === 'subagent') continue;
      const active = existsSync(join(codexHome, 'thread-writer-locks', `${p.session_id ?? p.id}.lock`));
      const own = names.get(p.session_id ?? p.id);
      out.push({
        engine: 'codex',
        account,
        id: p.session_id ?? p.id,
        title: own?.name || promptTitle([own?.prompt], 90) || basename(p.cwd ?? '') || 'codex session',
        // Set when the title is the CLI's own name for the thread, so a
        // helm record of it adopts that name rather than keeping its own.
        named: !!own?.name,
        cwd: collapse(p.cwd ?? HOME),
        updatedAt: f.mtime,
        // Kept machine-side by the inventory RPC. Sessions uses the exact
        // file to monitor a CLI that still owns this thread; guessing the
        // newest transcript in the folder can select an unrelated chat.
        transcript: f.path,
        active,
        writerPid: active ? writerPid(f.path) : null,
      });
    } catch { /* not a rollout we understand */ }
  }
  return out;
}

// ------------------------------------------------------------------- claude

/**
 * The name Claude Code gave a session.
 *
 * The CLI writes it into the transcript once the first reply is in -
 * `{"type":"ai-title","aiTitle":"…"}` - and `/rename` adds a
 * `{"type":"custom-title","customTitle":"…"}` later. Neither sits at a fixed
 * line: the whole first turn, tool calls included, comes before it. So each
 * file is scanned once, and after that only the bytes written since, keyed
 * on the path. `claude -p` (what helm drives) never writes one.
 */
const titleScans = new Map();
async function claudeTitle(path, size) {
  let scan = titleScans.get(path);
  if (!scan || scan.offset > size) scan = { offset: 0, ai: '', custom: '' };
  if (size > scan.offset) {
    const fh = await open(path, 'r');
    try {
      let carry = Buffer.alloc(0);
      let pos = scan.offset;
      const buf = Buffer.alloc(256 << 10);
      while (pos < size) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const chunk = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
        const cut = chunk.lastIndexOf(10);
        if (cut < 0) { carry = chunk; continue; }
        for (const line of chunk.subarray(0, cut).toString('utf8').split('\n')) {
          if (!line.includes('-title"')) continue;
          const r = parse(line);
          if (r?.type === 'ai-title' && r.aiTitle) scan.ai = String(r.aiTitle);
          else if (r?.type === 'custom-title' && (r.customTitle ?? r.title)) scan.custom = String(r.customTitle ?? r.title);
        }
        carry = Buffer.from(chunk.subarray(cut + 1));
        // A torn final line is read again next time, once it is whole.
        scan.offset = pos - carry.length;
      }
    } finally {
      await fh.close();
    }
    titleScans.set(path, scan);
    if (titleScans.size > 512) titleScans.delete(titleScans.keys().next().value);
  }
  return scan.custom || scan.ai || '';
}

/**
 * Whether `pid` is still the process a record was written for. Claude's
 * records carry the kernel start time of the process (`procStart`, field
 * 22 of /proc/<pid>/stat), which is what tells a live session from a
 * recycled pid. Where /proc is not there, existence is all there is.
 */
function processIs(pid, procStart) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  if (procStart == null || procStart === '') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is parenthesised and may contain spaces; the fields
    // after the closing paren start at field 3.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return after[19] === String(procStart);
  } catch { return true; }
}

/**
 * Claude Code does not hold its transcript open - it appends and closes -
 * so the open-file walk never sees it, and a session typed at a keyboard
 * looked finished the moment it was listed. What the CLI does keep is one
 * record per live process, <home>/sessions/<pid>.json, naming the session
 * id, the folder and the process start token, removed when it exits.
 */
function claudeLive(home) {
  const out = new Map(); // sessionId -> { pid, cwd, entrypoint }
  const dir = join(expand(home), 'sessions');
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!r?.sessionId || !r.pid) continue;
      if (!processIs(Number(r.pid), r.procStart)) continue;
      out.set(String(r.sessionId), { pid: Number(r.pid), cwd: r.cwd, entrypoint: r.entrypoint });
    } catch { /* a torn write, or a record from a crash */ }
  }
  return out;
}

/**
 * Whether `pid` is the live Claude process writing `transcript`. Sessions
 * asks this before handing a keyboard session over to helm: a signal must
 * reach the process that owns the thread and nothing else.
 */
export function claudeProcessOwns(transcript, pid, sessionId) {
  if (!transcript || !pid || !sessionId) return false;
  // <home>/projects/<folder>/<id>.jsonl
  const home = resolve(transcript, '..', '..', '..');
  try {
    const r = JSON.parse(readFileSync(join(home, 'sessions', `${pid}.json`), 'utf8'));
    return String(r?.sessionId) === String(sessionId) && Number(r.pid) === Number(pid) && processIs(Number(pid), r.procStart);
  } catch { return false; }
}

async function claude(home, account) {
  const root = join(expand(home), 'projects');
  if (!existsSync(root)) return [];

  const files = await newest(root, (n) => n.endsWith('.jsonl'), PER_ENGINE * 2);
  const live = claudeLive(home);
  const out = [];
  for (const f of files) {
    let cwd = null;
    let title = '';
    let sidechain = false;

    // Claude records the working directory and the opening message on the
    // first real turn; the leading lines are session bookkeeping.
    for (const line of await headLines(f.path, 24)) {
      const r = parse(line);
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

    const id = basename(f.path, '.jsonl');
    const own = await claudeTitle(f.path, f.size ?? 0);
    const pid = writerPid(f.path) ?? live.get(id)?.pid ?? null;
    out.push({
      engine: 'claude',
      account,
      id,
      title: (own || title).replace(/\s+/g, ' ').slice(0, 90) || basename(cwd),
      named: !!own,
      cwd: collapse(cwd),
      updatedAt: f.mtime,
      transcript: f.path,
      active: !!pid,
      writerPid: pid,
    });
    if (out.length >= PER_ENGINE) break;
  }
  return out;
}

// ------------------------------------------------------------------- devin

function devin(home, account) {
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
        ).all(PER_ENGINE);
      } catch {
        rows = conn.prepare(
          `SELECT id, title, working_directory, model, last_activity_at, 0 AS hidden
             FROM sessions ORDER BY last_activity_at DESC LIMIT ?`
        ).all(PER_ENGINE);
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
          title: r.title || basename(r.working_directory ?? '') || 'devin session',
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

function opencode(home, account, engine = 'opencode') {
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
  const active = interactiveProcesses(engine);
  const claimed = new Set();
  for (const db of candidates) {
    if (!existsSync(db)) continue;
    try {
      const conn = new DatabaseSync(db, { readOnly: true });
      let rows;
      try {
        if (engine === 'opencode2') {
          // V2 backfills V1 rows into session_v2. Rows absent from the V1
          // table are the conversations created by the separate V2 client.
          const hasV1 = !!conn.prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session'`
          ).get();
          rows = conn.prepare(
            `SELECT id, title, directory, time_updated, agent, model
               FROM session_v2
              ${hasV1 ? 'WHERE id NOT IN (SELECT id FROM session)' : ''}
              ORDER BY time_updated DESC LIMIT ?`
          ).all(PER_ENGINE);
        } else {
          rows = conn.prepare(
            `SELECT id, title, directory, time_updated, agent, model
               FROM session ORDER BY time_updated DESC LIMIT ?`
          ).all(PER_ENGINE);
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
             FROM session ORDER BY time_updated DESC LIMIT ?`
        ).all(PER_ENGINE);
      }
      for (const r of rows) {
        const cwd = r.directory ?? HOME;
        const pid = active.get(cwd);
        const isActive = !!pid && !claimed.has(cwd);
        if (isActive) claimed.add(cwd);
        out.push({
          engine,
          account: `${account}:${basename(join(db, '..'))}`,
          id: r.id,
          title: r.title || (engine === 'opencode2' ? 'OpenCode 2 session' : 'opencode session'),
          cwd: collapse(cwd),
          updatedAt: Number(r.time_updated) || 0,
          model: opencodeModel(r.model),
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

// ----------------------------------------------------------------- pi / omp

/**
 * Pi-family session logs: <home>/sessions/<dash-cwd>/<ts>_<uuid>.jsonl, whose
 * header record carries `id` and `cwd` outright. omp writes an extra `title`
 * record first. A live writer either holds the file open or shows up as an
 * interactive process in the session's directory.
 */
async function piFamily(engine, home, account) {
  const root = join(expand(home), ENGINES[engine]?.sessionsDir ?? 'sessions');
  if (!existsSync(root)) return [];

  const files = await newest(root, (n) => n.endsWith('.jsonl'), PER_ENGINE * 2);
  const active = interactiveProcesses(engine);
  const claimed = new Set();
  const out = [];
  for (const f of files) {
    try {
      let meta = null;
      let title = '';
      for (const line of await headLines(f.path, 40)) {
        const r = parse(line);
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
        model: meta.modelId ?? undefined,
        transcript: f.path,
        active: !!pid,
        writerPid: pid,
      });
      if (out.length >= PER_ENGINE) break;
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
async function grok(home, account) {
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

  const summaries = await newest(root, (n) => n === 'summary.json', PER_ENGINE * 2);
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
      if (out.length >= PER_ENGINE) break;
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
async function cursor(home, account) {
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
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, PER_ENGINE);
}

// --------------------------------------------------------------------- agy

/**
 * Antigravity keeps one protobuf-step database per conversation under
 * conversations/<id>.db plus a flat index, conversation_summaries.db, that
 * carries everything inventory needs: id, generated title, workspace URIs,
 * last-write time and an idle flag. The step payloads are protobuf, so the
 * conversation db is only useful as a writer-lock handle - not a transcript.
 */
async function agy(home, account) {
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
    ).all(PER_ENGINE);
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
        // not_fully_idle hints a live writer, but the row still only counts
        // as active when a process can be pinned to it.
        active: !!pid && !r.killed,
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
async function antigravity(home, account) {
  const root = join(expand(home), 'antigravity-acp', 'conversations');
  if (!existsSync(root)) return [];

  const active = interactiveProcesses('antigravity');
  const claimed = new Set();
  const out = [];
  // The .db's mtime is the recency signal, so it is what gets sorted and
  // capped - an unsorted readdir page could keep the newest conversation
  // out of the list entirely.
  for (const f of await newest(root, (n) => n.endsWith('.db'), PER_ENGINE * 2)) {
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
      title: basename(dir) || 'antigravity session',
      cwd: collapse(dir),
      updatedAt: Math.floor(f.mtime),
      transcript: conv,
      active: !!pid,
      writerPid: pid,
    });
    if (out.length >= PER_ENGINE) break;
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
async function muse(home, account) {
  const base = process.env.XDG_DATA_HOME || join(HOME, '.local', 'share');
  const root = join(base, 'muse', 'sessions');
  if (!existsSync(root)) return [];

  const files = await newest(root, (n) => n === 'session.jsonl', PER_ENGINE);
  const active = interactiveProcesses('muse');
  const claimed = new Set();
  const out = [];
  for (const f of files) {
    try {
      let cwd = null;
      let title = '';
      for (const line of await headLines(f.path, 30)) {
        const r = parse(line);
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
        title: title.replace(/\s+/g, ' ').slice(0, 90) || (cwd ? basename(cwd) : 'muse session'),
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
 * Scratch work: a CLI run in the system temp folder, or in a folder named
 * as a scratch pad or sandbox. Every test run and one-off check leaves a
 * transcript behind, and on a machine that is worked at they outnumber the
 * real threads. The lists leave them out; `inventory()` itself still reads
 * them, so a row opened before can always be found again by its id.
 */
const TEMP_ROOTS = [...new Set(
  [tmpdir(), process.env.TMPDIR, '/tmp', '/var/tmp', '/private/tmp', '/dev/shm']
    .filter(Boolean).map((p) => resolve(p)),
)];
const SCRATCH_NAME = /^(scratch|sandbox|tmp|temp)$|[-_.](scratch|sandbox)$|^(scratch|sandbox)[-_.]/i;
export function isScratch(cwd) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const abs = resolve(expand(cwd));
  if (TEMP_ROOTS.some((r) => abs === r || abs.startsWith(r + '/'))) return true;
  return abs.split('/').some((seg) => SCRATCH_NAME.test(seg));
}

/**
 * Every past session this machine knows about, newest first.
 * @param {Array} profiles  so we scan each configured account, not just the default
 */
export async function inventory(profiles = []) {
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

    if (p.engine === 'codex') jobs.push(codex(home, p.id));
    else if (p.engine === 'claude') jobs.push(claude(home, p.id));
    else if (p.engine === 'opencode' || p.engine === 'opencode2') {
      jobs.push(Promise.resolve(opencode(home, p.id, p.engine)));
    }
    else if (p.engine === 'devin') jobs.push(Promise.resolve(devin(home, p.id)));
    else if (p.engine === 'pi' || p.engine === 'omp') jobs.push(piFamily(p.engine, home, p.id));
    else if (p.engine === 'grok') jobs.push(grok(home, p.id));
    else if (p.engine === 'cursor') jobs.push(Promise.resolve(cursor(home, p.id)));
    else if (p.engine === 'agy') jobs.push(Promise.resolve(agy(home, p.id)));
    else if (p.engine === 'antigravity') jobs.push(Promise.resolve(antigravity(home, p.id)));
    else if (p.engine === 'muse') jobs.push(muse(home, p.id));
  }

  const all = (await Promise.allSettled(jobs)).flatMap((r) => r.status === 'fulfilled' ? r.value : []);
  await Promise.all(all.map(async (s) => Object.assign(s, await sessionActivity({
    engine: s.engine, path: s.transcript, sessionId: s.id, active: s.active, updatedAt: s.updatedAt,
  }))));
  // The sqlite readers scan shared data dirs, so a second account of the same
  // engine returns the same rows; the id, not the account, says which they are.
  const known = new Set();
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
