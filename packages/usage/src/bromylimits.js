import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:47291/';

/** Discover the installed service's port, including systemd overrides. */
export async function broMyLimitsUrl({ home = homedir(), env = process.env } = {}) {
  if (env.HELM_BROMYLIMITS_URL === 'off') return null;
  if (env.HELM_BROMYLIMITS_URL) return env.HELM_BROMYLIMITS_URL;
  let port = '47291';
  const unit = join(home, '.config/systemd/user/cc-usage-dashboard.service');
  const { readdir } = await import('node:fs/promises');
  const overrides = await readdir(`${unit}.d`).catch(() => []);
  for (const file of [unit, ...overrides.filter((n) => n.endsWith('.conf')).sort().map((n) => `${unit}.d/${n}`)]) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!/^\s*Environment=/.test(line)) continue;
      const match = line.match(/(?:[\s="'])PORT=(\d+)/);
      if (match && +match[1] > 0 && +match[1] <= 65535) port = match[1];
    }
  }
  return port === '47291' ? DEFAULT_URL : `http://127.0.0.1:${port}/`;
}

const count = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** The API's daily totals are authoritative; never invent per-model detail. */
export function broMyLimitsBuckets(data, { machineId, url } = {}) {
  if (!Array.isArray(data?.accounts)) throw new Error('BroMyLimits returned no accounts');
  const at = Date.parse(data.fetchedAt);
  if (!Number.isFinite(at)) throw new Error('BroMyLimits returned no observation time');
  const buckets = {};
  const accounts = [];
  const covered = new Set();
  const seen = new Set();
  for (const a of data.accounts) {
    // Newer dashboards already mesh other machines into their API. Import
    // only this machine, or Helm would add the network back into itself.
    if (a.remote === true || (a.machineId && a.machineId !== machineId)) continue;
    if (typeof a.id !== 'string' || !a.id || typeof a.provider !== 'string') continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    if (a.error || !Array.isArray(a.daily)) throw new Error(`BroMyLimits account ${a.id} unavailable${a.error ? `: ${a.error}` : ''}`);
    const engine = a.provider;
    const account = `bromylimits:${a.id}`;
    const rows = new Map();
    for (const d of a.daily) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !count(d.tokens) || !count(d.cost)) {
        throw new Error(`Invalid BroMyLimits daily totals for ${a.id}`);
      }
      if (rows.has(d.date)) throw new Error(`Duplicate BroMyLimits day for ${a.id}`);
      rows.set(d.date, d);
    }
    // Undated archived totals cannot be put in a day or silently discarded.
    const datedTokens = [...rows.values()].reduce((sum, d) => sum + d.tokens, 0);
    const datedCost = [...rows.values()].reduce((sum, d) => sum + d.cost, 0);
    const archivedTokens = Math.max(0, (a.allTime?.tokens || 0) - datedTokens);
    const archivedCost = Math.max(0, (a.allTime?.cost || 0) - datedCost);
    for (const [date, d] of rows) {
      buckets[`${account}\x00${date}|not reported|`] = {
        engine, account, total: d.tokens, reportedCostUsd: d.cost,
        unpriced: d.unpriced === true, summaryOnly: true,
      };
    }
    if (archivedTokens || archivedCost > 0.000001) {
      buckets[`${account}\x00|not reported|`] = {
        engine, account, total: archivedTokens, reportedCostUsd: archivedCost,
        summaryOnly: true, undated: true, unpriced: archivedTokens > 0 && archivedCost === 0,
      };
    }
    covered.add(engine);
    if (engine === 'opencode') covered.add('opencode2');
    accounts.push({ account, engine, profileId: null, source: 'bromylimits', sourceUrl: url,
      sourceAt: at, sourceStale: !!data.cache?.stale || Date.now() - at > 30_000, label: a.label || a.id });
  }
  return { buckets, accounts, covered, at };
}

/** Replace overlapping engines; dashboard totals must never be added twice. */
export async function connectBroMyLimits(native, { machineId, url, fetchImpl = fetch, rebuild = false } = {}) {
  if (url === undefined) url = await broMyLimitsUrl();
  if (!url) return native;
  try {
    const endpoint = new URL('api/usage', url.endsWith('/') ? url : `${url}/`);
    endpoint.searchParams.set('scope', 'local');
    if (rebuild) { endpoint.searchParams.set('force', '1'); endpoint.searchParams.set('rebuild', '1'); }
    const res = await fetchImpl(endpoint, { signal: AbortSignal.timeout(rebuild ? 120_000 : 15_000) });
    if (!res.ok) throw new Error(`BroMyLimits HTTP ${res.status}`);
    const external = broMyLimitsBuckets(await res.json(), { machineId, url });
    return {
      ...native,
      buckets: { ...Object.fromEntries(Object.entries(native.buckets).filter(([, b]) => !external.covered.has(b.engine))),
        ...external.buckets },
      accounts: [...native.accounts.filter((a) => !external.covered.has(a.engine)), ...external.accounts],
    };
  } catch (err) {
    // Keep the native records, but make incomplete coverage visible.
    return { ...native, accounts: [...native.accounts, {
      account: 'bromylimits:status', engine: 'bromylimits', profileId: null,
      source: 'bromylimits', sourceUrl: url, sourceError: String(err.message || err),
    }] };
  }
}
