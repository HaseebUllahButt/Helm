import { txn } from './idb';
import type { Client } from './client';

/**
 * The machine's agent list (`profile.list`), remembered on the device.
 *
 * "New session" asked the machine and showed "looking for agents…" until it
 * answered - instantly on the LAN, twenty to thirty seconds when the VM was
 * struggling or its link was stale, and the owner sat in front of an empty
 * screen. The list changes only when a CLI is installed, signed in or
 * hidden, which is rare and never urgent. So, as with models: paint what
 * this device last heard, ask anyway, replace when the answer lands.
 */

/** Old enough that showing it without asking would be a guess, not a memory. */
const KEEP_MS = 14 * 24 * 60 * 60_000;

const key = (env: string) => `accounts:${env}`;

/** The whole `profile.list` reply: profiles plus the machine's picker choices. */
export interface ProfileList { profiles: any[]; picker?: any }
interface Stored { at: number; list: ProfileList }

/** What this device last heard, or null. Never throws. */
export async function loadAccounts(env: string): Promise<ProfileList | null> {
  try {
    const rec = await txn<Stored | undefined>('kv', 'readonly', (s) => s.get(key(env)));
    if (!rec?.list?.profiles || Date.now() - rec.at > KEEP_MS) return null;
    return rec.list;
  } catch { return null; }
}

/** Remember what the machine just said. Never throws. */
export async function saveAccounts(env: string, list: ProfileList): Promise<void> {
  try {
    await txn('kv', 'readwrite', (s) => s.put({ at: Date.now(), list } satisfies Stored, key(env)));
  } catch { /* the network path still works */ }
}

/**
 * The remembered list first (if there is one), then the machine's own
 * answer. `apply` runs once or twice; `fresh` says which. A failure to reach
 * the machine goes to `onError` - after the remembered list is up, so the
 * screen is usable while it says so. Returns a function that stops both.
 */
export function watchAccounts(
  client: Client, env: string,
  apply: (list: ProfileList, fresh: boolean) => void,
  onError: (message: string) => void,
): () => void {
  let stale = false, answered = false;
  void loadAccounts(env).then((cached) => {
    if (stale || answered || !cached) return;
    apply(cached, false);
  });
  client.rpc<ProfileList>(env, 'profile.list')
    .then((r) => {
      if (stale) return;
      answered = true;
      void saveAccounts(env, r);
      apply(r, true);
    })
    .catch((e) => { if (!stale) onError(e.message); });
  return () => { stale = true; };
}

/** Ask ahead of time - from the folder screen - so the agent step is ready. */
export function prefetchAccounts(client: Client, env: string): void {
  client.rpc<ProfileList>(env, 'profile.list').then((r) => saveAccounts(env, r)).catch(() => { /* asked again later */ });
}
