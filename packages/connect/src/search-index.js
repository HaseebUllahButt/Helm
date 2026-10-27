import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';
import { EVENTS_DIR } from './events.js';
import { ownerText } from './owner-keeper.js';
import { extractSearchEvents } from './search-native.js';

/**
 * What was said in every chat on this machine, ready to be searched.
 *
 * The search box finds chats by their title. This finds them by their words:
 * what the owner asked and what the agent answered. A chat's log holds that,
 * but the agent's words arrive in pieces (`item.delta`) that can split a word
 * in two, and reading every log on every search would cost a second of CPU
 * each time. So the index is built once from the logs, kept up to date from
 * live events, and saved to `search-index.json` so a restart does not build
 * it again. A log trimmed by Helm keeps its indexed words: the index
 * remembers what the log forgot.
 *
 * Each chat holds at most MAX_ENTRIES short entries, oldest dropped first.
 * Entries are clipped, so the file stays small: a few MB for hundreds of chats.
 */
export const SEARCH_FILE = join(HELM_DIR, 'search-index.json');
const MAX_ENTRIES = 400;
const YOU_CHARS = 400;
const AGENT_CHARS = 320;
const SAVE_AFTER_MS = 5_000;
const SNIPPET = 120;
// Bound temporary native results, without limiting log or record size.
const SCAN_BYTES = 1024 * 1024;

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// Live events normally arrive in order. Ranges remember exact delivery without
// keeping one number for every token until the next search reads the log.
class LiveRanges {
  constructor(ranges = []) { this.ranges = ranges; }
  add(seq) {
    const last = this.ranges.at(-1);
    if (!last || seq > last[1] + 1) { this.ranges.push([seq, seq]); return; }
    if (seq >= last[0]) { last[1] = Math.max(last[1], seq); return; }
    this.ranges.push([seq, seq]); this.ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of this.ranges) {
      const prev = merged.at(-1);
      if (prev && range[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], range[1]);
      else merged.push(range);
    }
    this.ranges = merged;
  }
  has(seq) { return this.ranges.some(([from, to]) => from <= seq && seq <= to); }
  clear() { this.ranges = []; }
  prune(seq) {
    while (this.ranges[0]?.[1] <= seq) this.ranges.shift();
    if (this.ranges[0]?.[0] <= seq) this.ranges[0][0] = seq + 1;
  }
}

/** Words typed in the box; all must appear for a match. */
export function queryWords(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 0);
}

/** A short window around the first matching word, so the row shows why it matched. */
export function snippetFor(text, words) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) { const i = lower.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0 || text.length <= SNIPPET) return clip(text, SNIPPET);
  const start = Math.max(0, Math.min(at - 40, text.length - SNIPPET));
  const end = Math.min(text.length, start + SNIPPET);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Chats listed in Helm whose words are worth finding: not helpers, the brain, or terminals. */
export function searchable(s) {
  return !!s?.driver && !s.delegation && !s.brain && s.engine !== 'shell';
}

export class SearchIndex {
  /** chat id -> { last: seq, size: file bytes, offset: complete bytes read, fileKey, entries } */
  #chats = new Map();
  /** item id -> growing text, for agent replies arriving in pieces */
  #open = new Map();
  #dir; #file; #saveTimer = null; #dirty = false; #built = null; #bytesRead = 0;
  #restoreOpenFromLogs = new Set();
  #updates = null;
  #pending = new Map();
  log;

