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

export async function available() {
  // The dashboard rebuilds its cache on a cold call and can take several
  // seconds; a short timeout here reports "missing" for a server that is
  // merely busy.
  try { await get('/api/usage', 15_000); return true; } catch { return false; }
}

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
