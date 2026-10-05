import { useEffect, useRef, useState } from 'react';
import type { Client, Environment, LimitAccount, LimitWindow, LimitsReport } from './client';
import { loadLimits, saveLimits } from './usageCache';
import { EngineMark } from './EngineMark';

/**
 * How much of each account's limits is left, and when it comes back.
 *
 * The question this answers is "can I keep working on this account?", so
 * every bar shows what is *left* - the number the CLIs' own cards make you
 * subtract to get. Each machine answers from what its CLIs already wrote;
 * "Check now" is the one thing that asks Claude and Codex directly.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const left = (w: LimitWindow) => Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));

function until(ms: number, now: number) {
  const d = ms - now;
  const mins = Math.max(1, Math.round(d / MINUTE));
  if (mins < 60) return `${mins}m`;
  if (d < 48 * HOUR) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(d / (24 * HOUR))} days`;
}

function resetText(at: number, now: number) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (at - now < 20 * HOUR) return `back in ${until(at, now)}, at ${time}`;
  return `back ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

function ago(ts: number, now: number) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

/**
 * Will it run out before it renews? Spending at the rate so far this window,
 * the time until empty against the time until reset. Only said when it is
 * true: a note on every bar saying "fine" is noise.
 */
function runsOut(w: LimitWindow, now: number): string | null {
  if (!w.resetsAt || !w.durationMs || w.usedPercent < 5 || w.usedPercent >= 100) return null;
  const start = w.resetsAt - w.durationMs;
  const spent = now - start;
  // Early in a window one busy hour looks like a habit; wait for a fifth of it.
  if (spent < w.durationMs * 0.2) return null;
  const perMs = w.usedPercent / spent;
  const empty = (100 - w.usedPercent) / perMs;
  if (empty >= (w.resetsAt - now) * 0.9) return null;
  return `at this pace, runs out in ${until(now + empty, now)}`;
}

const SOURCE: Record<string, string> = {
  chat: 'from a chat',
  cli: 'from the CLI',
  dashboard: 'from BroMyLimits',
  live: 'checked online',
};

