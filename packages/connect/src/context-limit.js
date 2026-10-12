import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accountKey } from './settings.js';

/**
 * "Compact at": how big a Claude conversation may grow before the CLI
 * summarises it. Claude Code keeps this per model in the account's
 * settings.json (`modelSettings.<model>.autoCompactWindow`, in tokens); with
 * no number it uses the model's whole window. Helm edits just that one key,
 * so the owner can change it from the app instead of by hand on each machine.
 */

/** `claude-opus-5-5[1m]` and `claude-haiku-4-5-20251001` are the settings' `claude-opus-5-5` and `claude-haiku-4-5`. */
export const bareModel = (id) => String(id).toLowerCase().replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');

/** Where this account's settings live: its own config directory, else the default one. */
export function configDir(env) {
  return (env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || '~/.claude').replace(/^~(?=\/|$)/, homedir());
}

const cache = new Map();

/**
 * The account's `modelSettings`, re-read only when the file changed, so a
 * change made from the app reaches a chat that is already open at its next
 * reply without reading the disk each time.
 */
function modelSettings(dir) {
  const file = join(dir, 'settings.json');
  try {
    const { mtimeMs, size } = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.value;
    const value = JSON.parse(readFileSync(file, 'utf8')).modelSettings ?? null;
    cache.set(file, { mtimeMs, size, value });
    return value;
  } catch { cache.delete(file); return null; }
}

/** The compaction window set for a model, or null when the account leaves it at the model's own. */
export function compactWindow(dir, model) {
  const entry = Object.entries(modelSettings(dir) ?? {}).find(([id]) => bareModel(id) === bareModel(model));
  const n = entry?.[1]?.autoCompactWindow;
  return n > 0 ? n : null;
}

/** Every model with a window set: { 'claude-opus-5-5': 383000 }. */
export function compactWindows(dir) {
  const out = {};
  for (const [id, v] of Object.entries(modelSettings(dir) ?? {})) if (v?.autoCompactWindow > 0) out[bareModel(id)] = v.autoCompactWindow;
  return out;
}

/**
 * Set a model's window, or take it away (null = the model's full window).
 * Everything else in the file stays as it was. The first change keeps a copy
 * of the original beside it; the write goes through a temp file so Claude
 * never reads half a file.
 */
export function setCompactWindow(dir, model, window) {
  const file = join(dir, 'settings.json');
  const real = existsSync(file) ? realpathSync(file) : file; // a dotfiles symlink stays a symlink
  const before = existsSync(real) ? readFileSync(real, 'utf8') : null;
  // A file we cannot read is the owner's to fix, never ours to replace.
  const settings = before === null ? {} : JSON.parse(before);
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json is not a JSON object');
  if (before === null && window === null) return false; // nothing set, nothing to take away
  const bare = bareModel(model);
  const ids = Object.keys(settings.modelSettings ?? {}).filter((id) => bareModel(id) === bare);
  if (window === null) {
    for (const id of ids) {
      delete settings.modelSettings[id].autoCompactWindow;
      if (!Object.keys(settings.modelSettings[id]).length) delete settings.modelSettings[id];
    }
    if (settings.modelSettings && !Object.keys(settings.modelSettings).length) delete settings.modelSettings;
  } else {
    if (settings.modelSettings === undefined || settings.modelSettings === null) settings.modelSettings = {};
    const id = ids[0] ?? bare;
    if (settings.modelSettings[id] === undefined || settings.modelSettings[id] === null) settings.modelSettings[id] = {};
    settings.modelSettings[id].autoCompactWindow = window;
    for (const other of ids.slice(1)) delete settings.modelSettings[other].autoCompactWindow; // one answer, not two
  }
  const after = JSON.stringify(settings, null, 2) + '\n';
  cache.delete(file);
  if (after === before) return false;
  if (before !== null) {
    try { writeFileSync(`${real}.backup-helm-compact`, before, { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const temp = `${real}.helm-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, after, { mode: before === null ? 0o600 : statSync(real).mode & 0o777, flag: 'wx' });
    renameSync(temp, real);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return true;
}

/**
 * The RPC: apply a limit to every Claude login on this machine that matches
 * (by profile, or by account key when the app asked from another machine).
 * A machine without that login answers `matched: 0`, which is not an error.
 * With no `window` key at all it only reads what is set.
 */
export function contextLimit(profiles, { profileId, account, model, window } = {}) {
  const claude = profiles.filter((x) => x.engine === 'claude' && !x.wraps);
  let key = account;
  if (!key && profileId) {
    const profile = profiles.find((x) => x.id === profileId);
    if (!profile) throw new Error(`unknown profile: ${profileId}`);
    key = accountKey(profile);
  }
  if (!key) throw new Error('say which account');
  if (window !== undefined && window !== null && !(Number.isInteger(window) && window >= 10_000 && window <= 100_000_000)) {
    throw new Error('the limit must be a whole number of tokens, 10000 or more');
  }
  // Arrives over the network and becomes a key in the owner's file.
  if (window !== undefined && (!/^[a-z][\w.:-]{0,79}$/i.test(bareModel(model ?? '')) || /^(__proto__|constructor|prototype)$/i.test(bareModel(model)))) throw new Error('unknown model');
  const dirs = [...new Set(claude.filter((x) => accountKey(x) === key).map((x) => configDir(x.env)))];
  let changed = false;
  for (const dir of dirs) if (window !== undefined && setCompactWindow(dir, model, window)) changed = true;
  const limits = dirs.length ? compactWindows(dirs[0]) : {};
  return { ok: true, account: key, matched: dirs.length, changed, model: model ? bareModel(model) : undefined, window: model ? limits[bareModel(model)] ?? null : undefined, limits };
}
