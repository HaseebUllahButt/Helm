import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { discoverProfiles } from './discover.js';
import { ENGINES } from './engines.js';
import { PROFILES_FILE, SECRETS_FILE, expand } from './paths.js';

const write = (file, body, mode = 0o600) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body, { mode });
};

export function loadProfiles() {
  if (!existsSync(PROFILES_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PROFILES_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function saveProfiles(profiles) {
  write(PROFILES_FILE, JSON.stringify({ version: 1, profiles }, null, 2), 0o600);
}

/**
 * Secrets found while importing aliases are written here, not into the
 * profile. The profile keeps only the variable name; this file keeps the
 * value, stays on this machine, and is never sent to the relay.
 */
export function saveSecrets(secrets) {
  if (!Object.keys(secrets).length) return;
  const existing = readSecrets();
  const merged = { ...existing, ...secrets };
  const body =
    '# Written by con. Values stay on this machine and are never uploaded.\n' +
    Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  write(SECRETS_FILE, body, 0o600);
}

export function readSecrets() {
  if (!existsSync(SECRETS_FILE)) return {};
  const out = {};
  for (const line of readFileSync(SECRETS_FILE, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Discover, merge with anything already saved, and persist. */
export async function refreshProfiles({ keepCustom = true } = {}) {
  const { profiles: found, secrets, installed } = await discoverProfiles();
  saveSecrets(secrets);

  const saved = loadProfiles();
  if (saved && keepCustom) {
    // A profile the user wrote or edited by hand outlives rediscovery.
    const custom = saved.profiles.filter((p) => p.source === 'custom');
    const disabled = new Set(
      saved.profiles.filter((p) => p.disabled).map((p) => p.id)
    );
    for (const p of found) if (disabled.has(p.id)) p.disabled = true;
    found.push(...custom);
  }
  saveProfiles(found);
  return { profiles: found, installed };
}

export async function getProfiles() {
  const saved = loadProfiles();
  if (saved?.profiles?.length) return saved.profiles;
  const { profiles } = await refreshProfiles();
  return profiles;
}

/**
 * Whether the saved list is old enough that discovery is worth re-running.
 * A CLI installed after this machine joined never appears otherwise - the
 * file is written at join and nothing checks it again until asked to.
 */
const PROFILE_TTL_MS = 5 * 60_000;
export function profilesStale() {
  try {
    return Date.now() - statSync(PROFILES_FILE).mtimeMs > PROFILE_TTL_MS;
  } catch {
    return true;
  }
}

/**
 * getProfiles, but rediscovers when the saved list is old enough to predate
 * a CLI installed after this machine joined. Anything that answers "what
 * can this machine run" should ask this, not getProfiles.
 */
export async function currentProfiles() {
  if (profilesStale()) return (await refreshProfiles()).profiles;
  return getProfiles();
}

/**
 * Turn a profile into the pieces herdr needs: the environment a workspace is
 * created with, and the agent kind plus native arguments.
 */
export function materialize(profile) {
  const secrets = readSecrets();
  const env = {};

  for (const [k, v] of Object.entries(profile.env || {})) {
    env[k] = expand(v);
  }
  for (const name of profile.envFrom || []) {
    if (secrets[name]) env[name] = secrets[name];
  }
  // herdr's env map cannot remove an inherited variable, so an alias that did
  // `unset FOO` is honoured by blanking it - which is what the CLIs check.
  for (const name of profile.unset || []) env[name] = '';

  const engine = ENGINES[profile.engine];
  return {
    env,
    kind: engine?.plain ? null : profile.engine,
    cmd: expand(profile.cmd),
    args: profile.args || [],
    plain: !!engine?.plain,
  };
}
