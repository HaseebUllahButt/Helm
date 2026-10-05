import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import { Scanners } from './scanners.js';
import { splitKey, blankStats, addStats, loadIndex, saveIndex } from './scan-cache.js';
import { priceBucket, cacheRatesFor, providerOf } from './pricing.js';

/**
 * What this machine's agents have spent, read from what they already wrote.
 *
 * One machine's answer, pre-aggregated. Nothing raw crosses the wire: a phone
 * asking a laptop over the hub gets day-by-model-by-project buckets, which is
 * a few hundred KB for a year, not the gigabytes of transcript behind them.
 * `events.js` learned that lesson the expensive way - a 5MB reply took 58
 * seconds over the hub and the app gave up at 20.
 *
 * Costs are what the tokens would bill at the published rate on the day they
 * were spent. On a subscription that is not what you paid, so it is reported
 * as an API-equivalent figure and labelled that way, never as "spent".
 */

const HOME = homedir();
const expand = (p) => (p?.startsWith('~') ? join(HOME, p.slice(1)) : p);

/** Which store each engine keeps, and how to read it. */
const ENGINE_STORES = {
  claude: { kind: 'files', home: '~/.claude', env: 'CLAUDE_CONFIG_DIR' },
  codex: { kind: 'files', home: '~/.codex', env: 'CODEX_HOME' },
  opencode: { kind: 'db' },
  opencode2: { kind: 'db' },
  devin: { kind: 'db' },
};

const dataHome = () => process.env.XDG_DATA_HOME || join(HOME, '.local', 'share');

/**
 * Every sibling dir under the data home whose name starts with the engine's
 * prefix - `opencode`, `opencode2`, a `devin-work` beside `devin`. The same
 * glob `inventory.js` uses, so what shows up as a past session also shows up
 * in what it cost.
 */
