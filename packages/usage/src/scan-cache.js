// Incremental, persistent rollups of append-only JSONL session logs.
//
// The scanners used to keep a `Map(path -> {mtimeMs, size, daily, models})`
// in memory and nothing else, which cost three things:
//
//   - a restart threw the expensive tier away and kept the cheap one. The
//     aggregate (34KB) was written to disk; the parse work behind it (1.8GB
//     of Codex rollouts, 8-16s) was not, so every service restart rebuilt it.
//   - a file that grew by one line was re-read whole. These logs are appended
//     to while you work, so the active session is exactly the file that keeps
//     invalidating: 802ms to re-read 62MB, against 3ms to read its tail.
//   - the cached rollup held *dollars*, computed at parse time. Editing a rate
//     table therefore left every unchanged file reporting the old cost, and an
//     archived session's mtime never changes again - so "forever".
//
// This module fixes all three: rollups are keyed by (date, model) and hold
// raw token counts, priced at read time; a file is re-read only from the byte
// where the last scan stopped; and the whole index is written to disk.
//
// Everything here is provider-agnostic. A caller supplies a parser and gets
// back buckets; pricing lives with the caller, which is the point.

import { open, stat, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** A file untouched for this long is treated as immutable and not re-stat'ed. */
export const SEAL_AFTER_MS = 7 * 24 * 60 * 60_000;
/** Read granularity for the incremental tail. */
const CHUNK = 1 << 20;
/**
 * How many recent message ids a parser may carry across an incremental
 * boundary. Claude Code occasionally writes one assistant message twice in a
 * row; the dedupe that catches it only has to look back a few lines, and an
 * unbounded set would put one entry per message on disk forever.
 */
export const DEDUPE_RING = 32;

/**
 * The counters every provider is folded into. All summable: a bucket is a
 * running total, so anything that is not a number belongs in the key.
 */
export const FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead', 'reasoning', 'total', 'turns'];

export const blankTokens = () => ({
  input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0, total: 0, turns: 0,
});

/**
 * A bucket's identity: when, which model, and which folder the work was in.
 *
 * Kept as one delimited string because it is a Map key and a JSON object key
 * on disk. Project is last so a caller that does not care can split it off.
 */
export const bucketKey = ({ date, model, project = '' }) => `${date}|${model}|${project}`;

export const splitKey = (key) => {
  const a = key.indexOf('|');
  const b = key.indexOf('|', a + 1);
  return b === -1
    ? { date: key.slice(0, a), model: key.slice(a + 1), project: '' }
    : { date: key.slice(0, a), model: key.slice(a + 1, b), project: key.slice(b + 1) };
};

/**
 * Read complete lines from `startByte` to the end of the file.
 *
 * Returns the offset *after the last complete newline*, never the file size:
 * a log being appended to right now can be stat'ed mid-line, and recording
 * the size would skip past the torn remainder and lose that record forever.
 * The partial tail is simply left for the next pass.
 */
export async function foldLinesFrom(filePath, startByte, onLine) {
  let fh;
  try { fh = await open(filePath, 'r'); } catch { return { consumed: startByte, size: 0, read: 0 }; }
  try {
    const { size } = await fh.stat();
    if (startByte >= size) return { consumed: startByte, size, read: 0 };
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = startByte;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : Buffer.from(buf.subarray(0, bytesRead));
      let from = 0;
      let nl;
      while ((nl = data.indexOf(0x0a, from)) !== -1) {
        if (nl > from) onLine(data.subarray(from, nl).toString('utf8'));
        from = nl + 1;
      }
      carry = data.subarray(from);
    }
    return { consumed: pos - carry.length, size, read: pos - startByte };
  } catch {
    return { consumed: startByte, size: 0, read: 0 };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Fresh counters for one scan, so the UI can say what the cache actually saved. */
export function blankStats() {
  return {
    files: 0, sealed: 0, hits: 0, appended: 0, parsed: 0, dropped: 0,
    bytesRead: 0, bytesSkipped: 0, scanMs: 0,
    dbs: 0, dbHits: 0, dbScans: 0, dbBytesSkipped: 0,
  };
}

export function addStats(a, b) {
  const out = blankStats();
  for (const k of Object.keys(out)) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

/**
 * One provider's file index.
 *
 * `parser` is `{ id, initState(), wants(line), line(parsed, state, add) }`,
 * where `add(date, model, tokens)` accumulates into the file's buckets and
 * `state` survives across incremental reads - which it has to, because a
 * Codex rollout names its model once in a `turn_context` near the top and
 * every `token_count` after it is that model. Parsing only the tail without
 * carrying that forward would attribute the whole session to the default.
 */
export class FileRollupCache {
  constructor({ id, parser, sealAfterMs = SEAL_AFTER_MS }) {
    this.id = id;
    this.parser = parser;
    this.sealAfterMs = sealAfterMs;
    /** path -> { mtimeMs, size, ino, bytes, buckets, state } */
    this.entries = new Map();
  }

  /** Is this cached entry still the file on disk? */
  #matches(entry, st) {
    return entry
      && entry.mtimeMs === st.mtimeMs
      && entry.size === st.size
      && (entry.ino == null || st.ino == null || entry.ino === st.ino);
  }

  /**
   * Parse `filePath` from `startByte` into `entry`, in place.
   *
   * A cold read starts at 0 with empty buckets; an append folds onto what is
   * already there. Both go through the same code, so an incremental result
   * cannot drift from a cold one.
   */
  async #read(filePath, entry, startByte) {
    const { parser } = this;
    const add = (dims, tokens) => {
      if (!dims?.date || !dims?.model) return;
      const key = bucketKey(dims);
      let b = entry.buckets[key];
      if (!b) b = entry.buckets[key] = blankTokens();
      for (const f of FIELDS) if (tokens[f]) b[f] += tokens[f];
    };
    const { consumed, size, read } = await foldLinesFrom(filePath, startByte, (line) => {
      if (!parser.wants(line)) return;
      let d;
      try { d = JSON.parse(line); } catch { return; }
      try { parser.line(d, entry.state, add); } catch { /* one bad record is not a bad file */ }
    });
    // Bound anything the parser carries forward, so state cannot grow without limit.
    if (Array.isArray(entry.state?.seen) && entry.state.seen.length > DEDUPE_RING) {
      entry.state.seen = entry.state.seen.slice(-DEDUPE_RING);
    }
    entry.bytes = consumed;
    return { size, read };
  }

  /**
   * Bring the index up to date for `files` and report what that cost.
   *
   * Three outcomes per file, and the whole point of the module is how often
   * the first two happen: sealed (old enough to be immutable - not even
   * stat'ed), hit (unchanged), appended (read from `bytes` on), parsed (new,
   * or changed in a way that is not an append - a rewrite, a truncation).
   *
   * Two escape hatches, because "I do not believe these numbers" has two
   * different causes. `force` re-stats everything, seal included, and still
   * skips what has genuinely not changed - that is the cheap one, and the one
   * a Rescan button wants. `rebuild` distrusts the cache key itself and
   * re-reads every byte; it is the only thing that can fix an entry whose
   * (mtime, size, ino) lied, and it costs a cold scan.
   */
  async scan(files, { force = false, rebuild = false, concurrency = 16, root = null } = {}) {
    if (rebuild) force = true;
    const started = Date.now();
    const stats = blankStats();
    const live = new Set(files);
    const now = Date.now();

    // Evict only inside the tree that was just walked. One index serves every
    // account of a provider - two Codex logins are two roots - so treating the
    // file list as the whole universe would have each account delete the
    // others' entries on its way past, and the last one to scan would be the
    // only one left in the fold.
    for (const known of [...this.entries.keys()]) {
      if (live.has(known)) continue;
      if (root && !known.startsWith(root)) continue;
      this.entries.delete(known);
      stats.dropped++;
    }

    const work = [];
    for (const filePath of files) {
      stats.files++;
      const entry = this.entries.get(filePath);
      // Sealed: old, already whole, and JSONL is append-only. Skipping the
      // stat is what keeps a history of tens of thousands of files flat.
      if (!force && entry && entry.sealed && now - entry.mtimeMs > this.sealAfterMs) {
        stats.sealed++;
        stats.bytesSkipped += entry.size;
        continue;
      }
      let st;
      try { st = await stat(filePath); } catch { continue; }
      if (!rebuild && this.#matches(entry, st)) {
        stats.hits++;
        stats.bytesSkipped += st.size;
        if (now - st.mtimeMs > this.sealAfterMs) entry.sealed = true;
        continue;
      }
      // Grown in place with everything we already read still intact: read the
      // tail only. Anything else (shrunk, replaced, first sight) starts over.
      const appended = !rebuild && entry && st.size > entry.size && entry.ino === st.ino && entry.bytes <= st.size;
      work.push({ filePath, st, appended: !!appended });
    }

    let i = 0;
    const worker = async () => {
      while (i < work.length) {
        const item = work[i++];
        if (!item) break;
        const { filePath, st, appended } = item;
        let entry;
        if (appended) {
          entry = this.entries.get(filePath);
          stats.appended++;
          stats.bytesSkipped += entry.bytes;
        } else {
          entry = { buckets: {}, bytes: 0, state: this.parser.initState() };
          stats.parsed++;
        }
        const { read } = await this.#read(filePath, entry, appended ? entry.bytes : 0);
        entry.mtimeMs = st.mtimeMs;
        entry.size = st.size;
        entry.ino = st.ino;
        entry.sealed = now - st.mtimeMs > this.sealAfterMs;
        stats.bytesRead += read;
        this.entries.set(filePath, entry);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) || 1 }, worker));

    stats.scanMs = Date.now() - started;
    return stats;
  }

  /**
   * Buckets summed into one `date|model -> tokens` map.
   *
   * `files` scopes the fold to one account's tree; without it the answer would
   * carry every account sharing this index.
   */
  fold(files = null) {
    const out = new Map();
    const pick = files ? files.map((f) => this.entries.get(f)).filter(Boolean) : [...this.entries.values()];
    for (const entry of pick) {
      for (const [key, b] of Object.entries(entry.buckets)) {
        let cur = out.get(key);
        if (!cur) out.set(key, (cur = blankTokens()));
        for (const f of FIELDS) cur[f] += b[f] || 0;
      }
    }
    return out;
  }

  /** Whatever the parsers carried, for callers that need more than tokens. */
  states(files = null) {
    const pick = files ? files.map((f) => this.entries.get(f)).filter(Boolean) : [...this.entries.values()];
    return pick.map((e) => e.state).filter(Boolean);
  }

  toJSON() {
    const files = {};
    for (const [p, e] of this.entries) {
      files[p] = {
        m: e.mtimeMs, s: e.size, i: e.ino, b: e.bytes, k: e.sealed ? 1 : 0,
        u: e.buckets, t: e.state,
      };
    }
    return { id: this.id, files };
  }

  loadJSON(data) {
    if (!data || data.id !== this.id || !data.files) return false;
    this.entries.clear();
    for (const [p, e] of Object.entries(data.files)) {
      this.entries.set(p, {
        mtimeMs: e.m, size: e.s, ino: e.i, bytes: e.b, sealed: !!e.k,
        buckets: e.u || {}, state: e.t || this.parser.initState(),
      });
    }
    return true;
  }
}


