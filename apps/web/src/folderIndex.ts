import { txn } from './idb';
import type { Client, DirEntry } from './client';

/**
 * A machine's folders, kept on the device so a picker searches as fast as
 * you type.
 *
 * Asking the machine per keystroke meant a round trip through the relay for
 * every letter - most of a second each over a VPN - with the list blank in
 * between. The machine sends its whole index instead (a tree of names, about
 * a hundred kilobytes for a busy home) and only again when it has changed;
 * the device remembers it, so a picker opens on yesterday's list at once and
 * the fresh one replaces it a moment later.
 */

export interface Folder { name: string; path: string; repo: boolean }
export interface FolderIndex { stamp: string; at: number; count: number; folders: Folder[] }

interface Wire {
  stamp: string; at: number; count: number; building?: boolean; unchanged?: boolean;
  names?: string[]; parents?: number[]; repos?: number[];
}
interface Stored { stamp: string; at: number; count: number; names: string[]; parents: number[]; repos: number[] }

const key = (env: string) => `folders:${env}`;
const memory = new Map<string, FolderIndex>();

function unpack({ stamp, at, count, names, parents, repos }: Stored): FolderIndex {
  const paths: string[] = new Array(names.length);
  const repo = new Set(repos);
  const folders: Folder[] = new Array(names.length);
  for (let i = 0; i < names.length; i++) {
    const p = parents[i];
    paths[i] = `${p < 0 ? '~' : paths[p]}/${names[i]}`;
    folders[i] = { name: names[i], path: paths[i], repo: repo.has(i) };
  }
  return { stamp, at, count, folders };
}

/** What this device last heard, or null. Never throws. */
export async function loadFolders(env: string): Promise<FolderIndex | null> {
  const hit = memory.get(env);
  if (hit) return hit;
  try {
    const rec = await txn<Stored | undefined>('kv', 'readonly', (s) => s.get(key(env)));
    if (!rec?.stamp || !Array.isArray(rec.names) || !Array.isArray(rec.parents)) return null;
    const index = unpack(rec);
    memory.set(env, index);
    return index;
  } catch { return null; }
}

/**
 * Ask the machine for its folders as they are now. Sends the stamp held, so
 * an unchanged index costs a few bytes. `refresh` makes the machine walk its
 * disk again even if its last walk is recent.
 */
export async function fetchFolders(client: Client, env: string, { refresh = false } = {}): Promise<FolderIndex> {
  const held = await loadFolders(env);
  const r = await client.rpc<Wire>(env, 'fs.index', { since: held?.stamp, refresh }, 20_000);
  if (r.unchanged && held) {
    const index = { ...held, at: r.at, count: r.count };
    memory.set(env, index);
    return index;
  }
  if (!r.names || !r.parents) throw new Error('The machine sent no folder list.');
  const rec: Stored = { stamp: r.stamp, at: r.at, count: r.count, names: r.names, parents: r.parents, repos: r.repos ?? [] };
  const index = unpack(rec);
  memory.set(env, index);
  void txn('kv', 'readwrite', (s) => s.put(rec, key(env))).catch(() => { /* memory still has it */ });
  return index;
}

/** A folder the device made itself: in the list now, before the machine says. */
export function rememberFolderMade(env: string, folder: Folder) {
  const index = memory.get(env);
  if (!index || index.folders.some((f) => f.path === folder.path)) return;
  memory.set(env, { ...index, folders: [...index.folders, folder] });
}

/**
 * Every typed word has to be in the path. An exact or leading name match
 * beats a substring, a repo beats a plain folder, and a shorter path wins
 * ties - the same order the machine's own search uses.
 */
export function searchFolders(folders: Folder[], query: string, limit = 30): Folder[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const q = words.join(' ');
  const scored: { f: Folder; score: number }[] = [];
  for (const f of folders) {
    const path = f.path.toLowerCase();
    if (!words.every((w) => path.includes(w))) continue;
    const name = f.name.toLowerCase();
    const rank = name === q ? 0 : name.startsWith(words[0]) ? 1 : name.includes(words[0]) ? 2 : 3;
    scored.push({ f, score: rank - (f.repo ? 0.5 : 0) });
  }
  scored.sort((a, b) => a.score - b.score || a.f.path.length - b.f.path.length || a.f.path.localeCompare(b.f.path));
  return scored.slice(0, limit).map((s) => s.f);
}

/**
 * What is inside one folder, at once, without asking the machine.
 *
 * Opening a folder used to wait on a trip to the machine, most of a second
 * over a VPN, with "looking…" in between. The last answer for that folder
 * comes first; failing that, the folder list this device already holds.
 * That list leaves out containers like node_modules and stops ten levels
 * down, so an empty answer from it means "not known", and the machine's own
 * answer (listFolder) still replaces it.
 */
const listed = new Map<string, DirEntry[]>();
const kids = new WeakMap<FolderIndex, Map<string, DirEntry[]>>();

export function knownInside(env: string, path: string): DirEntry[] | null {
  const seen = listed.get(`${env}\n${path}`);
  if (seen) return seen;
  const index = memory.get(env);
  if (!index) return null;
  let byParent = kids.get(index);
  if (!byParent) {
    byParent = new Map();
    for (const f of index.folders) {
      const parent = f.path.slice(0, f.path.lastIndexOf('/'));
      let list = byParent.get(parent);
      if (!list) byParent.set(parent, list = []);
      list.push({ name: f.name, path: f.path, isRepo: f.repo, skip: false });
    }
    // The machine's order: repos first, then by name.
    for (const list of byParent.values()) list.sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name));
    kids.set(index, byParent);
  }
  return byParent.get(path.replace(/\/+$/, '') || '/') ?? null;
}

/** Ask the machine what is inside a folder, and remember the answer. */
export async function listFolder(client: Client, env: string, path: string): Promise<{ path: string; entries: DirEntry[] }> {
  const r = await client.rpc<{ path: string; entries: DirEntry[] }>(env, 'fs.list', { path });
  listed.set(`${env}\n${path}`, r.entries);
  if (r.path !== path) listed.set(`${env}\n${r.path}`, r.entries);
  return r;
}
