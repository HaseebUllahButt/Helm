import { txn } from './idb';
import type { ModelList } from './client';

/**
 * The model catalogue, remembered on the device.
 *
 * Asking for it is the most expensive read in the app: the daemon shells out
 * to the CLI, which for opencode means a process that enumerates dozens of
 * models, and the daemon only holds that answer for a few minutes. So every
 * cold open of a model picker or the settings screen paid a relay round trip
 * plus, often, a process spawn - long enough that the RPC carries a 45 second
 * timeout and the screen has a "asking the CLI for its models…" state.
 *
 * A catalogue changes when a CLI is upgraded or its config is edited, which is
 * rare and never urgent. So: paint what we had, ask anyway, replace when the
 * answer lands. The same shape as the chat cache, for the same reason.
 */

/** Old enough that showing it without asking would be a guess, not a memory. */
const KEEP_MS = 14 * 24 * 60 * 60_000;

const key = (env: string, profileId: string, all?: boolean) =>
  `models:${env}:${profileId}:${all ? 'all' : 'picker'}`;

interface Stored { at: number; list: ModelList }

/** What this device last heard, or null. Never throws. */
export async function loadModels(
  env: string, profileId: string, all?: boolean,
): Promise<ModelList | null> {
  try {
    const rec = await txn<Stored | undefined>('kv', 'readonly', (s) => s.get(key(env, profileId, all)));
    if (!rec?.list || Date.now() - rec.at > KEEP_MS) return null;
    return rec.list;
  } catch { return null; }
}

/** Remember what the machine just said. Never throws. */
export async function saveModels(
  env: string, profileId: string, list: ModelList, all?: boolean,
): Promise<void> {
  try {
    const k = key(env, profileId, all);
    await txn('kv', 'readwrite', (s) => s.put({ at: Date.now(), list } satisfies Stored, k));
  } catch { /* the network path still works */ }
}
