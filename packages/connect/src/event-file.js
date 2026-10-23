import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

const READ_BLOCK = 16 * 1024;
const contextType = type => type?.startsWith('turn.') || type === 'item.start' || type === 'item.done';
const lowerBound = (values, value) => {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (values[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
};

/** Byte positions, not historic payloads. One scan serves subsequent history pages. */
export class EventFile {
  starts = []; ends = []; seqs = []; contexts = []; summaries = []; turns = [];
  complete = 0; stamp = null;
  #snapshot = null;
  #recent = null;

  constructor(file, summarize = event => event) { this.file = file; this.summarize = summarize; }

  record(event, start, end) {
    const index = this.seqs.length;
    this.starts.push(start); this.ends.push(end); this.seqs.push(event.seq);
    if (this.#recent) this.#recent[index % this.#recent.length] = event;
    if (contextType(event.type)) { this.contexts.push(index); this.summaries.push(this.summarize(event)); }
    if (event.type === 'turn.start') this.turns.push(index);
  }

  refresh(visit, keep = 0) {
    let st;
    try { st = statSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const old = this.stamp;
    if (st && old && st.dev === old.dev && st.ino === old.ino && st.size === old.size
      && st.mtimeMs === old.mtimeMs && st.ctimeMs === old.ctimeMs) { visit?.(this); return this; }
    // Only append() below proves an append. A larger file can also be an
    // in-place rewrite, so an unexpected change rebuilds the positions.
    this.starts = []; this.ends = []; this.seqs = []; this.contexts = []; this.summaries = []; this.turns = [];
    this.complete = 0;
    this.stamp = st ?? null;
    if (!st) { visit?.(this); return this; }
    const bytes = readFileSync(this.file);
    // The opening reader can reuse this scan. No whole-file buffer or parsed
    // tail survives the callback, including when it throws.
    this.#snapshot = visit ? bytes : null;
    this.#recent = visit && keep > 0 ? new Array(keep) : null;
    try {
      for (let from = 0; from < bytes.length;) {
        const nl = bytes.indexOf(10, from), end = nl < 0 ? bytes.length : nl;
        if (end > from) {
          try {
            const event = JSON.parse(bytes.toString('utf8', from, end));
            if (event && typeof event.seq === 'number') {
              this.record(event, from, end);
            }
          } catch { /* A torn or invalid record must not hide later valid records. */ }
        }
        if (nl >= 0) this.complete = nl + 1;
        from = end + 1;
      }
      visit?.(this);
      return this;
    } finally {
      this.#snapshot = null;
      this.#recent = null;
    }
  }

  /** Called only after this writer appends the exact line to a refreshed file. */
  append(event, line) {
    const old = this.stamp, st = statSync(this.file), bytes = Buffer.byteLength(line);
    if (!old || this.complete !== old.size || st.dev !== old.dev || st.ino !== old.ino || st.size !== old.size + bytes) {
      this.refresh(); return;
    }
    this.record(event, old.size, st.size - 1);
    this.complete = st.size; this.stamp = st;
  }

  read(start, end) {
    if (this.#snapshot) return Buffer.from(this.#snapshot.subarray(start, end));
    const fd = openSync(this.file, 'r');
    try {
      const bytes = Buffer.allocUnsafe(end - start);
      let read = 0;
      while (read < bytes.length) {
        const n = readSync(fd, bytes, read, bytes.length - read, start + read);
        if (!n) break;
        read += n;
      }
      return bytes.subarray(0, read);
    } finally { closeSync(fd); }
  }

  event(index, cache) {
    if (index < 0 || index >= this.seqs.length) return null;
    if (this.#recent && index >= this.seqs.length - this.#recent.length) return this.#recent[index % this.#recent.length];
    try {
      if (this.#snapshot) return JSON.parse(this.#snapshot.toString('utf8', this.starts[index], this.ends[index]));
      if (!cache) return JSON.parse(this.read(this.starts[index], this.ends[index]).toString('utf8'));
      if (cache.stamp !== this.stamp) {
        cache.stamp = this.stamp; cache.events = new Map(); cache.bytes = null;
      }
      if (cache.events.has(index)) return cache.events.get(index);
      const start = this.starts[index], end = this.ends[index];
      // Prefetch short rows only. Large rows must not increase a page's reads.
      if (end - start >= READ_BLOCK / 4) return JSON.parse(this.read(start, end).toString('utf8'));
      if (!cache.bytes || start < cache.start || end > cache.start + cache.bytes.length) {
        cache.events.clear();
        cache.start = Math.floor(start / READ_BLOCK) * READ_BLOCK;
        cache.bytes = this.read(cache.start, Math.min(this.stamp.size, Math.ceil(end / READ_BLOCK) * READ_BLOCK));
      }
      const event = JSON.parse(cache.bytes.toString('utf8', start - cache.start, end - cache.start));
      cache.events.set(index, event);
      return event;
    }
    catch { return null; }
  }

  get(seq) { const index = lowerBound(this.seqs, seq); return this.seqs[index] === seq ? this.event(index) : null; }

  get first() {
    let index = this.seqs.length - 1;
    while (index > 0 && this.seqs[index - 1] === this.seqs[index] - 1) index--;
    return this.seqs[index] ?? 0;
  }

  view({ since = 0, before = 0 } = {}) {
    const file = this;
    const cache = {};
    const from = since > 0 ? lowerBound(this.seqs, since + 1) : 0;
    const end = before > 0 ? lowerBound(this.seqs, before) : this.seqs.length;
    return {
      length: Math.max(0, end - from),
      at(i) {
        if (i < 0) i += this.length;
        return i >= 0 && i < this.length ? file.event(from + i, cache) : null;
      },
      turnStartBefore(i) {
        const at = file.turns[lowerBound(file.turns, from + i + 1) - 1];
        return at >= from ? at - from : -1;
      },
      *contextBefore(i) {
        for (let n = lowerBound(file.contexts, from); n < file.contexts.length && file.contexts[n] < from + i; n++) {
          yield file.summaries[n];
        }
      },
      *[Symbol.iterator]() { for (let i = 0; i < this.length; i++) { const event = this.at(i); if (event) yield event; } },
    };
  }
}
