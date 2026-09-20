import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_FILE } from './paths.js';

/**
 * Per-machine settings in ~/.helm/config.json: which of an account's (often
 * very long) model list is worth offering, plus the model, thinking level,
 * permission mode and speed a new session starts with. `helm leave` deletes
 * the file along with the rest of the machine's state.
 *
 * Prefs are keyed by *account*, not profile: several aliases can launch the
 * same login, and they must share one list. The key is exactly what the
 * app's accountsFrom() computes - engine, the account's home directory, its
 * credential variables - so what the settings screen edits is the entry the
 * daemon consults.
 */
export function accountKey(profile) {
  const home = Object.values(profile.env ?? {}).find((v) => /^[~/]/.test(v)) ?? '';
  const creds = [...(profile.envFrom ?? [])].sort().join(',');
  return `${profile.engine}|${home}|${creds}`;
}

export function loadSettings() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

/** The account's model prefs, or null - an absent entry means "offer all". */
export function modelPrefs(profile, cfg = loadSettings()) {
  const p = cfg?.models?.[accountKey(profile)];
  return p && (p.default || p.approved?.length)
    ? { default: p.default ?? null, approved: p.approved ?? [] }
    : null;
}

/** Defaults used when this account starts a session, on every paired device. */
export function startPrefs(profile, cfg = loadSettings()) {
  const p = cfg?.starts?.[accountKey(profile)];
  if (!p) return null;
  const out = {};
  for (const key of ['effort', 'mode', 'speed']) {
    if (typeof p[key] === 'string' && p[key].trim()) out[key] = p[key].trim();
  }
  return Object.keys(out).length ? out : null;
}

/** Replace the non-model start defaults for one account. */
export function saveStartPrefs(profile, values = {}) {
  const cfg = loadSettings();
  cfg.starts ??= {};
  const clean = {};
  for (const key of ['effort', 'mode', 'speed']) {
    const value = typeof values[key] === 'string' ? values[key].trim() : '';
    if (value) clean[key] = value;
  }
  const key = accountKey(profile);
  if (Object.keys(clean).length) cfg.starts[key] = clean;
  else delete cfg.starts[key];
  writeSettings(cfg);
  return startPrefs(profile, cfg);
}

/**
 * Replace an account's model prefs wholesale. An empty approved list means
 * "offer everything", so with no default either there is nothing to keep.
 */
export function saveModelPrefs(profile, { default: def = null, approved = [] } = {}) {
  const cfg = loadSettings();
  cfg.models ??= {};
  // This arrives over the network from a phone and is read back by the
  // daemon on every session start, so only model names get in.
  const name = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const list = [...new Set((Array.isArray(approved) ? approved : []).map(name).filter(Boolean))];
  const pick = name(def);
  if (!pick && !list.length) delete cfg.models[accountKey(profile)];
  else cfg.models[accountKey(profile)] = { default: pick, approved: list };
  writeSettings(cfg);
  return modelPrefs(profile, cfg);
}

function writeSettings(cfg) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ version: 1, ...cfg }, null, 2), { mode: 0o600 });
}

export function listProjects(cfg = loadSettings()) {
  return Array.isArray(cfg.projects)
    ? cfg.projects.filter((p) => p?.path).map((p) => ({ path: p.path, title: p.title || p.path.split('/').pop() || p.path }))
    : [];
}

export function saveProject(project) {
  const cfg = loadSettings();
  const projects = listProjects(cfg);
  const next = { path: project.path, title: project.title || project.path.split('/').pop() || project.path };
  const index = projects.findIndex((p) => p.path === next.path);
  if (index === -1) projects.push(next); else projects[index] = next;
  cfg.projects = projects;
  writeSettings(cfg);
  return next;
}

export function removeProject(path) {
  const cfg = loadSettings();
  cfg.projects = listProjects(cfg).filter((p) => p.path !== path);
  writeSettings(cfg);
  return true;
}

/**
 * Fold an account's prefs into a model list for the app. The approved models
 * are the picker; everything else moves to `more` so it stays reachable, and
 * a configured default is what the account now starts with. `all` skips the
 * split because the settings editor needs the whole list, but still reports
 * the effective default. An approved set that matched nothing is stale -
 * an empty picker is worse than a long one, so it is ignored.
 */
export function applyModelPrefs(models, prefs, { all = false } = {}) {
  if (!prefs) return models;
  const out = { ...models };
  if (prefs.default) out.default = prefs.default;
  if (all || !prefs.approved?.length) return out;
  const ok = new Set([...prefs.approved, prefs.default].filter(Boolean));
  const keep = out.models.filter((m) => ok.has(m));
  if (!keep.length) return out;
  out.more = out.models.filter((m) => !ok.has(m));
  out.models = keep;
  return out;
}
