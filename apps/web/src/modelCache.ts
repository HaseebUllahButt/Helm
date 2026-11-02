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

/**
 * The same lists, held in memory for this page. A chat screen starts fresh
 * on every chat switch; reading the device's storage takes a moment, and in
 * that moment the model chip showed a raw name or nothing (owner, 2026-10-31).
 */
const memory = new Map<string, ModelList>();

/** What this page last heard, at once; null on the first look. */
export function peekModels(env: string, profileId: string, all?: boolean): ModelList | null {
  return memory.get(key(env, profileId, all)) ?? null;
}

/**
 * Fill the memory from the device's storage once, when the app opens, so
 * the first visit to a chat also has its list at once. Never throws.
 */
export async function warmModels(): Promise<void> {
  try {
    const range = IDBKeyRange.bound('models:', 'models:\uffff');
    const keys = await txn<IDBValidKey[]>('kv', 'readonly', (s) => s.getAllKeys(range));
    const recs = await txn<Stored[]>('kv', 'readonly', (s) => s.getAll(range));
    keys.forEach((k, i) => {
      const rec = recs[i];
      if (typeof k === 'string' && rec?.list && Date.now() - rec.at <= KEEP_MS && !memory.has(k)) memory.set(k, rec.list);
    });
  } catch { /* the machine still answers */ }
}

/** What this device last heard, or null. Never throws. */
export async function loadModels(
  env: string, profileId: string, all?: boolean,
): Promise<ModelList | null> {
  try {
    const rec = await txn<Stored | undefined>('kv', 'readonly', (s) => s.get(key(env, profileId, all)));
    if (!rec?.list || Date.now() - rec.at > KEEP_MS) return null;
    if (!memory.has(key(env, profileId, all))) memory.set(key(env, profileId, all), rec.list);
    return rec.list;
  } catch { return null; }
}

/** Remember what the machine just said. Never throws. */
export async function saveModels(
  env: string, profileId: string, list: ModelList, all?: boolean,
): Promise<void> {
  memory.set(key(env, profileId, all), list);
  try {
    const k = key(env, profileId, all);
    await txn('kv', 'readwrite', (s) => s.put({ at: Date.now(), list } satisfies Stored, k));
  } catch { /* the network path still works */ }
}
