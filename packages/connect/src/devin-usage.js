import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expand, HOME } from './paths.js';
import { formatReset, quotaBar } from './quota.js';

/**
 * Devin's /usage card, headless.
 *
 * `devin acp` does not implement /usage at all - it answers it with
 * "Unknown command". In the standalone CLI the card is a TUI feature that
 * reads the account's quota from the seat-management API
 * (`exa.seat_management_pb.SeatManagementService/GetUserStatus`) rather
 * than from the session, so helm makes the same read here: a Connect JSON
 * POST authenticated by the session token in the account's
 * credentials.toml. The "consumed this session" line is the one part that
 * is local, summed from the session database the transcript points at.
 */

const mdEscape = (value) => String(value ?? '').replace(/([\\`*_{}\[\]()<>#+.!|])/g, '\\$1');
const number = (value) => Number(value).toLocaleString('en-US');
/** Trim a metric to something readable: 1.5, not 1.5000000000002. */
const trim = (value) => Number(Number(value).toFixed(2)).toLocaleString('en-US');

const dataHome = (env) => expand(env?.XDG_DATA_HOME || process.env.XDG_DATA_HOME || join(HOME, '.local', 'share'));

/**
 * The Devin account directory - `<XDG_DATA_HOME>/<devin*>/` - that owns
 * this session. A transcript is the account's own database
 * (`<dir>/cli/sessions.db`) and names the dir outright; without one, the
 * session id is looked up across accounts; without even that, the default
 * `devin` dir wins.
 */
export function devinAccountDir({ transcript = null, engineSessionId = null, env = {} } = {}) {
  const base = dataHome(env);
  const named = /^(.+)\/cli\/sessions\.db$/.exec(expand(transcript ?? ''))?.[1];
  if (named && existsSync(join(named, 'credentials.toml'))) return named;
  let dirs = [];
  try { dirs = readdirSync(base).filter((d) => d.startsWith('devin')); } catch { /* no data dir yet */ }
  if (engineSessionId) {
    for (const d of dirs) {
      const db = join(base, d, 'cli', 'sessions.db');
      if (!existsSync(db)) continue;
      try {
        const conn = new DatabaseSync(db, { readOnly: true });
        const found = conn.prepare('SELECT 1 AS x FROM sessions WHERE id = ?').get(engineSessionId);
        conn.close();
        if (found) return join(base, d);
      } catch { /* a locked or half-migrated db says nothing */ }
    }
  }
  const credentialed = dirs.filter((d) => existsSync(join(base, d, 'credentials.toml')));
  if (credentialed.includes('devin')) return join(base, 'devin');
  if (credentialed.length) return join(base, credentialed.sort()[0]);
  return named ?? join(base, 'devin');
}

/** credentials.toml is a flat `key = "value"` file; a TOML parser is overkill. */
export function devinCredentials(accountDir) {
  let text = '';
  try {
    text = readFileSync(join(accountDir, 'credentials.toml'), 'utf8');
  } catch {
    throw new Error('Devin credentials not found - run `devin auth login` in a terminal first');
  }
  const get = (key) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(text)?.[1] ?? null;
  const apiKey = get('windsurf_api_key');
  const apiServerUrl = get('api_server_url');
  if (!apiKey || !apiServerUrl) {
    throw new Error('Devin credentials are incomplete - run `devin auth login` in a terminal first');
  }
  return { apiKey, apiServerUrl };
}

/**
 * The binary's own request shape: Connect JSON (not protobuf), the session
 * token carried as `metadata.apiKey` like every other Codeium call it makes.
 */
export async function fetchDevinUserStatus({ apiKey, apiServerUrl }, { version = '3000.10.0', fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${apiServerUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({
        metadata: { apiKey, ideName: 'devin', ideVersion: version, extensionName: 'devin', extensionVersion: version, locale: 'en' },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`Failed to fetch quota: ${err?.message ?? err}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.code) throw new Error(`Failed to fetch quota: ${body?.message ?? `HTTP ${res.status}`}`);
  return body?.userStatus ?? {};
}

const COST_DIM = /credit|acu|quota|cost/i;

/**
 * What this session has spent. The costs the stream commits land in
 * chat_message metadata - `committed_*` fields for credit billing, and
 * cost-bearing response_dimensions on either plan - summed across the
 * latest snapshot of each message, the same way /session-stats totals them.
 */
export function devinSessionConsumption(dbPath, sessionId) {
  const conn = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const latest = new Map();
    for (const r of conn.prepare('SELECT chat_message FROM message_nodes WHERE session_id = ?').all(sessionId)) {
      let m;
      try { m = JSON.parse(r.chat_message); } catch { continue; }
      if (m?.message_id) latest.set(m.message_id, m);
    }
    const dims = new Map();
    let credits = 0, acus = 0;
    for (const m of latest.values()) {
      const md = m.metadata ?? {};
      credits += Number(md.committed_credit_cost ?? 0);
      acus += Number(md.committed_acu_cost ?? 0);
      for (const d of md.response_dimensions ?? []) {
        if (!COST_DIM.test(d?.uid ?? '') && !COST_DIM.test(d?.group_title ?? '')) continue;
        const k = d?.kind?.CumulativeMetric;
        if (!k) continue;
        const cur = dims.get(d.uid) ?? { label: k.label ?? d.uid, value: 0, prefix: k.prefix ?? '', tail: k.tail ?? '', pluralTail: k.plural_tail ?? '' };
        cur.value += Number(k.value ?? 0);
        dims.set(d.uid, cur);
      }
    }
    // A cost dimension and the committed fields describe the same spend;
    // reporting both would double it, so dimensions win when they exist.
    const parts = [...dims.values()].map((d) => `${d.prefix}${trim(d.value)}${d.value === 1 ? d.tail : d.pluralTail}`);
    if (!parts.length) {
      if (credits) parts.push(`${trim(credits)} credits`);
      if (acus) parts.push(`${trim(acus)} ACUs`);
    }
    return parts;
  } finally {
    conn.close();
  }
}

