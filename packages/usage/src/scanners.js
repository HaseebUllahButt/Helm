import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { FileRollupCache, ResultCache, blankStats, bucketKey } from './scan-cache.js';
import { offThread } from './off-thread.js';

/**
 * Reading what each CLI already wrote about what it spent.
 *
 * Every agent CLI records its own token usage next to its transcripts, and
 * that record is the only complete one: it covers sessions helm never started,
 * it survives the event log being trimmed, and it is per-account because each
 * account is a different home directory. helm already knows where those homes
 * are - `inventory.js` walks the same trees for session titles - so this adds
 * the numbers rather than a new place to find them.
 *
 * Everything here produces the same shape: buckets keyed `date|model` holding
 * raw token counts. Nothing is priced until it is read, so a rate corrected in
 * `pricing.js` reaches an archived session whose file will never change again.
 */

// --------------------------------------------------------------- claude

/**
 * Claude Code writes one JSONL per session under `projects/<slug>/`, and every
 * assistant message carries its own `usage`. Cache creation is split 5m/1h in
 * `cache_creation`; both are cache writes and are counted together.
 */
export const claudeParser = {
  initState: () => ({ seen: [] }),
  // A cheap reject before JSON.parse: most lines in a transcript are not
  // assistant turns, and parsing all of them is the bulk of a cold scan.
  wants: (line) => line.includes('"type":"assistant"') || line.includes('"role":"assistant"'),
  line: (d, state, add) => {
    if (d.type !== 'assistant' && d.message?.role !== 'assistant') return;
    const msg = d.message || d;
    const u = msg.usage || d.usage;
    if (!u) return;

    const raw = msg.model || d.model || '';
    if (!raw || raw === '<synthetic>') return;
    const model = raw.replace(/-\d{8}$/, '');

    const rawTs = d.timestamp || msg.timestamp;
    const ts = typeof rawTs === 'number'
      ? new Date(rawTs > 1e12 ? rawTs : rawTs * 1000).toISOString()
      : String(rawTs || '');
    const date = ts.slice(0, 10);
    if (!date) return;

    let input = Number(u.input_tokens ?? u.inputTokens) || 0;
    let output = Number(u.output_tokens ?? u.outputTokens) || 0;
    let cacheWrite = Number(u.cache_creation_input_tokens ?? u.cacheCreationTokens) || 0;
    let cacheRead = Number(u.cache_read_input_tokens ?? u.cacheReadTokens) || 0;
    // The 1-hour share of the writes bills at 2x input, not 1.25x.
    let cacheWrite1h = Math.min(cacheWrite, Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0);
    let turns = 1;

    // Claude Code writes one message across several lines sharing an id,
    // and the output count grows as it goes (8, then 420). Keeping the first
    // line undercounted output; keeping each would count the input again per
    // line. So: what each id has already been credited with, and only the
    // growth past it. The ring only has to look back a few lines, and it is
    // bounded so an index entry cannot grow with the transcript.
    const id = msg.id || d.requestId || d.uuid;
    if (id) {
      const prev = state.seen.find((e) => (Array.isArray(e) ? e[0] : e) === id);
      // A bare id is a ring entry from before this counted anything.
      if (typeof prev === 'string') return;
      const now = [input, output, cacheWrite, cacheRead, cacheWrite1h];
      if (prev) {
        const was = prev[1];
        [input, output, cacheWrite, cacheRead, cacheWrite1h] = now.map((n, i) => Math.max(0, n - (was[i] ?? 0)));
        prev[1] = now.map((n, i) => Math.max(n, was[i] ?? 0));
        if (!(input || output || cacheWrite || cacheRead)) return;
        turns = 0;
      } else {
        state.seen.push([id, now]);
      }
    }
    // The folder is part of the bucket's identity, so a machine can break its
    // spend down by project without a second pass over the transcripts.
    add({ date, model, project: d.cwd || '' }, {
      input, output, cacheWrite, cacheWrite1h, cacheRead,
      total: input + output + cacheWrite + cacheRead,
      turns,
    });
  },
};

// ---------------------------------------------------------------- codex

