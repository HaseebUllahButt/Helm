import { request } from 'node:http';

/**
 * Proxy to a locally-running cc-usage-dashboard.
 *
 * That server binds to 127.0.0.1 and has no authentication, which is exactly
 * right: helm reaches it over the loopback interface on the machine itself and
 * relays the result through the connection it already holds. Nothing about the
 * dashboard has to be exposed to the network.
 */
const PORT = Number(process.env.HELM_USAGE_PORT || 47291);

function get(path, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', timeout },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (err) { reject(new Error('usage dashboard returned non-JSON')); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('usage dashboard timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Remembered answer, so `describe()` is not held up by the probe.
 *
 * A "yes" is worth holding on to: the dashboard is there, and the numbers
 * behind it change by the day. A "no" is not - the dashboard is a separate
 * service and is usually started *after* the daemon, so caching that answer
 * for five minutes is five minutes of the app insisting the machine has no
 * usage panel while one is running. A no is re-asked within the minute.
 */
let known = null;
const YES_TTL_MS = 5 * 60_000;
const NO_TTL_MS = 30_000;

export async function available() {
  // The dashboard rebuilds its cache on a cold call and can take several
  // seconds; a short timeout here reports "missing" for a server that is
  // merely busy. That patience is why the answer is remembered: describing a
  // machine is on the path of opening it in the app, and waiting fifteen
  // seconds there to learn something that changes daily is not a trade worth
  // making.
  if (known && Date.now() < known.until) return known.value;
  let value = false;
  try { await get('/api/usage', 15_000); value = true; } catch { value = false; }
  known = { value, until: Date.now() + (value ? YES_TTL_MS : NO_TTL_MS) };
  return value;
}

/** Forget the remembered answer - for tests, and for `helm status`. */
export function forget() { known = null; }

export async function usage() {
  const data = await get('/api/usage');
  // Trim to what a phone screen can use; the full payload carries per-day
  // history for every account and is large.
  return {
    fetchedAt: data.fetchedAt,
    accounts: (data.accounts ?? []).map((a) => ({
      id: a.id,
      provider: a.provider,
      label: a.label,
      planLabel: a.planLabel,
      today: a.today,
      month: a.month,
      rateLimits: a.rateLimits,
    })),
  };
}

export const limitHistory = (steps = 8) => get(`/api/limit-history?steps=${steps}`);
