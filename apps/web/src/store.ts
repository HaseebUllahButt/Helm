/**
 * Where the pairing lives.
 *
 * A device pairs once and must stay paired: through app restarts, reboots,
 * updates, and a phone that evicts "unused" site data. localStorage is the
 * fast path; IndexedDB is the copy that survives a cleared localStorage (they
 * are evicted independently on some browsers) and is what the installed PWA
 * reads when it launches. Whichever has it wins; both are rewritten on save.
 */
const KEY = 'helm.auth';
const DB = 'helm';
const STORE = 'kv';

export interface StoredAuth { endpoints: string[]; token: string; deviceId?: string }

function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function idbGet(): Promise<StoredAuth | null> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as StoredAuth) ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function idbSet(value: StoredAuth | null) {
  const db = await idb();
  if (!db) return;
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    value ? store.put(value, KEY) : store.delete(KEY);
  } catch { /* best effort */ }
}

function localGet(): StoredAuth | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw?.token) return null;
    if (Array.isArray(raw.endpoints)) return raw;
    // Older versions stored one relay address.
    return raw.relay ? { endpoints: [raw.relay], token: raw.token } : null;
  } catch { return null; }
}

/** Synchronous first look, so the app can render without a loading flash. */
export const loadAuthSync = localGet;

/** The durable copy, for when localStorage came up empty. */
export async function loadAuthDurable(): Promise<StoredAuth | null> {
  const local = localGet();
  if (local) return local;
  const durable = await idbGet();
  if (durable) { try { localStorage.setItem(KEY, JSON.stringify(durable)); } catch { /* full */ } }
  return durable;
}

export function saveAuth(a: StoredAuth) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* private mode */ }
  idbSet(a);
  // Ask the browser not to evict this origin's storage under pressure.
  navigator.storage?.persist?.().catch(() => {});
}

export function clearAuth() {
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
  idbSet(null);
}