function xdgStores(prefix, rel) {
  const out = [];
  let dirs;
  try { dirs = readdirSync(dataHome(), { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.startsWith(prefix)) continue;
    const db = join(dataHome(), d.name, rel);
    if (existsSync(db)) out.push(db);
  }
  return out;
}

function opencodeDatabases() {
  return xdgStores('opencode', 'opencode.db');
}

function devinDatabases() {
  const override = process.env.DEVIN_DB;
  if (override) return existsSync(override) ? [override] : [];
  return xdgStores('devin', join('cli', 'sessions.db'));
}

/**
 * Database-backed ledgers are global to the data dir, not under an account
 * home a profile names - so they are read whether or not any profile still
 * points at the engine. An opencode install that was removed after spending
 * tokens is still usage, and `session_v2`-only rows exist even where no
 * opencode2 profile ever did. `inventory.js` reads the same glob.
 */
const DB_STORES = {
  opencode: opencodeDatabases,
  opencode2: opencodeDatabases,
  devin: devinDatabases,
};

/**
 * The account a profile launches, as a stable key.
 *
 * Several aliases can point at one login, and they must not be counted twice.
 * This is the same shape `settings.js` keys model preferences by - engine plus
 * the home directory that isolates the account.
 */
export const accountOf = (profile) => {
  const store = ENGINE_STORES[profile.engine];
  const home = profile.env?.[store?.env] ?? store?.home ?? '';
  return `${profile.engine}|${expand(home) ?? ''}`;
};

export class UsageReader {
  constructor({ indexPath } = {}) {
    this.scanners = new Scanners();
    this.indexPath = indexPath;
    this.loaded = false;
  }

  /** Restore the per-file index, so a daemon restart does not rescan. */
  async prime() {
    if (this.loaded || !this.indexPath) return false;
    this.loaded = true;
    return loadIndex(this.indexPath, this.scanners.caches);
  }

  async persist() {
    if (!this.indexPath) return false;
    return saveIndex(this.indexPath, this.scanners.caches);
  }

  /**
   * Scan every account these profiles reach and return one bucket map.
   *
   * Two aliases onto the same account scan once: the key is the account, not
   * the profile, so a machine with `claudea`/`claudeb` pointing at one home
   * does not double its own usage.
   */
  async collect(profiles = [], opts = {}) {
    // One scan at a time. The file caches are shared, and two scans reading
    // the same entry from the same byte offset each fold the tail in - every
    // turn counted twice, then saved that way. Several hub links opening at
    // once, or two phones on the Usage screen, is all it took. A caller that
    // arrives mid-scan waits for it and then runs its own (cheap: everything
    // is a cache hit by then), so a rebuild or a new profile is never lost.
    const run = (this.#queue ?? Promise.resolve()).then(() => this.#collect(profiles, opts));
    this.#queue = run.catch(() => {});
    return run;
  }

  #queue = null;

  /**
   * Abandon a scan in progress, between files. A cold scan reads gigabytes
   * and outlived the daemon that asked for it - a stopped daemon kept its
   * process alive for minutes. What was read so far is whole per file, so
   * nothing half-counted is kept.
   */
  stop() {
    for (const c of this.scanners.caches) c.stopped = true;
  }

  async #collect(profiles, opts) {
    await this.prime();
    const seen = new Set();
    const buckets = new Map();
    let stats = blankStats();
    const accounts = [];

    const fold = (from, account, engine) => {
      for (const [key, b] of from) {
        const full = `${account}\x00${key}`;
        const cur = buckets.get(full);
        if (!cur) buckets.set(full, { ...b, account, engine });
        else for (const k of Object.keys(b)) if (typeof b[k] === 'number') cur[k] += b[k];
      }
    };

    // Transcript trees are per-account: only the homes a profile names exist
    // to be read, so the profile list drives them.
    for (const p of profiles) {
      const store = ENGINE_STORES[p.engine];
      if (!store || store.kind !== 'files') continue;
      const account = accountOf(p);
      if (seen.has(account)) continue;
      seen.add(account);
      accounts.push({ account, engine: p.engine, profileId: p.id });

      try {
        const home = expand(p.env?.[store.env] ?? store.home);
        const got = p.engine === 'claude'
          ? await this.scanners.scanClaude(home, opts)
          : await this.scanners.scanCodex(home, opts);
        fold(got.buckets, account, p.engine);
        stats = addStats(stats, got.stats);
      } catch { /* one unreadable account must not lose the rest */ }
    }

    // Database ledgers are global to the data dir: their existence is the
    // evidence, not a profile. Reading them unconditionally is what keeps a
    // removed CLI - or an engine with no alias at all - inside the total.
    for (const [engine, find] of Object.entries(DB_STORES)) {
      const dbs = find();
      if (!dbs.length) continue;
      const account = `${engine}|`;
      if (!seen.has(account)) {
        seen.add(account);
        accounts.push({
          account, engine,
          profileId: profiles.find((p) => p.engine === engine)?.id ?? null,
        });
      }
      for (const db of dbs) {
        try {
          const got = await this.scanners.scanDatabase(engine, db, opts);
          fold(got.buckets, account, engine);
          stats = addStats(stats, got.stats);
        } catch { /* one unreadable store must not lose the rest */ }
      }
    }

    this.persist().catch(() => {});
    return { buckets, stats, accounts };
  }

  /**
   * The raw rollup map, serialized - the whole answer, before any window or
   * facet is applied. A hub holding a copy can fold any report it is asked
   * for without asking this machine again, which is what lets an offline
   * machine stay inside the total.
   */
  async buckets(profiles, opts = {}) {
    const { buckets, stats, accounts } = await this.collect(profiles, opts);
    return { buckets: Object.fromEntries(buckets), accounts, scan: stats, at: Date.now() };
  }

  /**
   * A report shaped for the app: totals, a daily series, and the breakdowns it
   * offers as facets. `by` names the dimensions worth grouping - anything not
   * asked for is summed away here rather than on the phone.
   */
  async report(profiles, { since = null, until = null, by = ['engine', 'model'], rebuild = false } = {}) {
    const { buckets, stats, accounts } = await this.collect(profiles, { rebuild });
    return foldBuckets(buckets, { since, until, by, accounts, scan: stats });
  }
}

/**
 * Fold a collected bucket map into a report. Shared by the daemon answering
 * `usage.report` live and a hub answering for a machine that is offline: the
 * rollup carries date, model, engine, account and folder per bucket, so a
 * stored copy still windows and facets exactly like a fresh one.
 */
export function foldBuckets(buckets, {
  since = null, until = null, by = ['engine', 'model'],
  accounts = [], scan = {}, at = null,
} = {}) {
  const daily = new Map();
  const groups = new Map();
  const totals = blankTotals();

  const entries = buckets instanceof Map ? buckets.entries() : Object.entries(buckets ?? {});
  for (const [full, b] of entries) {
    const key = full.slice(full.indexOf('\x00') + 1);
    const { date, model, project } = splitKey(key);
    if (since && date < since) continue;
    if (until && date > until) continue;

    const cost = b.billedUsd != null && b.billedUsd > 0
      ? { total: b.billedUsd, billed: true }
      : priceBucket(b.engine, model, b, date);
    const rates = cacheRatesFor(model, b.engine, date);

    addInto(totals, b, cost, rates);

    const day = daily.get(date) || blankTotals();
    addInto(day, b, cost, rates);
    daily.set(date, day);

    const dims = {
      engine: b.engine,
      account: b.account,
      model,
      provider: providerOf(model),
      project,
    };
    const gkey = by.map((d) => dims[d] ?? '').join('\x01');
    const g = groups.get(gkey) || { ...Object.fromEntries(by.map((d) => [d, dims[d] ?? ''])), ...blankTotals() };
    addInto(g, b, cost, rates);
    groups.set(gkey, g);
  }

  return {
    totals,
    daily: [...daily.entries()].sort((a, b2) => a[0].localeCompare(b2[0])).map(([date, v]) => ({ date, ...v })),
    groups: [...groups.values()].sort((a, b2) => b2.costUsd - a.costUsd),
    accounts,
    scan,
    at: at ?? Date.now(),
  };
}

function blankTotals() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0, turns: 0,
    costUsd: 0, unpriced: false,
    // What the cached reads would have cost as fresh input, and what writing
    // the cache cost above the fresh rate. The difference is the saving.
    cacheSavedUsd: 0, cacheWritePremiumUsd: 0,
  };
}

function addInto(acc, b, cost, rates) {
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'total', 'turns']) {
    acc[k] += b[k] || 0;
  }
  if (cost) acc.costUsd += cost.total;
  else acc.unpriced = true;
  if (rates) {
    acc.cacheSavedUsd += ((b.cacheRead || 0) * (rates.input - rates.cacheRead)) / 1e6;
    const hour = Math.min(b.cacheWrite1h || 0, b.cacheWrite || 0);
    acc.cacheWritePremiumUsd += (((b.cacheWrite || 0) - hour) * (rates.cacheWrite - rates.input) + hour * rates.input) / 1e6;
  }
}

/** The share of input tokens that came back out of the prompt cache. */
export const hitRate = (t) => {
  const denom = (t.input || 0) + (t.cacheRead || 0);
  return denom ? t.cacheRead / denom : 0;
};

export { splitKey };