/**
 * A whole scan result, kept until the files behind it change.
 *
 * The JSONL scanners can read just the bytes that were appended; a SQLite
 * database gives no such seam - the rows that matter are spread through a
 * 1GB file and the aggregation joins across tables. But the question "has
 * this database changed at all since I last read it?" is one stat call, and
 * the answer is usually no: a provider you are not using right now costs a
 * full table scan on every pass for a number that cannot have moved.
 *
 * So: signature the files, and recompute only when the signature moves. When
 * it does move, recompute the whole thing - correctness over cleverness, and
 * the expensive case is the one where you are actively using that agent.
 *
 * The -wal and -shm siblings are part of the signature. In WAL mode a write
 * lands in the -wal file and the main database's mtime does not move at all,
 * so watching it alone would serve a stale answer for as long as the WAL went
 * uncheckpointed - which for a busy database is a long time.
 */
export class ResultCache {
  constructor({ id }) {
    this.id = id;
    /** key -> { sig, value } */
    this.entries = new Map();
  }

  static async signature(paths) {
    const parts = [];
    for (const p of paths) {
      try {
        const st = await stat(p);
        parts.push(`${p}:${st.mtimeMs}:${st.size}:${st.ino}`);
      } catch {
        parts.push(`${p}:-`);
      }
    }
    return parts.join('|');
  }

