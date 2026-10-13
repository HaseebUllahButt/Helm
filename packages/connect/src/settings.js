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
  // A wrapper script (`agy-profile 1`) picks its login itself; the command is
  // all that tells one of its accounts from another.
  const home = profile.wraps
    ? [profile.cmd, ...(profile.args ?? [])].join(' ')
    : Object.values(profile.env ?? {}).find((v) => /^[~/]/.test(v)) ?? '';
  const creds = [...(profile.envFrom ?? [])].map((name) => profile.secretRefs?.[name] ?? name).sort().join(',');
  return `${profile.engine}|${home}|${creds}`;
}

export function loadSettings() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

/** Retain saved choices when rediscovery separates formerly shared token slots. */
export function migrateProfileSettings(previous, next) {
  const cfg = loadSettings();
  let changed = false;
  for (const profile of next) {
    const old = previous.find((p) => p.id === profile.id);
    if (!old) continue;
    const before = accountKey(old), after = accountKey(profile);
    if (before === after) continue;
    for (const section of ['models', 'starts', 'subagentStarts', 'modelWatch']) {
      if (cfg[section]?.[before] && !Object.hasOwn(cfg[section], after)) {
        cfg[section][after] = { ...cfg[section][before] };
        changed = true;
      }
    }
  }
  if (changed) writeSettings(cfg);
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

/** Overrides for helpers; absent fields keep the parent/account defaults. */
export function subagentPrefs(profile, cfg = loadSettings()) {
  const stored = cfg?.subagentStarts?.[accountKey(profile)] ?? {};
  return Object.fromEntries(['model', 'effort', 'mode'].flatMap((key) =>
    typeof stored[key] === 'string' && stored[key].trim() ? [[key, stored[key].trim()]] : []));
}

/** Partial edits keep other helper defaults and never change normal chats. */
export function saveSubagentPrefs(profile, values = {}) {
  const cfg = loadSettings();
  const next = subagentPrefs(profile, cfg);
  for (const key of ['model', 'effort', 'mode']) {
    if (!Object.hasOwn(values, key)) continue;
    const value = typeof values[key] === 'string' ? values[key].trim() : '';
    if (key === 'mode' && value === 'plan') throw new Error('plan mode is not supported for subagents');
    if (value) next[key] = value; else delete next[key];
  }
  cfg.subagentStarts ??= {};
  const key = accountKey(profile);
  if (Object.keys(next).length) cfg.subagentStarts[key] = next;
  else delete cfg.subagentStarts[key];
  writeSettings(cfg);
  return next;
}

/** Replace the non-model start defaults for one account. */
export function saveStartPrefs(profile, values = {}) {
  const cfg = loadSettings();
  cfg.starts ??= {};
  const clean = {};
  for (const key of ['effort', 'mode', 'speed']) {
    const value = typeof values[key] === 'string' ? values[key].trim() : '';
    if (key === 'mode' && value === 'plan') throw new Error('plan mode is not supported; dispatch the task directly');
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
 * `auto` (add new models by themselves) is the one part that is not wholesale:
 * left out, it is kept. `keepApproved` is for a screen holding an old copy of
 * the list (the in-chat picker): it sets the default and leaves the list alone,
 * so it can neither undo a model that joined meanwhile nor "remove" it.
 */
export function saveModelPrefs(profile, { default: def = null, approved = [], auto, keepApproved = false } = {}) {
  const cfg = loadSettings();
  cfg.models ??= {};
  // This arrives over the network from a phone and is read back by the
  // daemon on every session start, so only model names get in.
  const name = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const key = accountKey(profile);
  const before = cfg.models[key]?.approved ?? [];
  const list = keepApproved ? before : [...new Set((Array.isArray(approved) ? approved : []).map(name).filter(Boolean))];
  const pick = name(def);
  if (!pick && !list.length) delete cfg.models[key];
  else cfg.models[key] = { default: pick, approved: list };

  const watch = cfg.modelWatch?.[key] ?? {};
  // Taking a model off a short list is a choice: remember it, so new-model
  // sync never puts it back. Clearing the whole list means "offer all", which
  // is not a choice about any one model. Adding it back forgets the choice.
  if (list.length) {
    const hidden = new Set(watch.hidden ?? []);
    for (const m of before) if (!list.includes(m)) hidden.add(m);
    for (const m of list) hidden.delete(m);
    watch.hidden = [...hidden].slice(-500);
  }
  if (typeof auto === 'boolean') watch.auto = auto;
  if (!watch.hidden?.length) delete watch.hidden;
  if (watch.auto !== false) delete watch.auto;
  cfg.modelWatch ??= {};
  if (Object.keys(watch).length) cfg.modelWatch[key] = watch; else delete cfg.modelWatch[key];
  writeSettings(cfg);
  return modelPrefs(profile, cfg);
}

/** The owner has seen the notes about models that joined by themselves. */
export function dismissModelNews(profile) {
  const cfg = loadSettings();
  const key = accountKey(profile);
  if (!cfg.modelWatch?.[key]?.news) return;
  delete cfg.modelWatch[key].news;
  writeSettings(cfg);
}

/**
 * Whether new models join this account by themselves (on unless switched
 * off), and the quiet notes about the last ones that did.
 */
export function modelWatch(profile, cfg = loadSettings()) {
  const w = cfg?.modelWatch?.[accountKey(profile)];
  return { auto: w?.auto !== false, news: Array.isArray(w?.news) ? w.news : [] };
}

/**
 * A model id as a "line" and a version, or null when unsure. A line is what
 * a new release replaces: claude-opus-5-5 -> {claude-opus, [5,5]}; gpt-5.3-codex
 * -> {gpt-codex, [5,3]}. A dated snapshot is a pin, so it is flagged. Aliases
 * ("opus"), effort-suffixed ids and anything else odd return null, and null
 * means do nothing.
 */
export function modelLine(id) {
  if (typeof id !== 'string') return null;
  const ver = (v) => v.split(/[-.]/).map(Number);
  let m = /^claude-([a-z]+)-(\d+(?:-\d{1,2})?)(-\d{8})?$/.exec(id);
  if (m) return { line: `claude-${m[1]}`, version: ver(m[2]), pin: !!m[3] };
  // The older spelling puts the version first: claude-3-5-sonnet-20241022.
  m = /^claude-(\d+(?:-\d{1,2})?)-([a-z]+)(-\d{8})?$/.exec(id);
  if (m) return { line: `claude-${m[2]}`, version: ver(m[1]), pin: !!m[3] };
  m = /^gpt-(\d+(?:\.\d+)?)((?:-[a-z]+)*)$/.exec(id);
  if (m) return { line: `gpt${m[2]}`, version: ver(m[1]), pin: false };
  m = /^gemini-(\d+(?:\.\d+)?)-([a-z]+(?:-[a-z]+)*?)(-preview)?$/.exec(id);
  if (m) return { line: `gemini-${m[2]}`, version: ver(m[1]), pin: false };
  return null;
}

/** Positive when version a is newer than b (missing parts count as zero). */
const newerVersion = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/**
 * Notice models a refreshed catalog has that this account never saw, and let
 * them join: onto the approved list (so they show in the pickers), and, when
 * the default was the newest of its line, as the new default. Only lines we
 * can read are touched (modelLine); an owner's removal is never undone
 * (`hidden`); the first look at an account just records what is there, so an
 * upgrade adds nothing by surprise. Returns the notes made, or [].
 */
export function syncNewModels(profile, ids, labels = {}) {
  const have = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x.trim()))];
  if (!have.length) return [];
  const cfg = loadSettings();
  const key = accountKey(profile);
  cfg.modelWatch ??= {};
  const watch = cfg.modelWatch[key] ??= {};
  if (!watch.seen) { watch.seen = have; writeSettings(cfg); return []; }

  const known = new Set(watch.seen);
  const fresh = have.filter((m) => !known.has(m));
  if (!fresh.length) return [];
  const before = watch.seen;
  watch.seen = [...before, ...fresh].slice(-3000);
  const prefs = cfg.models?.[key];
  const notes = [];
  if (watch.auto !== false && prefs) {
    const hidden = new Set(watch.hidden ?? []);
    const lines = (list) => list.flatMap((id) => { const l = modelLine(id); return l ? [{ id, ...l }] : []; });
    const old = lines(before);
    // Newer than everything of its line we knew: a late-arriving old model
    // (a catalog that was partial the first time) is not news.
    const next = lines(fresh).filter((c) => !c.pin && !hidden.has(c.id)
      && !old.some((o) => o.line === c.line && newerVersion(c.version, o.version) <= 0));
    const label = (id) => labels?.[id] ?? id;
    const approved = [...(prefs.approved ?? [])];
    let moved = null;
    const cur = lines([prefs.default ?? ''])[0];
    if (cur && !cur.pin && !old.some((o) => o.line === cur.line && newerVersion(o.version, cur.version) > 0)) {
      moved = next.filter((c) => c.line === cur.line && newerVersion(c.version, cur.version) > 0)
        .sort((a, b) => newerVersion(b.version, a.version))[0] ?? null;
      if (moved) prefs.default = moved.id;
    }
    for (const c of next) {
      // With no short list everything already shows; there is nothing to add to.
      if (approved.length && !approved.includes(c.id)) approved.push(c.id);
      if (approved.length || c === moved) notes.push({ id: c.id, label: label(c.id), isDefault: c === moved });
    }
    prefs.approved = approved;
    if (notes.length) watch.news = [...(watch.news ?? []), ...notes].slice(-5);
  }
  writeSettings(cfg);
  return notes;
}

