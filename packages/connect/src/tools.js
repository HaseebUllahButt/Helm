import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { HELM_DIR } from './paths.js';

/**
 * The tool registry: named local commands the owner keeps on a machine.
 * Each machine keeps only its own tools (`tools.json`). `helm tools list`
 * asks every machine, the way `helm schedule list` does. What a machine
 * last heard from the others is kept in `tools-seen.json`, so a tool on an
 * offline machine still shows, marked offline.
 */

export const TOOL_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const MAX_DESCRIPTION = 300;
const MAX_ARGV = 64;

/** Throws a plain message when a tool record is not valid. Never changes it. */
export function checkTool(tool) {
  if (!tool || typeof tool !== 'object') throw new Error('Give the tool as an object.');
  if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) {
    throw new Error('A tool name uses small letters, digits, dots, dashes or underscores, at most 48 characters, and starts with a letter or digit.');
  }
  if (tool.description != null && (typeof tool.description !== 'string' || tool.description.length > MAX_DESCRIPTION || /[\0\n\r]/.test(tool.description))) {
    throw new Error(`A description is one line of at most ${MAX_DESCRIPTION} characters.`);
  }
  const argv = tool.argv;
  if (!Array.isArray(argv) || !argv.length || argv.length > MAX_ARGV || argv.some((a) => typeof a !== 'string' || a.includes('\0')) || !argv[0] || argv.join('').length > 16 * 1024) {
    throw new Error('Give the command after --, for example: helm tools add hello -- echo hello');
  }
  if (tool.cwd != null && (typeof tool.cwd !== 'string' || !isAbsolute(tool.cwd) || tool.cwd.includes('\0'))) {
    throw new Error('The folder of a tool must be a full path.');
  }
  return tool;
}

const clean = (t) => ({
  name: t.name, argv: t.argv,
  ...(t.description ? { description: t.description } : {}),
  ...(t.cwd ? { cwd: t.cwd } : {}),
  createdAt: t.createdAt, updatedAt: t.updatedAt,
});

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export class Tools {
  constructor({ directory = HELM_DIR, now = Date.now } = {}) {
    this.file = join(directory, 'tools.json');
    this.seenFile = join(directory, 'tools-seen.json');
    this.now = now;
  }

  /** Bad records stay in the file as they are; they are only left out here. */
  #all() {
    const raw = readJson(this.file, { tools: [] });
    return Array.isArray(raw?.tools) ? raw.tools : [];
  }

  list() {
    return this.#all().filter((t) => { try { checkTool(t); return true; } catch { return false; } })
      .map(clean).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) { return this.list().find((t) => t.name === name) ?? null; }

  /** Add a tool, or change the one with this name. */
  save({ name, argv, description, cwd }) {
    const tool = checkTool({ name, argv, description: description || undefined, cwd: cwd || undefined });
    const all = this.#all();
    const at = all.findIndex((t) => t?.name === name);
    const now = this.now();
    const record = clean({ ...tool, createdAt: at >= 0 ? all[at].createdAt ?? now : now, updatedAt: now });
    if (at >= 0) all[at] = record; else all.push(record);
    writeJson(this.file, { tools: all });
    return { tool: record, replaced: at >= 0 };
  }

  remove(name) {
    const all = this.#all();
    const left = all.filter((t) => t?.name !== name);
    if (left.length === all.length) return { removed: false };
    writeJson(this.file, { tools: left });
    return { removed: true };
  }

  /** What this machine last heard from other machines: { [machineId]: { tools, at } }. */
  seen() {
    const raw = readJson(this.seenFile, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  /** Keep the newest list for each machine. Lists that fail the check are dropped. */
  remember(lists, self) {
    const seen = this.seen();
    let changed = false;
    for (const [id, entry] of Object.entries(lists ?? {})) {
      if (id === self || !entry || !Array.isArray(entry.tools) || !Number.isFinite(entry.at)) continue;
      if ((seen[id]?.at ?? 0) >= entry.at) continue;
      const tools = entry.tools.filter((t) => { try { checkTool(t); return true; } catch { return false; } }).map(clean);
      seen[id] = { tools, at: entry.at };
      changed = true;
    }
    if (changed) writeJson(this.seenFile, seen);
    return seen;
  }

  /** The answer to `tool.list`: own tools, plus the lists heard from others. */
  dispatchList({ seen = false } = {}) {
    return { tools: this.list(), ...(seen ? { seen: this.seen() } : {}), at: this.now() };
  }
}
