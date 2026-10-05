import { existsSync } from 'node:fs';
import { open, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HELM_DIR, expand } from './paths.js';
import { planName } from './quota.js';
import { devinAccountDir, devinCredentials, fetchDevinUserStatus } from './devin-usage.js';
import { broMyLimitsUrl } from '@helm/usage/bromylimits';

/**
 * How much of every account's rate limits is left, per machine.
 *
 * Each CLI already writes down its own limits, so the background answer is
 * read, never fetched: Codex puts `rate_limits` into every rollout after
 * every turn, and a Claude or Codex chat helm drives reports its limits as
 * they move, which are kept here. A BroMyLimits dashboard on the same
 * machine adds its Claude statusline snapshots. Devin keeps no local
 * record at all, so its quota is the one read over the network on every
 * open (cached briefly). "Check now" is the only thing that asks Claude and
 * Codex upstream.
 *
 * A reading is { at, windows: [{ key, label, usedPercent, resetsAt, durationMs }],
 * plan?, credits?: string[], note?, source }. The newest reading wins; the
 * extras (plan, credits) fill in from older ones.
 */

const HOUR = 3_600_000;
const DURATION = { session: 5 * HOUR, five_hour: 5 * HOUR, daily: 24 * HOUR, weekly: 168 * HOUR, seven_day: 168 * HOUR };
const ENGINES = { claude: 'Claude', codex: 'Codex', devin: 'Devin' };
const HOMES = {
  claude: { env: 'CLAUDE_CONFIG_DIR', home: '~/.claude' },
  codex: { env: 'CODEX_HOME', home: '~/.codex' },
};
/** Upstream checks per account at most this often; Anthropic's answers 429 fast. */
const LIVE_BACKOFF_MS = 2 * 60_000;
const DEVIN_TTL_MS = 2 * 60_000;

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (v) => (num(v) == null ? null : Math.min(100, Math.max(0, Number(v))));
/** Unix seconds, unix ms or ISO, to ms. */
const when = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const count = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

/** A window named for what it is, not for its slot: Codex swaps primary and secondary. */
function windowOf(minutes, usedPercent, resetsAt, fallback) {
  const m = num(minutes);
  const key = m === 300 ? 'session' : m === 10080 ? 'weekly' : m === 1440 ? 'daily' : m === 43200 ? 'monthly' : fallback;
  const label = key === 'session' ? '5-hour' : key === 'weekly' ? 'Weekly' : key === 'daily' ? 'Daily' : key === 'monthly' ? 'Monthly'
    : m ? (m % 1440 === 0 ? `${m / 1440}-day` : m % 60 === 0 ? `${m / 60}-hour` : `${m}-minute`) : 'Limit';
  return { key, label, usedPercent: pct(usedPercent), resetsAt: when(resetsAt), durationMs: m ? m * 60_000 : DURATION[key] ?? null };
}

/** The account a profile signs in as: engine plus the home that isolates it. */
export function limitAccountOf(profile) {
  const engine = profile.engine;
  if (!ENGINES[engine]) return null;
  if (engine === 'devin') return `devin|${devinAccountDir({ env: profile.env ?? {} })}`;
  const h = HOMES[engine];
  return `${engine}|${expand(profile.env?.[h.env] ?? h.home)}`;
}

/** "Claude · personal" from ~/.claude-personal; plain "Claude" for the default home. */
function accountName(key) {
  const [engine, home] = key.split('|');
  const base = basename(home || '');
  const suffix = base.replace(/^\.?[a-z]+-?/i, '');
  const name = ENGINES[engine];
  if (engine === 'devin') return base && base !== 'devin' ? `${name} · ${base.replace(/^devin-?/, '')}` : name;
  return suffix && base.startsWith(`.${engine}-`) ? `${name} · ${suffix}` : name;
}

// ---- Codex ------------------------------------------------------------------