/**
 * What the new-session picker on this machine shows: accounts hidden from
 * it, the account last started, and starred models per engine. Kept on the
 * machine rather than in a browser so a phone and a laptop open the same
 * picker. Hidden, last and agent (the default one) are account keys (see
 * accountKey).
 */
export function pickerPrefs(cfg = loadSettings()) {
  const p = cfg?.picker ?? {};
  const strings = (v) => [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];
  const favs = {};
  for (const [engine, list] of Object.entries(p.favs && typeof p.favs === 'object' ? p.favs : {})) {
    const clean = strings(list);
    if (clean.length) favs[engine] = clean;
  }
  return {
    hidden: strings(p.hidden),
    last: typeof p.last === 'string' && p.last ? p.last : null,
    // Chosen on purpose, so it outlasts starting something else once.
    agent: typeof p.agent === 'string' && p.agent ? p.agent : null,
    favs,
  };
}

/** Merge a partial change into the picker prefs. Fields left out are kept. */
export function savePickerPrefs(change = {}) {
  const cfg = loadSettings();
  const next = pickerPrefs(cfg);
  if ('hidden' in change) next.hidden = pickerPrefs({ picker: { hidden: change.hidden } }).hidden;
  if ('last' in change) next.last = typeof change.last === 'string' && change.last ? change.last : null;
  if ('agent' in change) next.agent = typeof change.agent === 'string' && change.agent ? change.agent : null;
  if (change.favs && typeof change.favs === 'object') {
    for (const [engine, list] of Object.entries(change.favs)) {
      if (!/^[\w.-]{1,40}$/.test(engine)) continue;
      const clean = pickerPrefs({ picker: { favs: { [engine]: list } } }).favs[engine];
      if (clean) next.favs[engine] = clean; else delete next.favs[engine];
    }
  }
  cfg.picker = next;
  writeSettings(cfg);
  return pickerPrefs(cfg);
}

/**
 * Whether this machine keeps its coding tools (claude, codex, ...) up to date
 * by itself. On unless the owner turned it off.
 */
export function cliAutoUpdate(cfg = loadSettings()) {
  return cfg?.cliUpdates?.auto !== false;
}

export function saveCliAutoUpdate(on) {
  const cfg = loadSettings();
  cfg.cliUpdates = { ...(cfg.cliUpdates ?? {}), auto: on !== false };
  writeSettings(cfg);
  return cliAutoUpdate(cfg);
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
