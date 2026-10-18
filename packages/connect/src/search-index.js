import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';
import { EVENTS_DIR } from './events.js';
import { ownerText } from './owner-keeper.js';

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

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

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
  /** chat id -> { last: seq, size: bytes read, entries: [{ who, seq, at, text }] } */
  #chats = new Map();
  /** item id -> growing text, for agent replies arriving in pieces */
  #open = new Map();
  #dir; #file; #saveTimer = null; #dirty = false; #built = null;
  log;

  constructor({ dir = EVENTS_DIR, file = SEARCH_FILE, log = () => {} } = {}) {
    this.#dir = dir; this.#file = file; this.log = log;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved?.v === 1 && saved.chats && typeof saved.chats === 'object') {
        for (const [id, chat] of Object.entries(saved.chats)) {
          if (Array.isArray(chat?.entries)) this.#chats.set(id, { last: Number(chat.last) || 0, size: Number(chat.size) || 0, entries: chat.entries });
        }
      }
    } catch { /* no index yet, or unreadable: built again from the logs */ }
  }

  get size() { return this.#chats.size; }

  #chat(id) {
    let chat = this.#chats.get(id);
    if (!chat) { chat = { last: 0, size: 0, entries: [] }; this.#chats.set(id, chat); }
    return chat;
  }

  #add(chat, entry) {
    const text = flat(entry.text);
    if (!text) return;
    // The owner's message is logged when sent and again when the CLI echoes it.
    const prev = chat.entries[chat.entries.length - 1];
    if (prev && prev.who === entry.who && prev.text === text) { prev.seq = Math.max(prev.seq, entry.seq); return; }
    chat.entries.push({ who: entry.who, seq: entry.seq, at: entry.at, text });
    if (chat.entries.length > MAX_ENTRIES) chat.entries.splice(0, chat.entries.length - MAX_ENTRIES);
    this.#dirty = true;
  }

  /** One event of one chat, live or read from its log. */
  note(id, e) {
    if (!e || typeof e !== 'object') return;
    const chat = this.#chat(id);
    if (typeof e.seq === 'number' && e.seq > chat.last) chat.last = e.seq;
    switch (e.type) {
      case 'turn.start': {
        if (e.local || e.wake) return;
        const said = ownerText(e.text);
        if (said) this.#add(chat, { who: 'you', seq: e.seq, at: e.at, text: clip(said, YOU_CHARS) });
        return;
      }
      case 'item.start':
        if (e.kind === 'text' || e.kind === 'message') this.#open.set(`${id}:${e.id}`, { text: '', at: e.at });
        return;
      case 'item.delta': {
        const open = this.#open.get(`${id}:${e.id}`);
        if (open && typeof e.text === 'string' && open.text.length < AGENT_CHARS * 2) open.text += e.text;
        return;
      }
      case 'item.done': {
        const key = `${id}:${e.id}`;
        const open = this.#open.get(key);
        if (!open) return;
        this.#open.delete(key);
        const text = flat(open.text);
        if (text) this.#add(chat, { who: 'agent', seq: e.seq, at: e.at ?? open.at, text: clip(text, AGENT_CHARS) });
        return;
      }
      case 'history.reset':
        // The chat was rewound or restored: what came after is gone from it.
        chat.entries = chat.entries.filter((x) => typeof e.seq !== 'number' || x.seq < e.seq);
        for (const key of this.#open.keys()) if (key.startsWith(`${id}:`)) this.#open.delete(key);
        this.#dirty = true;
        return;
      default:
    }
  }

  /** Read what a chat's log holds beyond what is indexed. Returns true when something was read. */
  #readLog(id) {
    const file = join(this.#dir, `${id}.jsonl`);
    let size;
    try { size = statSync(file).size; } catch { return false; }
    const chat = this.#chat(id);
    if (size === chat.size) return false;
    let body;
    try { body = readFileSync(file, 'utf8'); } catch { return false; }
    const after = chat.last;
    for (const raw of body.split('\n')) {
      if (!raw) continue;
      let e;
      try { e = JSON.parse(raw); } catch { continue; }
      if (typeof e.seq === 'number' && e.seq <= after && e.type !== 'history.reset') continue;
      this.note(id, e);
    }
    chat.size = size;
    this.#dirty = true;
    return true;
  }

  /**
   * Bring the index up to date with the logs of these chats. The first call
   * after install reads every log once (about a second for hundreds of
   * chats); later calls read only logs that grew. Chats no longer listed are
   * dropped. Between logs it lets the daemon breathe, so a chat streaming a
   * reply does not stall behind the read; live events noted meanwhile keep
   * their place by `seq`.
   */
  async update(sessions) {
    const keep = new Set();
    let read = 0;
    for (const s of sessions) {
      if (!searchable(s)) continue;
      keep.add(s.id);
      if (!this.#readLog(s.id)) continue;
      read++;
      await new Promise((resolve) => setImmediate(resolve));
      const chat = this.#chats.get(s.id);
      if (chat) chat.entries.sort((a, b) => a.seq - b.seq);
    }
    for (const id of this.#chats.keys()) if (!keep.has(id)) { this.#chats.delete(id); this.#dirty = true; }
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
        for (let i = chat.entries.length - 1; i >= 0; i--) {
          const entry = chat.entries[i];
          const lower = entry.text.toLowerCase();
          if (!words.every((w) => lower.includes(w))) continue;
          count++;
          if (!best) best = entry;
        }
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
    for (const [id, chat] of this.#chats) chats[id] = chat;
    try {
      mkdirSync(join(this.#file, '..'), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, chats }));
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
