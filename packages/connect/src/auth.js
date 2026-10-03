import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { materialize } from './profiles.js';
import { ENGINES } from './engines.js';
import { HELM_DIR, expand } from './paths.js';
import { agyModelsFromOutput, primeModels } from './models.js';

/**
 * Whether each profile can actually sign in, so the app offers only accounts
 * that work. Discovery finds every alias and install on the box, including a
 * plain `agy` next to the `a1`..`a3` wrappers that hold the real logins - and
 * a signed-out one looks exactly like a working one until its first turn fails.
 *
 * Each CLI is asked the way the profile would run it (its env, and its wrapper
 * script if it has one). The answer is one of:
 *   authenticated   - the CLI says it is signed in
 *   unauthenticated - the CLI says it is not; hide the profile
 *   unknown         - no probe for this engine, or it failed or timed out
 * Only `unauthenticated` hides anything: a slow or odd CLI must never make a
 * working account vanish.
 */

const PROBE_TIMEOUT_MS = 20_000;
const TTL_MS = 10 * 60_000;

/** engine -> { args, read(stdout, stderr, code) } */
const PROBES = {
  claude: {
    args: ['auth', 'status', '--json'],
    read(out) {
      try {
        const parsed = JSON.parse(out);
        return parsed.loggedIn === true ? 'authenticated' : parsed.loggedIn === false ? 'unauthenticated' : 'unknown';
      } catch {
        return /not logged in/i.test(out) ? 'unauthenticated' : 'unknown';
      }
    },
  },
  codex: {
    args: ['login', 'status'],
    read(out, err, code) {
      const text = `${out}\n${err}`;
      if (/not logged in/i.test(text)) return 'unauthenticated';
      return code === 0 && /logged in/i.test(text) ? 'authenticated' : 'unknown';
    },
  },
  agy: {
    // Signed out, agy refuses to list models and says so. Signed in, the
    // answer *is* the model list - the picker's, which costs agy the same
    // several seconds to fetch, so it is handed to models.js below.
    args: ['models'],
    read(out, err) {
      const text = `${out}\n${err}`;
      if (/sign in/i.test(text)) return 'unauthenticated';
      return /^\S+\t/m.test(out) ? 'authenticated' : 'unknown';
    },
    prime(profile, spec, out) {
      const engine = ENGINES.agy;
      const home = spec.env?.[engine.homeEnv] ?? engine.defaultHome;
      const launcher = profile.wraps ? { cmd: spec.cmd, args: spec.args } : null;
      const value = agyModelsFromOutput(expand(home), out);
      if (value.models.length) primeModels('agy', home, launcher, value);
    },
  },
};

const run = (cmd, args, env) =>
  new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1 << 20,
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      if (error?.killed || error?.code === 'ENOENT') return resolve(null);
      resolve({ out: String(stdout ?? ''), err: String(stderr ?? ''), code: error ? (error.code ?? 1) : 0 });
    });
  });

export async function probeAuth(profile) {
  const probe = PROBES[profile.engine];
  if (!probe) return 'unknown';
  const spec = materialize(profile);
  // A wrapper script needs its own arguments (`agy-profile 1`); an alias's
  // flags (`--model x`) would only get in the way of a subcommand.
  const lead = profile.wraps ? spec.args : [];
  const result = await run(spec.cmd, [...lead, ...probe.args], spec.env);
  if (!result) return 'unknown';
  const status = probe.read(result.out, result.err, result.code);
  if (status === 'authenticated') probe.prime?.(profile, spec, result.out);
  return status;
}

// profile identity -> { status, at, pending }. Kept on disk too: a restarted
// daemon should not greet the picker with a round of five-second probes.
const cache = new Map();
const keyOf = (p) => JSON.stringify([p.id, p.engine, p.cmd, p.args ?? [], p.env ?? {}, p.envFrom ?? [], p.secretRefs ?? {}, p.unset ?? []]);
const AUTH_FILE = () => join(HELM_DIR, 'auth.json');
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    for (const [key, v] of Object.entries(JSON.parse(readFileSync(AUTH_FILE(), 'utf8')))) {
      if (v && typeof v.status === 'string' && typeof v.at === 'number') cache.set(key, { status: v.status, at: v.at });
    }
  } catch { /* first run */ }
}

function save() {
  const out = {};
  for (const [key, v] of cache) if (v.at) out[key] = { status: v.status, at: v.at };
  try {
    const tmp = `${AUTH_FILE()}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    renameSync(tmp, AUTH_FILE());
  } catch { /* the in-memory answer still stands */ }
}

function check(profile) {
  const key = keyOf(profile);
  const hit = cache.get(key);
  if (hit?.pending) return hit.pending;
  const pending = probeAuth(profile)
    .catch(() => 'unknown')
    .then((status) => {
      cache.set(key, { status, at: Date.now() });
      save();
      return status;
    });
  cache.set(key, { status: hit?.status, at: hit?.at ?? 0, pending });
  return pending;
}

/**
 * Each profile's auth status. Probes take seconds (agy asks its server), and
 * the picker is waiting, so this answers from what is already known and
 * re-probes anything older than the TTL behind the answer. It waits - at
 * most `waitMs` - only for a profile never probed before, or for all of them
 * when the caller asked for a refresh.
 */
export async function authStatuses(profiles, { refresh = false, waitMs = 4000 } = {}) {
  load();
  const waitFor = [];
  for (const p of profiles) {
    const hit = cache.get(keyOf(p));
    const known = hit && typeof hit.status === 'string';
    if (refresh || !known || Date.now() - hit.at >= TTL_MS) {
      const job = check(p);
      if (refresh || !known) waitFor.push(job);
    }
  }
  if (waitFor.length) {
    let timer;
    await Promise.race([
      Promise.all(waitFor),
      new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
    ]);
    clearTimeout(timer);
  }
  return new Map(profiles.map((p) => [p.id, cache.get(keyOf(p))?.status ?? 'unknown']));
}

/** The profiles worth offering: everything the CLI didn't say is signed out. */
export async function usableProfiles(profiles, options) {
  const statuses = await authStatuses(profiles, options);
  return profiles
    .filter((p) => statuses.get(p.id) !== 'unauthenticated')
    .map((p) => ({ ...p, auth: statuses.get(p.id) }));
}

/** Tests only. */
export function _resetAuthCache() {
  cache.clear();
  loaded = true;
}
