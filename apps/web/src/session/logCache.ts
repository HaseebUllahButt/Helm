import type { HelmEvent } from './types';

/**
 * On-device cache of session event logs, so opening a chat paints
 * instantly instead of after up to 8 relay round-trips of history paging.
 *
 * Flow: on open, the stored events (if any) are applied first and the UI
 * renders immediately; the hook then fetches only `since` the cached
 * last seq in the background, so the refresh is small and quick. Closing
 * the session (or finishing a refresh) rewrites the record, so nothing
 * is ever lost - at worst an abrupt kill re-fetches a few events.
 *
 * IndexedDB, not localStorage: a long chat's deltas run to megabytes and
 * localStorage caps at ~5MB shared with everything else. One record per
 * session holds the whole event array; only the most recently opened
 * sessions are kept.
 *
 * The herdr-pane chats keep their read-back messages here too, under their
 * own key. They are a different shape - whole messages re-read from the CLI's
 * transcript rather than an event stream - but the reason for caching them is
 * the same: a chat you have already read should not be a blank screen while
 * the network answers.
 */

const DB = 'helm';
const STORE = 'session-logs';
const VERSION = 1;
/** Stored event shape version; bump when HelmEvent changes incompatibly. */
const SHAPE = 1;
/** How many sessions to keep records for; opening an old chat just refetches. */
const MAX_SESSIONS = 25;
/** And how many for the much smaller message records. */
const MAX_MESSAGE_SESSIONS = 50;
/**
 * The most events one session's record holds. The daemon keeps 2000 and the
 * device is allowed to remember more than that - an event it has already been
 * told about is not lost just because the machine has since trimmed its log -
 * but not without end, since every save rewrites the whole array.
 */
const MAX_EVENTS = 4000;

interface Record {
  key: string;
  /** Absent means the event-log records that existed before messages were cached. */
  kind?: 'events' | 'messages';
  shape: number;
  at: number;
  last?: number;
  events?: HelmEvent[];
  messages?: unknown[];
}

/**
 * Trim from the front, on a turn boundary.
 *
 * Cutting mid-turn leaves deltas whose `turn.start` is gone; the reducer
 * drops those on the floor, so the chat would open with a headless fragment
 * at the top. Cutting at a turn start means the oldest thing on screen is a
 * whole exchange.
 */
function trim(events: HelmEvent[]): HelmEvent[] {
  if (events.length <= MAX_EVENTS) return events;
  const from = events.length - MAX_EVENTS;
  for (let i = from; i < events.length; i++) {
    if (events[i].type === 'turn.start') return events.slice(i);
  }
  return events.slice(from);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function txn<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

/** The stored log for a session, or null on a miss / version skew / any failure. */
export async function loadCached(env: string, sessionId: string): Promise<{ last: number; events: HelmEvent[] } | null> {
  try {
    const rec = await txn<Record | undefined>('readonly', (s) => s.get(`${env}:${sessionId}`));
    if (!rec || rec.shape !== SHAPE || rec.kind === 'messages' || !Array.isArray(rec.events)) return null;
    // Touch for LRU without rewriting the payload.
    txn('readwrite', (s) => s.put({ ...rec, at: Date.now() })).catch(() => {});
    return { last: rec.last ?? 0, events: rec.events };
  } catch {
    return null;
  }
}

/** Replace the stored log. Prunes the least-recently-opened sessions. Never throws. */
export async function saveCached(env: string, sessionId: string, last: number, events: HelmEvent[]): Promise<void> {
  try {
    const key = `${env}:${sessionId}`;
    await txn('readwrite', (s) => s.put(
      { key, kind: 'events', shape: SHAPE, at: Date.now(), last, events: trim(events) } satisfies Record));
    await prune(key);
  } catch {
    /* cache is best-effort; the network path still works */
  }
}

/** The messages of a herdr-pane chat, or null on a miss or any failure. */
export async function loadMessages<T>(env: string, sessionId: string): Promise<T[] | null> {
  try {
    const rec = await txn<Record | undefined>('readonly', (s) => s.get(`msg:${env}:${sessionId}`));
    if (!rec || rec.shape !== SHAPE || !Array.isArray(rec.messages)) return null;
    txn('readwrite', (s) => s.put({ ...rec, at: Date.now() })).catch(() => {});
    return rec.messages as T[];
  } catch {
    return null;
  }
}

/** Replace a herdr-pane chat's stored messages. Never throws. */
export async function saveMessages(env: string, sessionId: string, messages: unknown[]): Promise<void> {
  try {
    const key = `msg:${env}:${sessionId}`;
    await txn('readwrite', (s) => s.put({ key, kind: 'messages', shape: SHAPE, at: Date.now(), messages } satisfies Record));
    await prune(key);
  } catch {
    /* best-effort, as above */
  }
}

/**
 * Drop the least recently opened records, counting the two kinds apart: a
 * handful of big event logs must not evict the cheap message records, and
 * fifty message records must not evict the event logs.
 */
async function prune(keep: string): Promise<void> {
  const keys = await txn<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
  if (keys.length <= MAX_SESSIONS) return;
  const all = await txn<Record[]>('readonly', (s) => s.getAll());
  const drop: Record[] = [];
  for (const [kind, max] of [['messages', MAX_MESSAGE_SESSIONS], ['events', MAX_SESSIONS]] as const) {
    const mine = all.filter((r) => (r.kind ?? 'events') === kind).sort((a, b) => a.at - b.at);
    if (mine.length > max) drop.push(...mine.slice(0, mine.length - max));
  }
  if (!drop.length) return;
  await txn('readwrite', (s) => {
    for (const r of drop) if (r.key !== keep) s.delete(r.key);
    return s.get(keep);
  });
}
