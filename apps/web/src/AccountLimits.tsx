import { useEffect, useState } from 'react';
import type { Client, Environment } from './client';
import type { LimitWindow } from './session/limits';
import { resetPhrase } from './session/limits';

export interface LimitAccount {
  account: string; engine: string; label: string; displayLabel?: string; aliases: string[];
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
    const refresh = () => {
      setNow(Date.now());
      for (const env of targets) {
        if (busy.has(env.id)) continue;
        busy.add(env.id);
        client.rpc<LimitsReport>(env.id, 'usage.limits', {}, 15_000).then(report => {
          if (!live) return;
          setReports(r => ({ ...r, [env.id]: report }));
          setFailed(f => ({ ...f, [env.id]: false }));
        }).catch(() => {
          if (live) setFailed(f => ({ ...f, [env.id]: true }));
        }).finally(() => busy.delete(env.id));
      }
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [client, targets.map(e => e.id).join(',')]);
  return { reports, failed, now };
}

export function AccountLimits({ targets, limits }: { targets: Environment[]; limits: AccountLimitsState }) {
  const { reports, failed, now } = limits;
  const [expanded, setExpanded] = useState(false);
  const rows = targets.flatMap(env => (reports[env.id]?.accounts ?? []).map(account => ({ env, account })))
    .sort((a, b) => Number(!!b.account.windows.length) - Number(!!a.account.windows.length));
  const shown = expanded ? rows : rows.slice(0, 4);
  const unsupported = targets.reduce((n, e) => n + (reports[e.id]?.unsupported ?? 0), 0);
  return <section className="card usage-limits" aria-label="Account limits">
    <div className="usage-spend-head"><b>Account limits</b><span className="usage-spend-peak">Last reported allowance</span></div>
    <p className="usage-limits-note">Updates when chats report usage. Accounts are listed per machine.</p>
    {shown.map(({ env, account: a }) => <div className="usage-account" key={`${env.id}:${a.account}`}>
      <div className="usage-account-name" title={a.aliases.join(', ')}>
        <b>{a.engine} <span>{a.displayLabel || a.label}</span></b><small>{env.name}{failed[env.id] ? ' · unavailable' : ''}</small>
      </div>
      <div className="usage-account-windows">
        {!a.windows.length && <span className="usage-limits-note">No limit report yet</span>}
        {a.windows.map(w => {
          const expired = !!w.resetsAt && w.resetsAt * 1000 <= now;
          const left = Math.round((100 - w.used) * 10) / 10;
          return <div className={`usage-allowance${expired ? ' expired' : ''}`} key={w.label}>
            <div><span>{w.label}</span><b>{expired ? 'Awaiting report' : `${left}% left`}</b></div>
            {!expired && <div className="usage-meter" role="meter" aria-label={`${a.engine} ${a.displayLabel || a.label} ${w.label} remaining`}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={left}><span style={{ width: `${left}%` }} /></div>}
            <small>{expired ? 'Reset time passed' : resetPhrase(w.resetsAt, now) || 'Reset time unavailable'}</small>
            <small title={new Date(w.at).toLocaleString()}>Reported {age(w.at, now)} ago</small>
          </div>;
        })}
      </div>
    </div>)}
    {rows.length > 4 && <button className="linkish" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show fewer accounts' : `Show all ${rows.length} accounts`}</button>}
    {targets.filter(e => !reports[e.id]).map(e => <p className="usage-limits-note" key={e.id}>{e.name} · {failed[e.id] ? 'Limits unavailable' : 'Reading limit reports…'}</p>)}
    {!rows.length && targets.every(e => reports[e.id]) && <p className="usage-limits-note">No Claude or Codex accounts configured.</p>}
    {unsupported > 0 && <p className="usage-limits-note">{unsupported} other {unsupported === 1 ? 'account does' : 'accounts do'} not provide limit reports here.</p>}
  </section>;
}

function age(at: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 1 ? 'less than a minute' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
