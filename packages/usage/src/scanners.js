import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { FileRollupCache, ResultCache, blankStats, bucketKey } from './scan-cache.js';

/**
 * Reading what each CLI already wrote about what it spent.
 *
 * Every agent CLI records its own token usage next to its transcripts, and
 * that record is the only complete one: it covers sessions con never started,
 * it survives the event log being trimmed, and it is per-account because each
 * account is a different home directory. con already knows where those homes
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

    // Claude Code occasionally writes the same assistant message twice in a
    // row. The ring only has to look back a few lines to catch that, and it is
    // bounded so an index entry cannot grow with the transcript.
    const id = msg.id || d.requestId || d.uuid;
    if (id) {
      if (state.seen.includes(id)) return;
      state.seen.push(id);
    }

    const raw = msg.model || d.model || '';
    if (!raw || raw === '<synthetic>') return;
    const model = raw.replace(/-\d{8}$/, '');

    const rawTs = d.timestamp || msg.timestamp;
    const ts = typeof rawTs === 'number'
      ? new Date(rawTs > 1e12 ? rawTs : rawTs * 1000).toISOString()
      : String(rawTs || '');
    const date = ts.slice(0, 10);
    if (!date) return;

    const input = Number(u.input_tokens ?? u.inputTokens) || 0;
    const output = Number(u.output_tokens ?? u.outputTokens) || 0;
    const cacheWrite = Number(u.cache_creation_input_tokens ?? u.cacheCreationTokens) || 0;
    const cacheRead = Number(u.cache_read_input_tokens ?? u.cacheReadTokens) || 0;
    // The folder is part of the bucket's identity, so a machine can break its
    // spend down by project without a second pass over the transcripts.
    add({ date, model, project: d.cwd || '' }, {
      input, output, cacheWrite, cacheRead,
      total: input + output + cacheWrite + cacheRead,
      turns: 1,
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

function opencodeRows(dbPath) {
  const buckets = new Map();
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      `SELECT model, time_created, tokens_input, tokens_output,
              tokens_cache_read, tokens_cache_write, cost
         FROM session`
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
    const read = kind === 'devin' ? devinRows : opencodeRows;
    const { hit, sig, value } = await this.dbs.lookup(`${kind}:${dbPath}`, dbFiles(dbPath), { force: opts.rebuild });
    if (hit) {
      stats.dbHits++;
      try { stats.dbBytesSkipped += (await stat(dbPath)).size; } catch { /* gone */ }
      return { buckets: new Map(Object.entries(value)), stats };
    }
    const fresh = read(dbPath);
    this.dbs.store(`${kind}:${dbPath}`, sig, fresh);
    stats.dbScans++;
    return { buckets: new Map(Object.entries(fresh)), stats };
  }
}

export { jsonlUnder, dbFiles };
