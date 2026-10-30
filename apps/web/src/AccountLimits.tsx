import { useEffect, useState } from 'react';
import type { Client, Environment } from './client';
import type { LimitWindow } from './session/limits';
import { resetPhrase, whenPhrase } from './session/limits';
import { EngineMark } from './EngineMark';

export interface LimitAccount {
  account: string; engine: string; label: string; displayLabel?: string; aliases: string[];
  /** Who the provider bills, fingerprinted the same on every machine. Absent from older daemons. */
  identity?: string;
  windows: (LimitWindow & { at: number })[];
}
interface LimitsReport { accounts: LimitAccount[]; unsupported: number }

export interface AccountLimitsState {
  reports: Record<string, LimitsReport>;
  failed: Record<string, boolean>;
  now: number;
}

/** What each machine last reported about its accounts' allowances, refreshed every half minute. */
export function useAccountLimits(client: Client, targets: Environment[]): AccountLimitsState {
  const [reports, setReports] = useState<Record<string, LimitsReport>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    const busy = new Set<string>();
    // Only while in sight, and a machine that says the same again draws nothing.
    const refresh = () => {
      if (document.hidden) return;
      setNow(Date.now());
      for (const env of targets) {
        if (busy.has(env.id)) continue;
        busy.add(env.id);
        client.rpc<LimitsReport>(env.id, 'usage.limits', {}, 15_000).then(report => {
          if (!live) return;
          setReports(r => JSON.stringify(r[env.id]) === JSON.stringify(report) ? r : { ...r, [env.id]: report });
          setFailed(f => f[env.id] === false ? f : { ...f, [env.id]: false });
        }).catch(() => {
          if (live) setFailed(f => f[env.id] ? f : { ...f, [env.id]: true });
        }).finally(() => busy.delete(env.id));
      }
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [client, targets.map(e => e.id).join(',')]);
  return { reports, failed, now };
}

/** API-equivalent spend for one login home over the chosen period. */
export interface PlanSpend { key: string; engine: string; profileId: string; costUsd: number; unpriced: boolean }

type Reading = LimitAccount['windows'][number];
interface Row {
  key: string; account: LimitAccount;
  /** Every machine's report this row stands for: one account, read in several places. */
  members: LimitAccount[];
  machines: { env: Environment; at: number }[]; windows: Reading[]; spends: (PlanSpend & { alone?: boolean })[]; shared?: string[];
}

const PLAN_KEY = 'helm.plans.v1';
const readPlans = (): Record<string, number> => {
  try { return JSON.parse(localStorage.getItem(PLAN_KEY) || '{}') ?? {}; } catch { return {}; }
};
/** How long each allowance window lasts, to measure pace. */
const WINDOW_MS: Record<string, number> = { '5h': 5 * 3_600_000, '7d': 7 * 86_400_000 };
/** The allowance windows as a person says them. */
const WINDOW_NAMES: Record<string, string> = { '5h': '5 hours', '7d': 'Week' };
const money = (n: number) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
const nameOf = (a: LimitAccount) => a.displayLabel || a.label;
/** "/home/me/.claude" and "~/.claude" name the same login home. */
const tilde = (p: string) => p.replace(/^\/(home|Users)\/[^/|]+/, '~');
/** The short window first, then the week, then anything model-specific. */
const windowOrder = (label: string) => label === '5h' ? 0 : label === '7d' ? 1 : 2;
const newest = (windows: Reading[]) => windows.length ? Math.max(...windows.map(w => w.at)) : 0;
const sameReadings = (a: Reading[], b: Reading[]) => a.length === b.length
  && a.every(w => b.some(v => v.label === w.label && v.used === w.used && v.resetsAt === w.resetsAt));

/**
 * One row per account: its allowance, how fast it is going, and what the
 * period's use is worth at API rates. The allowance used to be drawn twice -
 * once here and again in a separate plan card - so the same weekly meter sat
 * on screen up to four times.
 *
 * Rows are per machine report. Two machines' rows become one only when they
 * name the same credential (the last part of the account key is set) and
 * read exactly the same; two logins sharing a home folder never merge.
 */
