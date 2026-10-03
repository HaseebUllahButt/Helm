import { txn } from './idb';

/**
 * Where the pairing lives.
 *
 * A device pairs once and must stay paired: through app restarts, reboots,
 * updates, and a phone that evicts "unused" site data. localStorage is the
 * fast path; IndexedDB is the copy that survives a cleared localStorage (they
 * are evicted independently on some browsers) and is what the installed PWA
 * reads when it launches. Whichever has it wins; both are rewritten on save.
 *
 * The IndexedDB half goes through the shared opener in `idb.ts`, which exists
 * because this store and the chat cache used to race to create the database
 * and the loser's store was silently never there.
 */
const KEY = 'helm.auth';
let authRevision = 0;

// A durable read can be much slower than the local pairing action that
// started while it was waiting. Cross-tab writes do not call saveAuth in this
// module, so observe them as well as incrementing the local generation below.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) authRevision += 1;
  });
}

export interface StoredAuth { endpoints: string[]; token: string; deviceId?: string }

async function idbGet(): Promise<StoredAuth | null> {
  try { return (await txn<StoredAuth | undefined>('kv', 'readonly', (s) => s.get(KEY))) ?? null; }
  catch { return null; }
}

async function idbSet(value: StoredAuth | null) {
  try {
    if (value) await txn('kv', 'readwrite', (s) => s.put(value, KEY));
    else await txn('kv', 'readwrite', (s) => s.delete(KEY));
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
  const revision = authRevision;
  const durable = await idbGet();
  // saveAuth/clearAuth may have run while IndexedDB was blocked. Prefer the
  // current local view and never copy an old durable pairing over a newer
  // pairing (or a sign-out). A storage event covers the same race from
  // another tab; the second localGet also handles the event arriving just
  // before this continuation runs.
  const current = localGet();
  if (authRevision !== revision || current) return current;
  if (durable) {
    try {
      // Re-check immediately before the write: this is still one synchronous
      // turn, so a same-tab save cannot interleave between these statements.
      if (authRevision !== revision || localGet()) return localGet();
      localStorage.setItem(KEY, JSON.stringify(durable));
    } catch { /* full */ }
  }
  return durable;
}

export function saveAuth(a: StoredAuth) {
  authRevision += 1;
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* private mode */ }
  idbSet(a);
  // Ask the browser not to evict this origin's storage under pressure.
  navigator.storage?.persist?.().catch(() => {});
}

export function clearAuth() {
  authRevision += 1;
  try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ }
  idbSet(null);
}