function WindowRow({ w, now }: { w: LimitWindow; now: number }) {
  const renewed = w.resetsAt != null && w.resetsAt <= now;
  const pctLeft = renewed ? 100 : left(w);
  const tone = renewed ? 'renewed' : pctLeft <= 10 ? 'low' : pctLeft <= 30 ? 'mid' : 'ok';
  const warn = renewed ? null : runsOut(w, now);
  // Where the bar would be if use were spread evenly over the window.
  const even = !renewed && w.resetsAt && w.durationMs
    ? Math.max(0, Math.min(100, ((w.resetsAt - now) / w.durationMs) * 100)) : null;
  return (
    <div className={`limit-row ${tone}`}>
      <div className="limit-row-head">
        <span className="limit-label">{w.label}</span>
        <span className="limit-left">{renewed ? 'renewed' : pctLeft === 0 ? 'used up' : `${pctLeft}% left`}</span>
      </div>
      <div className="limit-track" role="meter" aria-label={`${w.label} left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pctLeft}>
        <span style={{ width: `${pctLeft}%` }} />
        {even != null && <i style={{ left: `${even}%` }} title="where an even pace would be" />}
      </div>
      <div className="limit-reset">
        {renewed ? 'Renewed since the last reading. Check now for a fresh number.'
          : w.resetsAt ? resetText(w.resetsAt, now) : ''}
        {warn && <b> · {warn}</b>}
      </div>
    </div>
  );
}

function AccountCard({ a, machine, now }: { a: LimitAccount; machine?: string; now: number }) {
  const who = [a.identity, machine].filter(Boolean).join(' · ');
  const old = a.at != null && now - a.at > 24 * HOUR;
  return (
    <div className="card limit-card">
      <div className="limit-card-head">
        <EngineMark engine={a.engine} />
        <div className="limit-card-title">
          <b>{a.name}</b>
          {who && <span>{who}</span>}
        </div>
        {a.plan && <span className="limit-plan">{a.plan}</span>}
      </div>
      {a.note && <div className="limit-note">{a.note}</div>}
      {a.windows.map((w) => <WindowRow key={w.key + w.label} w={w} now={now} />)}
      {a.credits?.map((c) => <div key={c} className="limit-extra">{c}</div>)}
      <div className={`limit-foot${old ? ' old' : ''}`}>
        {a.at ? `Updated ${ago(a.at, now)}${a.source ? `, ${SOURCE[a.source] ?? a.source}` : ''}` : ''}
        {a.error && <span className="limit-error">{a.at ? ' · ' : ''}Couldn't check: {a.error}</span>}
      </div>
    </div>
  );
}

export function LimitsSection({ client, targets }: { client: Client; targets: Environment[] }) {
  const [reports, setReports] = useState<Record<string, LimitsReport>>({});
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const ids = targets.map((e) => e.id).join(',');
  const generation = useRef(0);

  const ask = (refresh: boolean) => {
    const gen = generation.current;
    return Promise.all(targets.map((env) => client.limits(env.id, refresh)
      .then((report) => {
        if (generation.current !== gen) return;
        setReports((r) => ({ ...r, [env.id]: report }));
        setFailed((f) => { const { [env.id]: _gone, ...rest } = f; return rest; });
        saveLimits(env.id, report);
      })
      .catch((e) => { if (generation.current === gen) setFailed((f) => ({ ...f, [env.id]: String(e?.message || e) })); })));
  };

  useEffect(() => {
    generation.current++;
    setReports({});
    setFailed({});
    for (const env of targets) {
      loadLimits(env.id).then((hit) => {
        if (hit) setReports((r) => (r[env.id] ? r : { ...r, [env.id]: hit.report }));
      });
    }
    ask(false);
    const poll = setInterval(() => ask(false), 60_000);
    // The "back in 2h" lines are relative to now, so they tick on their own.
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [ids]);

  const checkNow = async () => {
    setChecking(true);
    try { await ask(true); } finally { setChecking(false); setNow(Date.now()); }
  };

  const many = targets.filter((e) => reports[e.id]).length > 1;
  const cards: { a: LimitAccount; machine?: string }[] = [];
  const empty: string[] = [];
  for (const env of targets) {
    for (const a of reports[env.id]?.accounts ?? []) {
      if (!a.windows.length && !a.credits?.length) {
        empty.push(`${many ? `${a.name} on ${env.name}` : a.name}${a.error ? ` (${a.error})` : ''}`);
        continue;
      }
      // The same login on two machines is one set of limits; keep the newest.
      const same = a.identity ? cards.findIndex((c) => c.a.engine === a.engine && c.a.identity === a.identity) : -1;
      if (same >= 0) {
        if ((a.at ?? 0) > (cards[same].a.at ?? 0)) cards[same] = { a, machine: many ? env.name : undefined };
        continue;
      }
      cards.push({ a, machine: many ? env.name : undefined });
    }
  }
  const waiting = !cards.length && !empty.length && targets.some((e) => !reports[e.id] && !failed[e.id]);

  return (
    <>
      <div className="section">
        Limits left
        <span className="spacer" />
        <button className="usage-chip limit-check" disabled={checking} onClick={checkNow}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {waiting && <div className="empty quiet">reading limits…</div>}
      {cards.map(({ a, machine }) => <AccountCard key={`${machine ?? ''}${a.account}`} a={a} machine={machine} now={now} />)}
      {empty.length > 0 && <div className="limit-empty">No reading yet for {empty.join(', ')}. Use it once, or tap Check now.</div>}
      {Object.entries(failed).map(([id, msg]) => (
        <div key={id} className="limit-empty">{targets.find((e) => e.id === id)?.name}: couldn't read limits ({msg}){reports[id] ? ', showing the last answer' : ''}.</div>
      ))}
    </>
  );
}
