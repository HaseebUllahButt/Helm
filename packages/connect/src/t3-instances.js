/**
 * Every account this machine has for every CLI, registered with T3.
 *
 * The owner runs codex, claude and opencode across several logins, kept
 * apart by a home directory per account (`CODEX_HOME=~/.codex-personal`) and
 * reached through shell aliases. helm already discovers those aliases
 * (`discover.js`); this turns each distinct account into a T3 *provider
 * instance* in T3's own settings file, so T3's model picker offers every
 * account by name and T3 launches the CLI with the right home.
 *
 * T3 watches its settings file, so writing it is enough; nothing restarts.
 * helm owns only the instances whose id starts with `helm-` and leaves any
 * the owner added by hand in T3's settings screen untouched.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINES } from './engines.js';
import { readSecrets } from './profiles.js';
import { T3_HOME } from './t3.js';

export const SETTINGS_FILE = join(T3_HOME, 'userdata', 'settings.json');
const OWNED = /^helm-/;

/** T3's name for each driver, and where the account home goes in its config. */
const DRIVER = {
  codex:    { driver: 'codex',       homeKey: 'homePath' },
  claude:   { driver: 'claudeAgent', homeKey: 'homePath' },
  // opencode keys its config off XDG_CONFIG_HOME, which T3 has no field for;
  // it is passed as an instance environment variable instead.
  opencode: { driver: 'opencode',    homeKey: null },
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Collapse alias profiles to accounts. An account is an engine plus the home
 * it runs with plus the credential names it carries; `d`, `codexp` and
 * `codexpx` are all "Codex, personal" with different flags, and the flags are
 * T3's business now (permission mode, effort, model are all in its UI).
 */
export function accountsFrom(profiles) {
  const by = new Map();
  for (const p of profiles) {
    const engine = ENGINES[p.engine];
    if (!engine || engine.plain || p.disabled) continue;
    const home = p.env?.[engine.homeEnv] || null;
    const secretNames = [...(p.envFrom ?? [])].sort();
    const key = [p.engine, home ?? '', secretNames.join(',')].join('|');
    if (by.has(key)) continue;

    // "~/.codex-personal" -> "personal"; the default home -> "default".
    const leaf = home ? home.replace(/\/$/, '').split('/').pop() : '';
    const suffix = leaf.replace(/^\.?(claude|codex|opencode|config)[-_]?/, '');
    const account = (home && suffix) ? suffix : 'default';
    by.set(key, { engine: p.engine, home, account, secretNames, label: p.label || p.id });
  }
  return [...by.values()];
}

/** The instance T3 should have for one account, or null for the plain default. */
export function instanceFor(acct, secrets = {}) {
  const spec = DRIVER[acct.engine];
  if (!spec) return null;
  const isDefault = !acct.home && !acct.secretNames.length;
  // The stock account per CLI is T3's built-in instance already.
  if (isDefault) return null;

  const id = `helm-${acct.engine}-${slug(acct.account)}${acct.secretNames.length ? `-${slug(acct.secretNames.join('-'))}` : ''}`.slice(0, 64);
  const label = ENGINES[acct.engine].label;
  const environment = [];
  if (acct.home && !spec.homeKey) {
    environment.push({ name: ENGINES[acct.engine].homeEnv, value: acct.home, sensitive: false });
  }
  for (const name of acct.secretNames) {
    if (secrets[name] !== undefined) environment.push({ name, value: secrets[name], sensitive: true });
  }
  const config = {};
  if (acct.home && spec.homeKey) config[spec.homeKey] = acct.home;

  return {
    id,
    envelope: {
      driver: spec.driver,
      displayName: `${label} · ${acct.account}${acct.secretNames.length ? ' (token)' : ''}`,
      enabled: true,
      ...(environment.length ? { environment } : {}),
      config,
    },
  };
}

export function readSettings() {
  if (!existsSync(SETTINGS_FILE)) return {};
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

function writeSettings(settings) {
  mkdirSync(join(T3_HOME, 'userdata'), { recursive: true, mode: 0o700 });
  const tmp = `${SETTINGS_FILE}.helm-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, SETTINGS_FILE);
}

/**
 * Bring T3's provider instances in line with the accounts found here.
 * Returns what is registered, and whether the file changed.
 */
export function syncInstances(profiles, { secrets = readSecrets() } = {}) {
  const wanted = {};
  for (const acct of accountsFrom(profiles)) {
    const inst = instanceFor(acct, secrets);
    if (inst) wanted[inst.id] = inst.envelope;
  }

  const settings = readSettings();
  const current = settings.providerInstances ?? {};
  const next = {};
  for (const [id, env] of Object.entries(current)) if (!OWNED.test(id)) next[id] = env;
  Object.assign(next, wanted);

  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) writeSettings({ ...settings, providerInstances: next });
  return {
    changed,
    instances: Object.entries(wanted).map(([id, env]) => ({ id, name: env.displayName, driver: env.driver })),
  };
}