  constructor({ dir = EVENTS_DIR, file = SEARCH_FILE, log = () => {} } = {}) {
    this.#dir = dir; this.#file = file; this.log = log;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if ((saved?.v === 1 || saved?.v === 2) && saved.chats && typeof saved.chats === 'object') {
        for (const [id, chat] of Object.entries(saved.chats)) {
          if (Array.isArray(chat?.entries)) {
            for (const entry of chat.entries) entry.lower ??= String(entry.text ?? '').toLowerCase();
            const restored = { last: Number(chat.last) || 0, diskLast: Number(chat.diskLast ?? chat.last) || 0, resetSeq: Number(chat.resetSeq) || 0, liveSeqs: new LiveRanges(chat.liveRanges ?? []), size: Number(chat.size) || 0, offset: Number(chat.offset) || 0, offsetMissing: chat.offset == null, fileKey: chat.fileKey, mtimeMs: chat.mtimeMs, ctimeMs: chat.ctimeMs, prefix: chat.prefix, tail: chat.tail, entries: chat.entries };
            // Older indexes can miss history first read after live delivery.
            // Replay once while retaining indexed words from legacy trimmed logs.
            if (saved.v === 1) { restored.diskLast = 0; restored.offset = 0; restored.offsetMissing = true; }
            this.#reindex(restored);
            this.#chats.set(id, restored);
          }
        }
      }
      if (saved?.v === 2 && saved.open && typeof saved.open === 'object') this.#open = new Map(Object.entries(saved.open));
      else {
        for (const [id, chat] of this.#chats) {
          this.#restoreOpenFromLogs.add(id);
          chat.offset = 0;
          chat.offsetMissing = true;
        }
      }
    } catch { /* no index yet, or unreadable: built again from the logs */ }
  }

  get size() { return this.#chats.size; }
  get bytesRead() { return this.#bytesRead; }

  #chat(id) {
    let chat = this.#chats.get(id);
    if (!chat) { chat = { last: 0, diskLast: 0, resetSeq: 0, liveSeqs: new LiveRanges(), size: 0, offset: 0, fileKey: null, entries: [], lower: null, matchCache: null }; this.#chats.set(id, chat); }
    return chat;
  }

  #reindex(chat) {
    chat.lower = null;
    chat.matchCache = null;
  }

  #add(chat, entry) {
    const text = flat(entry.text);
    if (!text) return;
    // The owner's message is logged when sent and again when the CLI echoes it.
    if (chat.entries.length >= MAX_ENTRIES && entry.seq < chat.entries[0].seq) return;
    let at = 0, end = chat.entries.length;
    while (at < end) {
      const mid = Math.floor((at + end) / 2);
      if (chat.entries[mid].seq < entry.seq) at = mid + 1;
      else end = mid;
    }
    const duplicate = chat.entries[at];
    if (duplicate?.seq === entry.seq && duplicate.who === entry.who) {
      if (duplicate.text === text) return;
      chat.entries.splice(at, 1);
    }
    chat.entries.splice(at, 0, { who: entry.who, seq: entry.seq, at: entry.at, text, lower: text.toLowerCase() });
    for (let i = Math.max(0, at - 1); i + 1 < chat.entries.length && i <= at; i++) {
      const prev = chat.entries[i], next = chat.entries[i + 1];
      if (prev.who === next.who && prev.text === next.text) {
        prev.seq = Math.max(prev.seq, next.seq); chat.entries.splice(i + 1, 1); i--;
      }
    }
    if (chat.entries.length > MAX_ENTRIES) chat.entries.splice(0, chat.entries.length - MAX_ENTRIES);
    this.#reindex(chat);
    this.#dirty = true;
  }

  /** One event of one chat, live or read from its log. */
  note(id, e, { fromLog = false } = {}) {
    if (!e || typeof e !== 'object') return;
    const pending = !fromLog && this.#pending.get(id);
    if (pending) {
      // Finish this chat's saved records before applying its new live records.
      // Only search indexing waits; the chat continues streaming normally.
      const copy = { ...e };
      if (typeof e.seq === 'number' || ['item.delta', 'item.done'].includes(e.type)
        || e.type === 'item.start' && ['text', 'message'].includes(e.kind)) copy.id = `${e.id}`;
      if (e.type === 'turn.start' && !e.local && !e.wake) copy.text = String(e.text ?? '');
      pending.push(copy);
      return;
    }
    const chat = this.#chat(id);
    if (typeof e.seq === 'number') {
      if (e.seq > chat.last) chat.last = e.seq;
      const hasReply = this.#open.has(`${id}:${e.id}`);
      const applied = !['item.delta', 'item.done'].includes(e.type) || hasReply;
      if (!fromLog && applied && e.seq > chat.diskLast) chat.liveSeqs.add(e.seq);
    }
    switch (e.type) {
      case 'turn.start': {
        if (e.local || e.wake) return;
        const said = ownerText(e.text);
        if (said) this.#add(chat, { who: 'you', seq: e.seq, at: e.at, text: clip(said, YOU_CHARS) });
        return;
      }
      case 'item.start':
        if (e.kind === 'text' || e.kind === 'message') { this.#open.set(`${id}:${e.id}`, { text: '', at: e.at }); this.#dirty = true; }
        return;
      case 'item.delta': {
        const open = this.#open.get(`${id}:${e.id}`);
        if (open && typeof e.text === 'string' && open.text.length < AGENT_CHARS * 2) { open.text += e.text; this.#dirty = true; }
        return;
      }
      case 'item.done': {
        const key = `${id}:${e.id}`;
        const open = this.#open.get(key);
        if (!open) return;
        this.#open.delete(key);
        this.#dirty = true;
        const text = flat(open.text);
        if (text) this.#add(chat, { who: 'agent', seq: e.seq, at: e.at ?? open.at, text: clip(text, AGENT_CHARS) });
        return;
      }
      case 'history.reset':
        // The rewritten log replays kept history after this reset marker.
        chat.entries = [];
        chat.resetSeq = e.seq ?? chat.resetSeq;
        if (!fromLog) { chat.liveSeqs.clear(); if (typeof e.seq === 'number') chat.liveSeqs.add(e.seq); }
        this.#reindex(chat);
        for (const key of this.#open.keys()) if (key.startsWith(`${id}:`)) this.#open.delete(key);
        this.#dirty = true;
        return;
      default:
    }
  }

  /** Read what a chat's log holds beyond what is indexed. Returns true when something was read. */
  async #readLog(id) {
    const pending = [];
    this.#pending.set(id, pending);
    try { return await this.#scanLog(id); }
    finally {
      this.#pending.delete(id);
      for (const event of pending) this.note(id, event);
    }
  }

  async #scanLog(id) {
    const file = join(this.#dir, `${id}.jsonl`);
    let info;
    try { info = statSync(file); } catch { return false; }
    const size = info.size;
    const chat = this.#chat(id);
    const fileKey = `${info.dev}:${info.ino}`;
    const stampChanged = chat.mtimeMs != null && chat.ctimeMs != null
      && (chat.mtimeMs !== info.mtimeMs || chat.ctimeMs !== info.ctimeMs);
    const readRange = async (position, length) => {
      if (length <= 0) return Buffer.alloc(0);
      const small = length <= SCAN_BYTES;
      let fd;
      try {
        // Keep tiny guards and normal chat reads cheap. Large reads use the
        // file worker pool, so disk work does not hold up live chat events.
        fd = small ? openSync(file, 'r') : await open(file, 'r');
        const bytes = Buffer.alloc(length);
        let count = 0;
        while (count < length) {
          const n = small ? readSync(fd, bytes, count, length - count, position + count)
            : (await fd.read(bytes, count, length - count, position + count)).bytesRead;
          if (!n) break;
          count += n;
        }
        this.#bytesRead += count;
        return bytes.subarray(0, count);
      } catch { return null; }
      finally {
        if (fd !== undefined) {
          if (small) closeSync(fd);
          else await fd.close();
        }
      }
    };
    if (size === chat.size && fileKey === chat.fileKey && !stampChanged && !chat.offsetMissing) return false;
    let replaced = !!chat.fileKey && fileKey !== chat.fileKey;
    if (!replaced && chat.fileKey && stampChanged) {
      const prefix = await readRange(0, Math.min(32, chat.size));
      const tailLength = Math.min(32, chat.offset);
      const tail = await readRange(chat.offset - tailLength, tailLength);
      replaced = size <= chat.size || (!!chat.prefix && !!chat.tail && (!prefix || !tail
        || prefix.toString('base64') !== chat.prefix || tail.toString('base64') !== chat.tail));
    }
    if (replaced) {
      chat.entries = [];
      this.#reindex(chat);
      for (const key of this.#open.keys()) if (key.startsWith(`${id}:`)) this.#open.delete(key);
      chat.last = 0;
      chat.diskLast = 0;
      chat.resetSeq = 0;
      chat.liveSeqs.clear();
      chat.offset = 0;
    }
    if (size < chat.offset) chat.offset = 0;
    const body = await readRange(chat.offset, Math.max(0, size - chat.offset));
    if (!body) return false;
    const start = chat.offset;
    let after = chat.diskLast;
    let consumed = 0;
    const checkpoint = chat.diskLast;
    let legacyOpen = this.#restoreOpenFromLogs.has(id) ? new Map() : null;
    const mergeLegacyOpen = () => {
      if (!legacyOpen) return;
      for (const [key, open] of legacyOpen) if (!this.#open.has(key)) this.#open.set(key, open);
      legacyOpen = null;
    };
    const accept = (raw) => {
      if (!raw) return;
      let e;
      try { e = JSON.parse(raw); } catch { return; }
      acceptEvent(e);
    };
    const acceptEvent = (e) => {
      if (legacyOpen && typeof e.seq === 'number' && e.seq > checkpoint) mergeLegacyOpen();
      if (legacyOpen) {
        const key = `${id}:${e.id}`;
        if (e.type === 'history.reset') for (const k of legacyOpen.keys()) legacyOpen.delete(k);
        else if (e.type === 'item.start' && (e.kind === 'text' || e.kind === 'message')) legacyOpen.set(key, { text: '', at: e.at });
        else if (e.type === 'item.delta' && legacyOpen.has(key) && typeof e.text === 'string' && legacyOpen.get(key).text.length < AGENT_CHARS * 2) legacyOpen.get(key).text += e.text;
        else if (e.type === 'item.done') legacyOpen.delete(key);
      }
      if (legacyOpen && typeof e.seq === 'number' && e.seq <= checkpoint) return;
      if (typeof e.seq === 'number' && e.seq <= chat.resetSeq) {
        after = Math.max(after, e.seq); chat.diskLast = Math.max(chat.diskLast, e.seq); return;
      }
      if (e.type === 'history.reset' && typeof e.seq === 'number') {
        after = e.seq;
        chat.diskLast = e.seq;
        mergeLegacyOpen();
        this.note(id, e, { fromLog: true });
        return;
      }
      if (typeof e.seq === 'number' && e.seq <= after) return;
      if (typeof e.seq === 'number') {
        after = e.seq;
        chat.diskLast = e.seq;
      }
      if (legacyOpen && typeof e.seq === 'number' && e.seq > checkpoint) mergeLegacyOpen();
      if (typeof e.seq === 'number' && chat.liveSeqs.has(e.seq)) return;
      this.note(id, e, { fromLog: true });
    };
    // Leave the final record with JSON.parse, including its existing recovery
    // for a valid event without a newline or a torn write completed later.
    const complete = body.lastIndexOf(10) + 1;
    while (consumed < complete) {
      const start = consumed;
      let end = body.lastIndexOf(10, Math.min(start + SCAN_BYTES, complete) - 1) + 1;
      // A single record can exceed the target block size. Keep it whole.
      if (end <= start) end = body.indexOf(10, start) + 1;
      const block = body.subarray(start, end);
      const rows = extractSearchEvents(block);
      if (rows) {
        for (const [event, from, to] of rows) {
          if (!event) { accept(block.toString('utf8', from, to)); continue; }
          if (from != null) {
            const key = `${id}:${event.id}`;
            const open = this.#open.get(key);
            const legacy = legacyOpen?.get(key);
            if ((open && open.text.length < AGENT_CHARS * 2) || (legacy && legacy.text.length < AGENT_CHARS * 2)) {
              event.text = JSON.parse(block.toString('utf8', from, to));
            }
          }
          acceptEvent(event);
        }
        consumed = end;
      } else {
        while (consumed < end) {
          const newline = body.indexOf(10, consumed);
          const raw = body.toString('utf8', consumed, newline);
          consumed = newline + 1;
          accept(raw);
        }
      }
      if (consumed < complete) await new Promise(resolve => setImmediate(resolve));
    }
    if (consumed < body.length) {
      const raw = body.toString('utf8', consumed);
      try { JSON.parse(raw); accept(raw); } catch { /* Keep a torn tail for the next read. */ }
    }
    mergeLegacyOpen();
    this.#restoreOpenFromLogs.delete(id);
    chat.liveSeqs.prune(chat.diskLast);
    chat.offset = start + consumed;
    chat.size = size;
    chat.offsetMissing = false;
    chat.fileKey = fileKey;
    chat.mtimeMs = info.mtimeMs;
    chat.ctimeMs = info.ctimeMs;
    const prefix = await readRange(0, Math.min(32, size));
    const tailLength = Math.min(32, chat.offset);
    const tail = await readRange(chat.offset - tailLength, tailLength);
    chat.prefix = prefix?.toString('base64');
    chat.tail = tail?.toString('base64');
    this.#dirty = true;
    return true;
  }

  /**
   * Bring the index up to date with the logs of these chats. The first call
   * after install reads every log once (about a second for hundreds of
   * chats); later calls read only logs that grew. Chats no longer listed are
   * dropped. Between blocks it lets the daemon breathe, so a chat streaming a
   * reply does not stall behind the read; live events noted meanwhile keep
   * their place by `seq`.
   */
  update(sessions) {
    // One pass owns the offsets. A second search must not start the same read
    // while the first is waiting for disk or letting chat events run.
    const run = () => this.#update(sessions);
    const work = this.#updates ? this.#updates.then(run, run) : run();
    this.#updates = work;
    const done = () => { if (this.#updates === work) this.#updates = null; };
    work.then(done, done);
    return work;
  }

  async #update(sessions) {
    const keep = new Set();
    let read = 0;
    for (const s of sessions) {
      if (!searchable(s)) continue;
      keep.add(s.id);
      if (!await this.#readLog(s.id)) continue;
      read++;
      await new Promise((resolve) => setImmediate(resolve));
      const chat = this.#chats.get(s.id);
      if (chat) chat.entries.sort((a, b) => a.seq - b.seq);
    }
    for (const id of this.#chats.keys()) if (!keep.has(id)) {
      this.#chats.delete(id);
      for (const key of this.#open.keys()) if (key.startsWith(`${id}:`)) this.#open.delete(key);
      this.#dirty = true;
    }
    if (this.#dirty) this.#scheduleSave();
    return read;
  }

  /** The first update reads every log: done once, shared by every search that arrives meanwhile. */
  ready(sessions) {
    if (!this.#built) {
      const started = Date.now();
      this.#built = this.update(sessions).then((read) => {
        if (read) this.log(`search index: read ${read} chat logs in ${Date.now() - started} ms`);
      });
      return this.#built;
    }
    return this.#built.then(() => this.update(sessions));
  }

  /**
   * Chats where every word of the query appears in one thing said, or in the
   * title. Newest match first. `sessions` says which chats exist and how to
   * show them; the index only knows their words.
   */
  search(query, sessions, { limit = 20 } = {}) {
    const words = queryWords(query);
    if (!words.length) return [];
    const out = [];
    for (const s of sessions) {
      if (!searchable(s)) continue;
      const chat = this.#chats.get(s.id);
      const title = flat(s.title);
      const titleHit = title && words.every((w) => title.toLowerCase().includes(w));
      let best = null, count = 0;
      if (chat) {
        const key = JSON.stringify(words);
        let cached = chat.matchCache;
        if (!cached || cached.key !== key) {
          let found = null;
          let matches = 0;
          if (chat.lower == null) chat.lower = chat.entries.map(e => e.lower ??= e.text.toLowerCase()).join('\n');
          if (words.every((w) => chat.lower.includes(w))) {
            for (let i = chat.entries.length - 1; i >= 0; i--) {
              const entry = chat.entries[i];
              if (!words.every((w) => entry.lower.includes(w))) continue;
              matches++;
              if (!found) found = entry;
            }
          }
          cached = chat.matchCache = { key, best: found, count: matches };
        }
        best = cached.best;
        count = cached.count;
      }
      if (!best && !titleHit) continue;
      out.push({
        id: s.id, title: s.title ?? '', cwd: s.cwd ?? '', quick: !!s.quick, engine: s.engine ?? '', archived: !!s.archived,
        updatedAt: s.updatedAt ?? 0, count,
        who: best ? best.who : 'title', seq: best?.seq ?? 0, at: best?.at ?? s.updatedAt ?? 0,
        snippet: best ? snippetFor(best.text, words) : '',
      });
    }
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, limit);
  }

  #scheduleSave() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => { this.#saveTimer = null; this.save(); }, SAVE_AFTER_MS);
    this.#saveTimer.unref?.();
  }

  /** Write the index now (normally it waits a few seconds and writes once). */
  save() {
    if (this.#saveTimer) { clearTimeout(this.#saveTimer); this.#saveTimer = null; }
    if (!this.#dirty) return false;
    const chats = {};
    for (const [id, chat] of this.#chats) {
      const { last, diskLast, resetSeq, size, offset, fileKey, mtimeMs, ctimeMs, prefix, tail, entries, liveSeqs } = chat;
      chats[id] = {
        last, diskLast, resetSeq, liveRanges: liveSeqs.ranges, size, offset, fileKey, mtimeMs, ctimeMs, prefix, tail,
        entries: entries.map(({ who, seq, at, text }) => ({ who, seq, at, text })),
      };
    }
    try {
      mkdirSync(join(this.#file, '..'), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 2, chats, open: Object.fromEntries(this.#open) }));
      renameSync(tmp, this.#file);
      this.#dirty = false;
      return true;
    } catch (error) {
      this.log(`search index: could not save: ${error.message}`);
      return false;
    }
  }

  /** On the way down: nothing lost, nothing left half-written. */
  close() { this.save(); }
}