/** A rollout's snake_case rate_limits, or the app-server's camelCase snapshot. */
export function codexReading(rl, at) {
  if (!rl || typeof rl !== 'object') return null;
  const windows = [rl.primary, rl.secondary]
    .filter((w) => w && pct(w.used_percent ?? w.usedPercent) != null)
    .map((w, i) => windowOf(w.window_minutes ?? w.windowDurationMins, w.used_percent ?? w.usedPercent, w.resets_at ?? w.resetsAt, i ? 'secondary' : 'primary'));
  const spend = rl.individual_limit ?? rl.individualLimit;
  const left = pct(spend?.remaining_percent ?? spend?.remainingPercent);
  if (left != null) windows.push({ key: 'spend', label: 'Spend limit', usedPercent: 100 - left, resetsAt: when(spend.resets_at ?? spend.resetsAt), durationMs: null });
  const credits = [];
  const c = rl.credits;
  if (c?.unlimited) credits.push('Unlimited credits');
  else if ((c?.has_credits ?? c?.hasCredits) && num(c.balance) != null) credits.push(`${count(c.balance)} credits left`);
  const plan = rl.plan_type ?? rl.planType;
  return {
    at, windows, source: 'cli',
    plan: plan ? planName(plan) : undefined,
    credits: credits.length ? credits : undefined,
    note: rl.rate_limit_reached_type ?? rl.rateLimitReachedType ? 'Limit reached' : undefined,
  };
}

async function tail(file, bytes = 512 * 1024) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Newest-first rollouts: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl names sort by time. */
async function recentRollouts(home, max = 12) {
  const out = [];
  const desc = async (dir) => (await readdir(dir).catch(() => [])).sort().reverse();
  const root = join(home, 'sessions');
  for (const y of await desc(root)) {
    for (const m of await desc(join(root, y))) {
      for (const d of await desc(join(root, y, m))) {
        for (const f of await desc(join(root, y, m, d))) {
          if (f.endsWith('.jsonl')) out.push(join(root, y, m, d, f));
          if (out.length >= max) return out;
        }
      }
    }
  }
  return out;
}

/** The last rate_limits Codex wrote, from the newest rollouts that hold one. */
export async function codexLocal(home) {
  for (const file of await recentRollouts(home)) {
    let text;
    try { text = await tail(file); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits":{')) continue;
      try {
        const line = JSON.parse(lines[i]);
        const reading = codexReading(line.payload?.rate_limits ?? line.rate_limits, when(line.timestamp) ?? Date.now());
        if (reading?.windows.length) return reading;
      } catch { /* a line cut by the tail read */ }
    }
  }
  return null;
}

