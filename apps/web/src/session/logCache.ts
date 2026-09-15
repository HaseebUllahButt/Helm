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
 */

const DB = 'helm';
const STORE = 'session-logs';
const VERSION = 1;
/** Stored event shape version; bump when HelmEvent changes incompatibly. */
const SHAPE = 1;
/** How many sessions to keep records for; opening an old chat just refetches. */
const MAX_SESSIONS = 25;

interface Record {
  key: string;
  shape: number;
  at: number;
  last: number;
  events: HelmEvent[];
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
    if (!rec || rec.shape !== SHAPE || !Array.isArray(rec.events)) return null;
    // Touch for LRU without rewriting the payload.
    txn('readwrite', (s) => s.put({ ...rec, at: Date.now() })).catch(() => {});
    return { last: rec.last, events: rec.events };
  } catch {
    return null;
  }
}

/** Replace the stored log. Prunes the least-recently-opened sessions. Never throws. */
export async function saveCached(env: string, sessionId: string, last: number, events: HelmEvent[]): Promise<void> {
  try {
    const key = `${env}:${sessionId}`;
    await txn('readwrite', (s) => s.put({ key, shape: SHAPE, at: Date.now(), last, events } satisfies Record));
    const keys = await txn<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    if (keys.length > MAX_SESSIONS) {
      const all = await txn<Record[]>('readonly', (s) => s.getAll());
      all.sort((a, b) => a.at - b.at);
      const drop = all.slice(0, all.length - MAX_SESSIONS);
      if (drop.length) {
        await txn('readwrite', (s) => {
          for (const r of drop) s.delete(r.key);
          return s.get(key);
        });
      }
    }
  } catch {
    /* cache is best-effort; the network path still works */
  }
}