/**
 * Codex writes one rollout per session. `token_count` events carry both a
 * running total and the last turn's usage; the per-turn figure is what adds up
 * without double counting. The model is named once in a `turn_context` near
 * the top, which is why parser state has to survive an incremental read.
 */
export const codexParser = {
  initState: () => ({ model: null, cwd: null }),
  wants: (line) => line.includes('"token_count"') || line.includes('"turn_context"'),
  line: (d, state, add) => {
    const p = d.payload || {};
    if (d.type === 'turn_context' || p.type === 'turn_context') {
      if (p.model) state.model = p.model;
      if (p.cwd) state.cwd = p.cwd;
      return;
    }
    if (p.type !== 'token_count') return;

    const date = String(d.timestamp || '').slice(0, 10);
    if (!date) return;

    // Codex sometimes writes the same token_count twice with the running
    // total unchanged; the second one is not another turn.
    const running = Number((p.info || {}).total_token_usage?.total_tokens) || null;
    if (running && running === state.lastTotal) return;
    if (running) state.lastTotal = running;

    const u = (p.info || {}).last_token_usage || {};
    const cacheRead = Number(u.cached_input_tokens) || 0;
    const input = Math.max(0, (Number(u.input_tokens) || 0) - cacheRead);
    const output = Number(u.output_tokens) || 0;
    const reasoning = Number(u.reasoning_output_tokens) || 0;
    const total = Number(u.total_tokens) || (input + cacheRead + output);
    if (!(input || output || cacheRead)) return;
    add({ date, model: state.model || 'gpt-5.6-luna', project: state.cwd || '' }, {
      input, output, cacheRead, reasoning, total, turns: 1,
    });
  },
};

// --------------------------------------------------------------- walking

/** Every `.jsonl` under a root, depth-first. */
async function jsonlUnder(root) {
  const out = [];
  async function walk(dir, depth = 0) {
    if (depth > 8) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(root);
  return out;
}

// -------------------------------------------------------------- sqlite

/**
 * OpenCode and Devin keep databases rather than logs, so there is no seam to
 * resume from - but "has this changed at all?" is one stat, and for an agent
 * you are not using the answer is no. The signature watches the database and
 * its `-wal`, never `-shm`: opening a database read-only rewrites `-shm`, so
 * watching it would make every scan dirty the file it was watching.
 */
const dbFiles = (dbPath) => [dbPath, `${dbPath}-wal`];

function opencodeRows(dbPath, engine = 'opencode') {
  const buckets = new Map();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const table = engine === 'opencode2' ? 'session_v2' : 'session';
    const onlyV2 = engine === 'opencode2' ? ' WHERE id NOT IN (SELECT id FROM session)' : '';
    const rows = db.prepare(
      `SELECT model, time_created, tokens_input, tokens_output,
              tokens_cache_read, tokens_cache_write, cost
         FROM ${table}${onlyV2}`
    ).all();
    for (const r of rows) {
      const ms = Number(r.time_created) || 0;
      if (!ms) continue;
      const date = new Date(ms > 1e12 ? ms : ms * 1000).toISOString().slice(0, 10);
      let model = r.model || 'unknown';
      if (typeof model === 'string' && model.startsWith('{')) {
        try { model = JSON.parse(model).id ?? 'unknown'; } catch { model = 'unknown'; }
      }
      const key = bucketKey({ date, model });
      const b = buckets.get(key) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, billedUsd: 0 };
      b.input += Number(r.tokens_input) || 0;
      b.output += Number(r.tokens_output) || 0;
      b.cacheRead += Number(r.tokens_cache_read) || 0;
      b.cacheWrite += Number(r.tokens_cache_write) || 0;
      // OpenCode computes its own cost, so it is carried rather than derived.
      b.billedUsd += Number(r.cost) || 0;
      b.turns += 1;
      b.total = b.input + b.output + b.cacheRead + b.cacheWrite;
      buckets.set(key, b);
    }
    db.close();
  } catch {
    try { db?.close(); } catch { /* already gone */ }
  }
  return Object.fromEntries(buckets);
}

/** One agent database read into buckets; what the worker thread runs. */
export function readDatabase(kind, dbPath) {
  return kind === 'devin' ? devinRows(dbPath) : opencodeRows(dbPath, kind);
}