  /** The cached value when the files are untouched, else a miss plus the new signature. */
  async lookup(key, paths, { force = false } = {}) {
    const sig = await ResultCache.signature(paths);
    const hit = this.entries.get(key);
    if (!force && hit && hit.sig === sig) return { hit: true, sig, value: hit.value };
    return { hit: false, sig, value: null };
  }

  store(key, sig, value) {
    this.entries.set(key, { sig, value });
  }

  toJSON() {
    return { id: this.id, entries: Object.fromEntries(this.entries) };
  }

  loadJSON(data) {
    if (!data || data.id !== this.id || !data.entries) return false;
    this.entries.clear();
    for (const [k, v] of Object.entries(data.entries)) {
      if (v && typeof v.sig === 'string') this.entries.set(k, v);
    }
    return true;
  }
}

/**
 * The whole index, one file on disk.
 *
 * Written through a temporary name so a crash mid-write cannot leave a
 * half-parsed index behind; a version stamp retires the format outright when
 * it changes, because a wrong bucket is worse than a cold scan.
 */
export const INDEX_VERSION = 1;

export async function loadIndex(file, caches) {
  if (!existsSync(file)) return false;
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!data || data.version !== INDEX_VERSION) return false;
    let any = false;
    for (const cache of caches) {
      const section = data.caches?.[cache.id];
      if (section && cache.loadJSON(section)) any = true;
    }
    return any;
  } catch {
    return false;
  }
}

export async function saveIndex(file, caches) {
  const payload = { version: INDEX_VERSION, savedAt: new Date().toISOString(), caches: {} };
  for (const cache of caches) payload.caches[cache.id] = cache.toJSON();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