export function AccountLimits({ targets, limits, spend = [], win }: {
  targets: Environment[]; limits: AccountLimitsState;
  spend?: PlanSpend[];
  /** The usage period, to scale spend to a week; absent before usage loads. */
  win?: '1d' | '7d' | '30d' | 'all';
}) {
  const { reports, failed, now } = limits;
  const [expanded, setExpanded] = useState(false);
  const [plans, setPlans] = useState<Record<string, number>>(readPlans);
  const setPlan = (key: string, value: string) => {
    const n = Number(value);
    const next = { ...plans };
    if (value.trim() && Number.isFinite(n) && n > 0) next[key] = n; else delete next[key];
    setPlans(next);
    try { localStorage.setItem(PLAN_KEY, JSON.stringify(next)); } catch { /* shown, not kept */ }
  };

  const rows: Row[] = [];
  for (const env of targets) for (const account of reports[env.id]?.accounts ?? []) {
    // The same account, wherever it was read: one row, and each allowance
    // shows its newest reading from any machine. A machine that names who
    // the provider bills says so outright; without that (an older daemon),
    // only the same credential reading exactly the same numbers is safe to
    // merge - two logins sharing a home folder never are.
    const identity = account.identity ? `${account.engine}|${account.identity}` : '';
    const credential = account.account.split('|')[2];
    const twin = identity ? rows.find(r => r.members.some(m => m.identity && `${m.engine}|${m.identity}` === identity))
      : credential ? rows.find(r => r.account.account === account.account && sameReadings(r.windows, account.windows)) : undefined;
    if (twin) {
      twin.members.push(account);
      if (!twin.machines.some(m => m.env.id === env.id)) twin.machines.push({ env, at: newest(account.windows) });
      else twin.machines = twin.machines.map(m => m.env.id === env.id ? { env, at: Math.max(m.at, newest(account.windows)) } : m);
      const merged = new Map(twin.windows.map(w => [w.label, w]));
      for (const w of account.windows) if ((merged.get(w.label)?.at ?? -1) < w.at) merged.set(w.label, w);
      twin.windows = [...merged.values()].sort((a, b) => windowOrder(a.label) - windowOrder(b.label));
      continue;
    }
    rows.push({ key: `${env.id}:${account.account}`, account, members: [account], machines: [{ env, at: newest(account.windows) }], windows: account.windows, spends: [] });
  }
  // Accounts with a live allowance first; stale and silent ones sink.
  const fresh = (r: Row) => Number(r.windows.some(w => !w.resetsAt || w.resetsAt * 1000 > now)) * 2 + Number(!!r.windows.length);
  rows.sort((a, b) => fresh(b) - fresh(a));

  // Spend is counted per login home. It belongs to an account row only when
  // exactly one account uses that home; a shared home gets a line of its own.
  const loose: Row[] = [];
  for (const s of spend) {
    const owners = rows.filter(({ members }) => members.some(a => a.engine === s.engine
      && (tilde(a.account).startsWith(`${s.key}|`) || a.aliases.includes(s.profileId))));
    // The same account read on several machines is still one account.
    if (owners.length && owners.every(o => o.account.account === owners[0].account.account)) {
      const row = owners[0];
      // One account used from homes with different names (~/.claude-personal
      // here, ~/.claude there) is still one bill: add the homes together.
      const same = row.spends[0];
      if (same) row.spends[0] = { ...same, costUsd: same.costUsd + s.costUsd, unpriced: same.unpriced || s.unpriced, alone: same.alone && owners.length === 1 };
      else row.spends.push({ ...s, alone: owners.length === 1 });
    }
    else if (s.costUsd > 0) loose.push({ key: `spend:${s.key}`, spends: [s], windows: [], machines: [],
      members: [], shared: owners.map(o => nameOf(o.account)),
      account: { account: s.key, engine: s.engine, label: (owners.length ? s.key.split('|')[1] : s.profileId) || 'default', aliases: [], windows: [] } });
  }
  const all = [...rows, ...loose];
  const shown = expanded ? all : all.slice(0, 5);
  const reading = targets.some(e => !reports[e.id] && !failed[e.id]);
  const silent = targets.filter(e => !reports[e.id] && failed[e.id]).map(e => e.name);
  // What this period says about a week, so allowance and spend speak the
  // same unit. "All" has no length, so it shows only the raw figure.
  const perWeek = win === '7d' ? 1 : win === '1d' ? 7 : win === '30d' ? 7 / 30 : null;

  return <section className="usage-accounts" aria-label="Accounts">
    <h2 className="section">Accounts</h2>
    {shown.length > 0 && <div className="usage-panel">{shown.map(row => {
      const a = row.account;
      // A window past its reset says nothing true about now, so it is not
      // drawn. An account with nothing live and nothing spent is one line.
      const live = row.windows.filter(w => !w.resetsAt || w.resetsAt * 1000 > now);
      const spends = row.spends.filter(s => s.costUsd > 0 || plans[s.key]);
      const at = Math.max(0, ...row.machines.map(m => m.at));
      const where = row.machines.map(({ env: m, at }) => `${m.name}${failed[m.id] ? ' (unavailable)' : ''}${at ? ` ${age(at, now)} ago` : ''}`).join(' · ');
      return <div className={`usage-account${!row.shared && !live.length && !spends.length ? ' idle' : ''}`} key={row.key}>
        <div className="usage-account-name">
          <EngineMark engine={a.engine} className="usage-share-mark" />
          <b>{a.engine} <span>{nameOf(a)}</span></b>
          <small title={row.shared ? a.aliases.join(', ') : where}>
            {row.shared ? (row.shared.length ? `Shared by ${row.shared.join(', ')}` : 'Helm has no account report.')
              : !row.windows.length ? 'Helm has no limit report yet.'
              : !live.length ? 'No report since the reset'
              : at ? (now - at < 60_000 ? 'just now' : `${age(at, now)} ago`) : where}
          </small>
        </div>
        {live.length > 0 && <div className="usage-account-windows">
          {live.map(w => {
            const left = Math.round((100 - w.used) * 10) / 10;
            // How far through the window the reading was taken: pace is use
            // so far over time so far. A reading in the window's first
            // twentieth is kept from claiming a thousand percent.
            const span = WINDOW_MS[w.label];
            const elapsed = span && w.resetsAt
              ? Math.min(1, Math.max(0.05, 1 - (w.resetsAt * 1000 - w.at) / span)) : 0;
            const pace = elapsed ? w.used / elapsed : 0;
            // At that pace, when the rest is used up.
            const out = pace > 100 ? w.at + (100 - w.used) / w.used * elapsed * span : 0;
            return <div className={`usage-allowance${pace > 100 ? ' dry' : ''}`} key={w.label}
              title={pace > 0 ? `At this pace: ${Math.round(pace)}% used by the reset` : undefined}>
              <span className="usage-window">{WINDOW_NAMES[w.label] ?? w.label}</span>
              <div className="usage-meter" role="meter" aria-label={`${a.engine} ${nameOf(a)} ${w.label} remaining`}
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={left}><span style={{ width: `${left}%` }} /></div>
              <b>{left}% left</b>
              <small>
                {resetPhrase(w.resetsAt, now) || 'Helm has no reset time.'}
                {out > 0 && <> · <em>{out > now ? `Runs out ${whenPhrase(out, now)}` : 'Used up now at this pace'}</em></>}
              </small>
            </div>;
          })}
        </div>}
        {spends.map(s => {
          const weekly = perWeek === null ? null : s.costUsd * perWeek;
          const week = live.find(w => w.label === '7d' && w.resetsAt);
          // What the whole week's allowance buys at API rates, from this
          // week's spend and how much of the allowance it used.
          const worth = weekly !== null && week && week.used > 0 && s.alone ? weekly / (week.used / 100) : null;
          const price = plans[s.key];
          const weeklyPrice = price ? (price * 12) / 52 : null;
          return <div className="usage-value" key={s.key}>
            <span><b>{money(s.costUsd)}{s.unpriced ? '+' : ''}</b> at pay-per-use prices{weekly !== null && win !== '7d' ? ` · ≈ ${money(weekly)} a week` : ''}
              {worth !== null && <> · full week ≈ <b>{money(worth)}</b></>}</span>
            {weekly !== null && weeklyPrice && <span><b className="usage-plan-mult">{(weekly / weeklyPrice).toFixed(1)}×</b> the plan price</span>}
            <details className="usage-plan">
              <summary>{price ? `Plan $${price}/month` : 'Add plan price'}</summary>
              <label className="usage-plan-price">
                <span>Plan price per month, in dollars</span>
                <input type="number" inputMode="decimal" min="0" step="1" placeholder="Example: 200"
                  value={price ?? ''} onChange={(e) => setPlan(s.key, e.target.value)} />
              </label>
            </details>
          </div>;
        })}
      </div>;
    })}</div>}
    {all.length > 5 && <button className="linkish" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer accounts' : `Show all ${all.length} accounts`}</button>}
    {/* One line for the machines that did not answer, not a line each.
        Accounts whose CLI never reports limits are simply not listed. */}
    {reading && <p className="usage-limits-note">Helm is reading limits.</p>}
    {silent.length > 0 && <p className="usage-limits-note">Helm has no limit reports from {silent.join(', ')}.</p>}
    {!all.length && targets.every(e => reports[e.id]) && <p className="usage-limits-note">No Claude or Codex accounts are set up.</p>}
  </section>;
}

function age(at: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 1 ? 'less than a minute' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