/**
 * A database read within this long is reused even though its `-wal` moved.
 * The WAL moves on every turn of an agent in use, and Devin's full read is
 * seconds of disk and CPU - a phone opening Usage while Devin worked paid it
 * every time. A rebuild still reads it fresh.
 */
const DB_FRESH_MS = 5 * 60_000;

function devinRows(dbPath) {
  const buckets = new Map();
  const seen = new Set();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare(`
      SELECT m.created_at AS ts,
        json_extract(m.chat_message, '$.metadata.request_id') AS requestId,
        json_extract(m.chat_message, '$.metadata.generation_model') AS model,
        json_extract(m.chat_message, '$.metadata.metrics.input_tokens') AS input,
        json_extract(m.chat_message, '$.metadata.metrics.output_tokens') AS output,
        json_extract(m.chat_message, '$.metadata.metrics.cache_read_tokens') AS cacheRead,
        json_extract(m.chat_message, '$.metadata.metrics.cache_creation_tokens') AS cacheWrite
      FROM message_nodes m
      WHERE json_extract(m.chat_message, '$.metadata.metrics') IS NOT NULL
    `);
    for (const r of stmt.iterate()) {
      // The CLI rewrites an assistant node when its tool calls resolve, storing
      // the same generation under the same request_id twice.
      if (r.requestId) {
        if (seen.has(r.requestId)) continue;
        seen.add(r.requestId);
      }
      let ts = Number(r.ts);
      if (!ts || !Number.isFinite(ts)) continue;
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      const key = bucketKey({ date, model: r.model || 'unknown' });
      const b = buckets.get(key) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
      b.input += Number(r.input) || 0;
      b.output += Number(r.output) || 0;
      b.cacheRead += Number(r.cacheRead) || 0;
      b.cacheWrite += Number(r.cacheWrite) || 0;
      b.turns += 1;
      b.total = b.input + b.output + b.cacheRead + b.cacheWrite;
      buckets.set(key, b);
    }
    db.close();
  } catch {
    try { db?.close(); } catch { /* already gone */ }
  }
  return Object.fromEntries(buckets);
}

// ----------------------------------------------------------- public API

export class Scanners {
  constructor() {
    this.claude = new FileRollupCache({ id: 'claude', parser: claudeParser });
    this.codex = new FileRollupCache({ id: 'codex', parser: codexParser });
    this.dbs = new ResultCache({ id: 'db' });
  }

  /** Every cache this holds, for loading and saving the index as one file. */
  get caches() { return [this.claude, this.codex, this.dbs]; }

  async scanClaude(home, opts) {
    const root = join(home, 'projects');
    const files = await jsonlUnder(root);
    const stats = await this.claude.scan(files, { ...opts, root });
    return { buckets: this.claude.fold(files), stats };
  }

  async scanCodex(home, opts) {
    const root = join(home, 'sessions');
    const files = await jsonlUnder(root);
    const stats = await this.codex.scan(files, { ...opts, root });
    return { buckets: this.codex.fold(files), stats };
  }

  async scanDatabase(kind, dbPath, opts = {}) {
    const stats = blankStats();
    stats.dbs++;
    const key = `${kind}:${dbPath}`;
    const { hit, sig, value } = await this.dbs.lookup(key, dbFiles(dbPath), { force: opts.rebuild });
    const recent = !opts.rebuild && this.dbs.entries.get(key);
    if (hit || (recent && Date.now() - (recent.at ?? 0) < DB_FRESH_MS)) {
      stats.dbHits++;
      try { stats.dbBytesSkipped += (await stat(dbPath)).size; } catch { /* gone */ }
      return { buckets: new Map(Object.entries(hit ? value : recent.value)), stats };
    }
    const fresh = await offThread(import.meta.url, 'readDatabase', [kind, dbPath])
      .catch(() => readDatabase(kind, dbPath));
    this.dbs.store(key, sig, fresh);
    stats.dbScans++;
    return { buckets: new Map(Object.entries(fresh)), stats };
  }
}

export { jsonlUnder, dbFiles };
