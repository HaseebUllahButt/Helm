import type { HelmEvent } from './types';
import { txn } from '../idb';

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

/** Stored event shape version; bump when HelmEvent changes incompatibly. */
// Version 1 windows could attach a running turn to a queued steering ticket.
// Fetch a corrected window instead of continuing from that incomplete cache.
const SHAPE = 2;
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

/**
 * The store keeps its keys out of line - `kv` next door needs that, and one
 * rule for the database is simpler than two - so every write passes the key
 * beside the record. A `put` without it throws `DataError`, which is exactly
 * what used to happen here, into a `catch` that said nothing.
 */
interface Record {
  key: string;
  /** Absent means the event-log records that existed before messages were cached. */
  kind?: 'events' | 'messages';
  shape: number;
  at: number;
  last?: number;
  /**
   * The seq this record's window starts at, which is not always its first
   * event's: a window that lands inside a long turn carries that turn's
   * opening line and nothing else from in front of it. Without this the gap
   * disappears on the next open and the app says a partial chat is whole.
   */
  first?: number;
  events?: HelmEvent[];
  messages?: unknown[];
}

// Returning to a chat must not queue behind this device's disk writes.
// Bound both count and bytes so a long-running phone never retains every log.
const hot = new Map<string, { record: Record; bytes: number }>();
const writes = new Map<string, Promise<void>>();
let hotBytes = 0;
function remember(record: Record) {
  let bytes = 0;
  const pending: unknown[] = [record];
  while (pending.length && bytes <= 4_000_000) {
    const value = pending.pop();
    if (typeof value === 'string') bytes += value.length * 2;
    else if (value && typeof value === 'object') for (const part of Object.values(value)) pending.push(part);
    else bytes += 8;
  }
  const previous = hot.get(record.key);
  if (previous) { hotBytes -= previous.bytes; hot.delete(record.key); }
  if (bytes > 4_000_000) return;
  hot.set(record.key, { record, bytes }); hotBytes += bytes;
  while (hot.size > 8 || hotBytes > 12_000_000) {
    const oldest = hot.entries().next().value!;
    hot.delete(oldest[0]); hotBytes -= oldest[1].bytes;
  }
}
function recall(key: string): Record | undefined {
  const entry = hot.get(key);
  if (entry) { hot.delete(key); hot.set(key, entry); }
  return entry?.record;
}
async function write(record: Record): Promise<void> {
  remember(record);
  const next = (writes.get(record.key) ?? Promise.resolve()).then(async () => {
    const fresh = !(await known(record.key));
    await txn('session-logs', 'readwrite', s => s.put(record, record.key));
    if (fresh) await prune(record.key);
  }).catch(() => {});
  writes.set(record.key, next);
  await next;
  if (writes.get(record.key) === next) writes.delete(record.key);
}

/**
 * Keep the contiguous tail plus the small owner/item context needed to
 * render it. The real tail boundary remains separate from sparse anchors.
 */
function trim(events: HelmEvent[]): { events: HelmEvent[]; first: number } {
  if (events.length <= MAX_EVENTS) return { events, first: 0 };
  const from = events.length - MAX_EVENTS;
  const tail = events.slice(from);
  const owners = new Set(tail.map(e => e.turnId).filter(Boolean));
  const items = new Set(tail.filter(e => e.type.startsWith('item.')).map(e => e.id));
  const context: HelmEvent[] = [];
  for (const event of events.slice(0, from)) {
    if (event.type === 'item.start' && items.has(event.id)) {
      context.push(event); if (event.turnId) owners.add(event.turnId);
    }
  }
  for (const event of events.slice(0, from)) {
    if (owners.has(event.turnId) && event.type.startsWith('turn.')) context.push(event);
  }
  return { events: [...context, ...tail].sort((a, b) => a.seq - b.seq), first: tail[0].seq };
}

/** The stored log for a session, or null on a miss / version skew / any failure. */
export async function loadCached(env: string, sessionId: string): Promise<{ last: number; first: number; events: HelmEvent[] } | null> {
  try {
    const key = `${env}:${sessionId}`;
    const cached = recall(key);
    const rec = cached ?? await txn<Record | undefined>('session-logs', 'readonly', (s) => s.get(key));
    if (!rec || rec.shape !== SHAPE || rec.kind === 'messages' || !Array.isArray(rec.events)) return null;
    if (!cached) remember(rec);
    // No LRU touch here: it rewrote the whole payload to change one number,
    // and the save that follows every open's refresh stamps `at` anyway.
    return { last: rec.last ?? 0, first: rec.first ?? rec.events[0]?.seq ?? 0, events: rec.events };
  } catch {
    return null;
  }
}

/** Replace the stored log. Prunes the least-recently-opened sessions. Never throws. */
export async function saveCached(env: string, sessionId: string, last: number, events: HelmEvent[], first = 0): Promise<void> {
  try {
    const key = `${env}:${sessionId}`;
    const kept = trim(events);
    await write(
      { key, kind: 'events', shape: SHAPE, at: Date.now(), last,
        first: Math.max(first, kept.first), events: kept.events });
  } catch {
    /* cache is best-effort; the network path still works */
  }
}

/** The messages of a herdr-pane chat, or null on a miss or any failure. */
export async function loadMessages<T>(env: string, sessionId: string): Promise<T[] | null> {
  try {
    const key = `msg:${env}:${sessionId}`;
    const cached = recall(key);
    const rec = cached ?? await txn<Record | undefined>('session-logs', 'readonly', (s) => s.get(key));
    if (!rec || rec.shape !== SHAPE || !Array.isArray(rec.messages)) return null;
    if (!cached) remember(rec);
    return rec.messages as T[];
  } catch {
    return null;
  }
}

/** Replace a herdr-pane chat's stored messages. Never throws. */
export async function saveMessages(env: string, sessionId: string, messages: unknown[]): Promise<void> {
  try {
    const key = `msg:${env}:${sessionId}`;
    await write({ key, kind: 'messages', shape: SHAPE, at: Date.now(), messages });
  } catch {
    /* best-effort, as above */
  }
}

/**
 * Is there a record under this key already? A key-only lookup: the count can
 * only go over the limit when a new record arrives, and pruning reads every
 * record back - it used to, on each save, every 2s while a reply streamed.
 */
async function known(key: string): Promise<boolean> {
  const k = await txn<IDBValidKey | undefined>('session-logs', 'readonly', (s) => s.getKey(key));
  return k !== undefined;
}

/**
 * Drop the least recently opened records, counting the two kinds apart: a
 * handful of big event logs must not evict the cheap message records, and
 * fifty message records must not evict the event logs.
 */
async function prune(keep: string): Promise<void> {
  const keys = await txn<IDBValidKey[]>('session-logs', 'readonly', (s) => s.getAllKeys());
  if (keys.length <= MAX_SESSIONS) return;
  // Read only keys ordered by timestamp. getAll() copied every cached chat
  // into memory merely to evict one, stalling phones when a new chat opened.
  const ordered = await txn<IDBValidKey[]>('session-logs', 'readonly', s => s.index('at').getAllKeys());
  const drop: IDBValidKey[] = [];
  for (const [kind, max] of [['messages', MAX_MESSAGE_SESSIONS], ['events', MAX_SESSIONS]] as const) {
    const mine = ordered.filter(k => (String(k).startsWith('msg:') ? 'messages' : 'events') === kind);
    if (mine.length > max) drop.push(...mine.slice(0, mine.length - max));
  }
  if (!drop.length) return;
  await txn('session-logs', 'readwrite', (s) => {
    for (const key of drop) if (key !== keep) s.delete(key);
    return s.get(keep);
  });
}
