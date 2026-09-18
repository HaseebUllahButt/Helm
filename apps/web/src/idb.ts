/**
 * One database, opened in one place.
 *
 * `helm` used to be opened twice: the pairing store (`store.ts`) and the chat
 * cache (`session/logCache.ts`) each called `indexedDB.open('helm', 1)` and
 * each created only its own object store in `onupgradeneeded`. Whichever ran
 * first created the database; the second one opened the same version, so its
 * upgrade never fired and its store never existed. Every read and write from
 * the loser then threw `NotFoundError` - and both modules swallow their
 * errors by design, so nothing ever said so.
 *
 * Which one lost depended on the launch. A device pairing for the first time
 * wrote `kv` first and no chat was ever cached; a device that launched with
 * its pairing already in localStorage opened a chat first, and then the
 * durable copy of the pairing - the thing that survives a browser evicting
 * localStorage - silently could not be written.
 *
 * So: one opener, one version, every store declared in it. The version is 2
 * because databases out there are at 1 with a store missing; opening at 2
 * runs the upgrade and creates whatever is not there, keeping what is.
 */

const NAME = 'helm';
const VERSION = 2;
const STORES = ['kv', 'session-logs'] as const;
export type Store = typeof STORES[number];

let conn: Promise<IDBDatabase | null> | null = null;

/** The shared connection, or null if this browser will not give us one. */
export function idb(): Promise<IDBDatabase | null> {
  if (conn) return conn;
  const attempt = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const done = (db: IDBDatabase | null) => { if (!settled) { settled = true; resolve(db); } };
    try {
      if (typeof indexedDB === 'undefined') return done(null);
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab is upgrading: let go of it and open again next time.
        db.onversionchange = () => { db.close(); conn = null; };
        db.onclose = () => { conn = null; };
        done(db);
      };
      req.onerror = () => done(null);
      // An older tab holding version 1 open blocks the upgrade. Do not hang
      // the caller on it; storage is best-effort everywhere it is used.
      req.onblocked = () => done(null);
      setTimeout(() => done(null), 5_000);
    } catch { done(null); }
  });
  conn = attempt.then((db) => { if (!db) conn = null; return db; });
  return conn;
}

/**
 * One request against one store. Rejects if the database is unusable, which
 * every caller treats as "no cache" rather than as an error worth showing.
 */
export async function txn<T>(
  store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await idb();
  if (!db) throw new Error('no indexedDB');
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
  });
}
