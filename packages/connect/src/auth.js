import { execFile } from 'node:child_process';
import { materialize } from './profiles.js';

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
    // Signed out, agy refuses to list models and says so.
    args: ['models'],
    read(out, err) {
      const text = `${out}\n${err}`;
      if (/sign in/i.test(text)) return 'unauthenticated';
      return /^\S+\t/m.test(out) ? 'authenticated' : 'unknown';
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
  return result ? probe.read(result.out, result.err, result.code) : 'unknown';
}

// profile identity -> { status, at, pending }
const cache = new Map();
const keyOf = (p) => JSON.stringify([p.id, p.engine, p.cmd, p.args ?? [], p.env ?? {}, p.envFrom ?? [], p.unset ?? []]);

function check(profile, refresh) {
  const key = keyOf(profile);
  const hit = cache.get(key);
  if (hit?.pending) return hit.pending;
  if (hit && !refresh && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.status);
  const pending = probeAuth(profile)
    .catch(() => 'unknown')
    .then((status) => {
      cache.set(key, { status, at: Date.now() });
      return status;
    });
  cache.set(key, { status: hit?.status ?? 'unknown', at: hit?.at ?? 0, pending });
  return pending;
}

/**
 * Each profile's auth status, waiting at most `waitMs` for probes that are
 * still running; those answer with what was known before (or `unknown`) and
 * are cached for next time.
 */
export async function authStatuses(profiles, { refresh = false, waitMs = 4000 } = {}) {
  const checks = profiles.map((p) => check(p, refresh));
  let timer;
  await Promise.race([
    Promise.all(checks),
    new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
  ]);
  clearTimeout(timer);
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
}