/**
 * The card the TUI draws: a bar per quota window filled to the percent
 * used, the reset beside it, plan facts underneath, then what this session
 * consumed.
 */
export function formatDevinUsage(userStatus, consumed = [], { now = Date.now() } = {}) {
  const plan = userStatus?.planStatus ?? {};
  const info = plan.planInfo ?? {};
  const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.min(100, Math.max(0, Number(v))));
  const row = (label, remaining, resetAt) => {
    const used = Math.round(100 - remaining);
    const reset = formatReset(resetAt, now);
    return `**${label}** ${quotaBar(used)} ${used}% used${reset ? ` · resets ${reset}` : ''}`;
  };
  const daily = pct(plan.dailyQuotaRemainingPercent);
  const weekly = pct(plan.weeklyQuotaRemainingPercent);
  const rows = [];
  // A Devin Max plan hides the daily line entirely: the one number it
  // returns under dailyQuotaRemainingPercent IS the weekly quota.
  if (info.hideDailyQuota && weekly == null && daily != null) {
    rows.push(row('Weekly', daily, plan.weeklyQuotaResetAtUnix));
  } else {
    if (!info.hideDailyQuota && daily != null) rows.push(row('Daily', daily, plan.dailyQuotaResetAtUnix));
    if (!info.hideWeeklyQuota && weekly != null) rows.push(row('Weekly', weekly, plan.weeklyQuotaResetAtUnix));
  }
  const facts = [];
  if (info.planName) facts.push(`**Plan:** ${mdEscape(info.planName)}`);
  if (info.devinInfo?.accountDisplayName) facts.push(`**Org:** ${mdEscape(info.devinInfo.accountDisplayName)}`);
  const credits = Number(plan.availablePromptCredits);
  if (Number.isFinite(credits) && credits >= 0) facts.push(`**Prompt credits:** ${number(credits)}`);
  const acuLimit = Number(plan.acuLimit);
  if (Number.isFinite(acuLimit) && acuLimit > 0) {
    facts.push(`**ACUs:** ${number(plan.acuConsumed ?? 0)} / ${number(acuLimit)} used`);
  }
  if (!rows.length && !facts.length) return '*No quota data available.*';
  const noun = /quota/i.test(info.billingStrategy ?? '') ? 'quota' : 'credits or ACUs';
  const spent = consumed.length
    ? `**Consumed this session:** ${consumed.map(mdEscape).join(' · ')}`
    : `*No ${noun} consumed yet in this session.*`;
  return ['### Usage', '', [...rows, ...facts].join('  \n'), '', spent].join('\n');
}

/**
 * The whole /usage answer for one session: resolve the account, fetch its
 * quota, sum what the session spent from its own database.
 */
export async function devinUsageReport({ transcript = null, engineSessionId = null, env = {}, fetchStatus, version = '3000.10.0' } = {}) {
  const dir = devinAccountDir({ transcript, engineSessionId, env });
  const status = await (fetchStatus ?? fetchDevinUserStatus)(devinCredentials(dir), { version });
  const db = join(dir, 'cli', 'sessions.db');
  let consumed = [];
  try {
    if (engineSessionId && existsSync(db)) consumed = devinSessionConsumption(db, engineSessionId);
  } catch { /* the spend line is the bonus, not the card */ }
  return formatDevinUsage(status, consumed);
}