export async function codexLive(home, fetchImpl = fetch) {
  const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
  const t = auth.tokens;
  if (!t?.access_token || !t?.account_id) throw new Error('signed out; sign in to Codex with ChatGPT');
  const headers = { Authorization: `Bearer ${t.access_token}`, 'chatgpt-account-id': t.account_id, 'User-Agent': 'codex_cli_rs/0.1.0' };
  const [res, resets] = await Promise.all([
    fetchImpl('https://chatgpt.com/backend-api/wham/usage', { headers, signal: AbortSignal.timeout(10_000) }),
    fetchImpl('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null),
  ]);
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'signed out; sign in to Codex again' : `Codex answered ${res.status}`);
  const u = await res.json();
  const windows = [u.rate_limit?.primary_window, u.rate_limit?.secondary_window]
    .filter((w) => w && pct(w.used_percent) != null)
    .map((w, i) => windowOf((num(w.limit_window_seconds) ?? 0) / 60 || w.window_minutes, w.used_percent, w.reset_at, i ? 'secondary' : 'primary'));
  const credits = [];
  if (u.credits?.unlimited) credits.push('Unlimited credits');
  else if (u.credits?.has_credits && num(u.credits.balance) != null) credits.push(`${count(u.credits.balance)} credits left`);
  let expiry = null;
  if (resets?.ok) {
    const body = await resets.json().catch(() => null);
    expiry = (body?.credits ?? [])
      .filter((c) => (!c.status || c.status === 'available') && c.expires_at)
      .map((c) => when(c.expires_at)).sort((a, b) => a - b)[0] ?? null;
  }
  const banked = num(u.rate_limit_reset_credits?.available_count);
  if (banked) credits.push(`${banked} limit reset${banked === 1 ? '' : 's'} saved${expiry ? `, first expires ${new Date(expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}`);
  return {
    at: Date.now(), windows, source: 'live',
    plan: u.plan_type ? planName(u.plan_type) : undefined,
    credits: credits.length ? credits : undefined,
    note: u.rate_limit?.limit_reached ? 'Limit reached' : undefined,
  };
}

// ---- Claude -----------------------------------------------------------------

const CLAUDE_WINDOWS = {
  five_hour: ['session', '5-hour'],
  seven_day: ['weekly', 'Weekly'],
  seven_day_opus: ['weekly_opus', 'Weekly · Opus'],
  seven_day_sonnet: ['weekly_sonnet', 'Weekly · Sonnet'],
};
const claudeWindow = (name, utilization, resetsAt) => {
  const [key, label] = CLAUDE_WINDOWS[name] ?? [name, name.replace(/_/g, ' ')];
  return { key, label, usedPercent: pct(utilization), resetsAt: when(resetsAt), durationMs: /five/.test(name) ? DURATION.session : /seven/.test(name) ? DURATION.weekly : null };
};

/** What a driven chat's `rate_limit_event` said, utilisation as 0..1. */
export function claudeChatReading(info, at = Date.now()) {
  if (!info || typeof info !== 'object') return null;
  const named = info.unifiedWindows && typeof info.unifiedWindows === 'object'
    ? info.unifiedWindows
    : info.rateLimitType && info.utilization != null ? { [info.rateLimitType]: { utilization: info.utilization, resetsAt: info.resetsAt } } : {};
  const windows = Object.entries(named)
    .filter(([, w]) => w && num(w.utilization) != null)
    .map(([name, w]) => claudeWindow(name, Math.round(Number(w.utilization) * 1000) / 10, w.resetsAt));
  if (!windows.length) return null;
  return { at, windows, source: 'chat', note: info.status === 'rejected' ? 'Limit reached' : undefined };
}

/** The shape both Claude's config cache and its usage endpoint use: utilisation 0..100. */
function claudeUsageWindows(u) {
  return Object.keys(CLAUDE_WINDOWS)
    .filter((name) => u?.[name] && num(u[name].utilization) != null)
    .map((name) => claudeWindow(name, u[name].utilization, u[name].resets_at));
}

export async function claudeLocal(home) {
  const data = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
  const cached = data.cachedUsageUtilization;
  const windows = claudeUsageWindows(cached?.utilization);
  return {
    identity: data.oauthAccount?.emailAddress || undefined,
    reading: windows.length && cached.fetchedAtMs ? { at: cached.fetchedAtMs, windows, source: 'cli' } : null,
  };
}

export async function claudeLive(home, fetchImpl = fetch) {
  const raw = JSON.parse(await readFile(join(home, '.credentials.json'), 'utf8'));
  const token = raw.claudeAiOauth?.accessToken;
  if (!token) throw new Error('signed out; sign in to Claude again');
  // Claude renews this sign-in itself when it runs; helm never does, because
  // renewing replaces the saved key the CLI is holding. The limits a chat
  // reports keep the card current meanwhile.
  const expires = raw.claudeAiOauth.expiresAt;
  if (expires != null && Number(expires) < Date.now()) throw new Error('sign-in expired; it renews next time Claude runs in a terminal');
  const res = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(res.status === 429 ? 'Claude asked to wait; try again in a few minutes'
      : res.status === 401 || res.status === 403 ? 'signed out; sign in to Claude again' : `Claude answered ${res.status}`);
  }
  const u = await res.json();
  const credits = [];
  const extra = u.extra_usage;
  if (extra?.is_enabled && num(extra.monthly_limit)) {
    credits.push(`Extra usage: $${(Number(extra.used_credits ?? 0) / 100).toFixed(2)} of $${(Number(extra.monthly_limit) / 100).toFixed(2)} this month`);
  }
  return { at: Date.now(), windows: claudeUsageWindows(u), source: 'live', credits: credits.length ? credits : undefined };
}

// ---- Devin ------------------------------------------------------------------

export function devinReading(status, at = Date.now()) {
  const plan = status?.planStatus ?? {};
  const info = plan.planInfo ?? {};
  const row = (key, label, remaining, resetAt) => ({
    key, label, usedPercent: remaining == null ? null : Math.round(100 - remaining), resetsAt: when(resetAt), durationMs: DURATION[key],
  });
  const daily = pct(plan.dailyQuotaRemainingPercent);
  const weekly = pct(plan.weeklyQuotaRemainingPercent);
  const windows = [];
  // A Max plan hides the daily line: its one number is the weekly quota.
  if (info.hideDailyQuota && weekly == null && daily != null) windows.push(row('weekly', 'Weekly', daily, plan.weeklyQuotaResetAtUnix));
  else {
    if (!info.hideDailyQuota && daily != null) windows.push(row('daily', 'Daily', daily, plan.dailyQuotaResetAtUnix));
    if (!info.hideWeeklyQuota && weekly != null) windows.push(row('weekly', 'Weekly', weekly, plan.weeklyQuotaResetAtUnix));
  }
  const credits = [];
  if (num(plan.availablePromptCredits) != null && Number(plan.availablePromptCredits) >= 0) credits.push(`${count(plan.availablePromptCredits)} prompt credits left`);
  if (num(plan.acuLimit) > 0) credits.push(`${count(plan.acuConsumed ?? 0)} of ${count(plan.acuLimit)} ACUs used`);
  return {
    at, windows, source: 'live',
    plan: info.planName || undefined,
    identity: info.devinInfo?.accountDisplayName || undefined,
    credits: credits.length ? credits : undefined,
  };
}

// ---- BroMyLimits ------------------------------------------------------------

/** BroMyLimits names accounts provider-label; map them back onto homes. */
function dashboardKey(a) {
  const h = HOMES[a.provider];
  if (!h) return null;
  const label = String(a.label || a.id.replace(`${a.provider}-`, ''));
  return `${a.provider}|${expand(label === 'default' ? h.home : `${h.home}-${label}`)}`;
}

export function dashboardReading(account) {
  const rl = account.rateLimits;
  if (!rl || typeof rl !== 'object') return null;
  const entry = (label, e, fallbackKey) => {
    const used = pct(e.percent ?? e.pct ?? (e.remainingPercent != null ? 100 - e.remainingPercent : null));
    const key = /week/i.test(label) ? 'weekly' : /5h|five|session/i.test(label) ? 'session' : /day/i.test(label) ? 'daily' : fallbackKey;
    return { key, label: String(label).replace(/Five Hour Limit/i, '5-hour').replace(/\s+Limit$/i, '').replace(/^Session \(5h\)$/, '5-hour'), usedPercent: used, resetsAt: when(e.resetsAt), durationMs: DURATION[key] ?? null };
  };
  const windows = (Array.isArray(rl.windows) && rl.windows.length
    ? rl.windows.map((w, i) => entry(w.label || `Limit ${i + 1}`, w, `w${i}`))
    : [rl.session && entry(rl.session.label || 'Session (5h)', rl.session, 'session'), rl.weekly && entry(rl.weekly.label || 'Weekly', rl.weekly, 'weekly')].filter(Boolean))
    .filter((w) => w.usedPercent != null);
  const credits = [];
  const c = rl.credits;
  if (num(c?.balance) > 0) credits.push(`${count(c.balance)} credits left`);
  if (rl.resetsAvailable?.available) {
    const n = rl.resetsAvailable.available;
    credits.push(`${n} limit reset${n === 1 ? '' : 's'} saved${rl.resetsAvailable.expiresAt ? `, first expires ${new Date(rl.resetsAvailable.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}`);
  }
  const at = num(rl.fetchedAtMs) ?? when(account.fetchedAt);
  return {
    at, windows, source: 'dashboard',
    plan: rl.planLabel || rl.subscriptionTier || account.planLabel || undefined,
    credits: credits.length ? credits : undefined,
    note: rl.error ? `Couldn't check: ${rl.error}` : rl.note || undefined,
  };
}

// ---- Putting it together ----------------------------------------------------

/** Newest reading with windows wins; plan, identity and credits fill in from the rest. */
export function pickReading(readings) {
  const usable = readings.filter(Boolean);
  const withWindows = usable.filter((r) => r.windows?.length).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const best = withWindows[0] ?? usable.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
  if (!best) return null;
  const out = { ...best };
  for (const r of usable) {
    for (const k of ['plan', 'identity', 'credits']) if (out[k] == null && r[k] != null) out[k] = r[k];
  }
  return out;
}

export class Limits {
  #chat = new Map();
  #live = new Map();
  #tried = new Map();
  #devin = new Map();
  #saving = null;

  constructor({ profiles, file = join(HELM_DIR, 'limits.json'), fetchImpl = fetch, dashboardUrl = broMyLimitsUrl } = {}) {
    this.profiles = profiles;
    this.file = file;
    this.fetch = fetchImpl;
    this.dashboardUrl = dashboardUrl;
    this.loaded = this.#load();
  }

  async #load() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      for (const [k, v] of Object.entries(saved.chat ?? {})) this.#chat.set(k, v);
      for (const [k, v] of Object.entries(saved.live ?? {})) this.#live.set(k, v);
    } catch { /* first run */ }
  }

  #save() {
    this.#saving ??= setTimeout(async () => {
      this.#saving = null;
      const tmp = `${this.file}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify({ chat: Object.fromEntries(this.#chat), live: Object.fromEntries(this.#live) }));
        await rename(tmp, this.file);
      } catch { /* a reading lost on restart is re-read next turn */ }
    }, 2000);
    this.#saving.unref?.();
  }

  /** A driven chat reported its account's limits. */
  async note(profileId, event) {
    const profile = (await this.profiles().catch(() => [])).find((p) => p.id === profileId);
    const key = profile && limitAccountOf(profile);
    if (!key || !event) return;
    const reading = profile.engine === 'claude' ? claudeChatReading(event.claude)
      : profile.engine === 'codex' ? codexReading(event.codex, Date.now()) : null;
    if (!reading?.windows.length) return;
    // Codex's rolling updates are sparse: a window it left out still stands.
    const prev = this.#chat.get(key);
    if (prev) {
      for (const w of prev.windows) if (!reading.windows.some((n) => n.key === w.key)) reading.windows.push(w);
      for (const k of ['plan', 'credits']) reading[k] ??= prev[k];
    }
    reading.source = 'chat';
    this.#chat.set(key, reading);
    this.#save();
  }

  async #dashboard() {
    try {
      const url = await this.dashboardUrl();
      if (!url) return new Map();
      const endpoint = new URL('api/usage', url.endsWith('/') ? url : `${url}/`);
      endpoint.searchParams.set('scope', 'local');
      const res = await this.fetch(endpoint, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return new Map();
      const data = await res.json();
      const out = new Map();
      for (const a of data.accounts ?? []) {
        if (a.remote === true) continue;
        const key = typeof a.id === 'string' && dashboardKey(a);
        const reading = key && dashboardReading({ ...a, fetchedAt: data.fetchedAt });
        if (reading) out.set(key, reading);
      }
      return out;
    } catch {
      return new Map();
    }
  }

  async #devinStatus(key, profile, refresh) {
    const hit = this.#devin.get(key);
    if (hit && !refresh && Date.now() - hit.at < DEVIN_TTL_MS) return hit.value;
    const value = (async () => {
      const dir = devinAccountDir({ env: profile.env ?? {} });
      return devinReading(await fetchDevinUserStatus(devinCredentials(dir), { fetchImpl: this.fetch }));
    })().catch((e) => ({ at: Date.now(), windows: [], source: 'live', error: String(e.message || e) }));
    this.#devin.set(key, { at: Date.now(), value });
    return value;
  }

  async #upstream(key, run, refresh) {
    if (!refresh) return this.#live.get(key) ?? null;
    if (Date.now() - (this.#tried.get(key) ?? 0) < LIVE_BACKOFF_MS) return this.#live.get(key) ?? null;
    this.#tried.set(key, Date.now());
    try {
      const fresh = await run();
      this.#live.set(key, fresh);
      this.#save();
      return fresh;
    } catch (e) {
      return { ...(this.#live.get(key) ?? { at: 0, windows: [] }), error: String(e.message || e) };
    }
  }

  /** Every account on this machine with limits, and how much of each is left. */
  async report({ refresh = false } = {}) {
    await this.loaded;
    const profiles = await this.profiles();
    const accounts = new Map();
    for (const p of profiles) {
      const key = limitAccountOf(p);
      if (!key) continue;
      const a = accounts.get(key) ?? { key, profile: p, profileIds: [] };
      a.profileIds.push(p.id);
      accounts.set(key, a);
    }
    const dashboard = await this.#dashboard();
    const out = await Promise.all([...accounts.values()].map(async ({ key, profile, profileIds }) => {
      const [engine, home] = key.split('|');
      const readings = [this.#chat.get(key), dashboard.get(key)];
      let identity;
      let error;
      if (engine === 'codex' && existsSync(home)) {
        readings.push(await codexLocal(home).catch(() => null));
        readings.push(await this.#upstream(key, () => codexLive(home, this.fetch), refresh));
      } else if (engine === 'claude' && existsSync(home)) {
        const local = await claudeLocal(home).catch(() => null);
        identity = local?.identity;
        readings.push(local?.reading);
        readings.push(await this.#upstream(key, () => claudeLive(home, this.fetch), refresh));
      } else if (engine === 'devin') {
        readings.push(await this.#devinStatus(key, profile, refresh));
      }
      // An error only matters when nothing else could answer.
      for (const r of readings) if (r?.error) error ??= r.error;
      const best = pickReading(readings.map((r) => r && (r.windows?.length || r.plan || r.credits ? r : null)));
      return {
        account: key,
        engine,
        name: accountName(key),
        profileIds,
        identity: best?.identity ?? identity,
        plan: best?.plan,
        windows: best?.windows ?? [],
        credits: best?.credits,
        note: best?.note,
        at: best?.at ?? null,
        source: best?.source ?? null,
        error: best?.windows?.length ? undefined : error,
      };
    }));
    const order = Object.keys(ENGINES);
    out.sort((a, b) => order.indexOf(a.engine) - order.indexOf(b.engine) || a.name.localeCompare(b.name));
    return { accounts: out, at: Date.now() };
  }
}
