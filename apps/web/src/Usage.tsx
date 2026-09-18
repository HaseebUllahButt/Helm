import { useEffect, useMemo, useState } from 'react';
import type { Client, Environment, UsageReport, UsageGroup, UsageTotals } from './client';
import { hitRate, cacheSaved } from './client';
import { loadUsage, saveUsage, mergeReports, today, daysAgo } from './usageCache';

/**
 * What the agents on this network have cost.
 *
 * Read from what each CLI already wrote, not from con's own event log - that
 * is trimmed to the last couple of thousand events, so a long thread would
 * start forgetting what its early turns cost. The daemon pre-aggregates, so
 * what crosses the wire is day-by-model buckets rather than the gigabytes of
 * transcript behind them.
 *
 * Two screens, one component: every machine summed, or one machine on its own.
 * The facets are the same either way, because the question ("where did it go?")
 * is the same.
 */

/** The windows a bill is actually read in. */
const WINDOWS = [
  { id: '1d', label: 'Today', from: () => today() },
  { id: '7d', label: '7 days', from: () => daysAgo(6) },
  { id: '30d', label: '30 days', from: () => daysAgo(29) },
  { id: 'all', label: 'All', from: () => '' },
] as const;

const FACETS = [
  { id: 'model', label: 'Model' },
  { id: 'engine', label: 'CLI' },
  { id: 'provider', label: 'Provider' },
  { id: 'project', label: 'Folder' },
] as const;

type WindowId = typeof WINDOWS[number]['id'];
type FacetId = typeof FACETS[number]['id'];

const money = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;

const tokens = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M`
    : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);

const shortFolder = (p: string) => {
  if (!p) return 'unknown';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts.slice(-2).join('/') || p;
};

export function UsageView({ client, envs, only, onBack, onPickEnv }: {
  client: Client;
  envs: Environment[];
  /** One machine, or undefined for every machine summed. */
  only?: Environment;
  onBack: () => void;
  onPickEnv?: (envId: string) => void;
}) {
  const targets = only ? [only] : envs;
  const [reports, setReports] = useState<Record<string, UsageReport>>({});
  const [remembered, setRemembered] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [win, setWin] = useState<WindowId>('7d');
  const [facet, setFacet] = useState<FacetId>('model');

  /**
   * Paint what we had, ask anyway, replace when the answer lands - the same
   * shape as the chat and model caches. The first call on a machine with a
   * long history reads every transcript its CLIs ever wrote; on a phone over
   * the hub that is not a wait anyone should watch.
   */
  const since = WINDOWS.find((w) => w.id === win)!.from();

  const fetchReport = (env: Environment, rebuild: boolean) => {
    setPending((p) => new Set(p).add(env.id));
    client.usage(env.id, { since: since || undefined, by: ['engine', 'model', 'provider', 'project'], rebuild })
      .then((report) => {
        setReports((r) => ({ ...r, [env.id]: report }));
        setRemembered((r) => { const { [env.id]: _drop, ...rest } = r; return rest; });
        setFailed((f) => { const { [env.id]: _gone, ...rest } = f; return rest; });
        saveUsage(env.id, report, win);
      })
      .catch((e) => setFailed((f) => ({ ...f, [env.id]: String(e?.message || e) })))
      .finally(() => setPending((p) => { const n = new Set(p); n.delete(env.id); return n; }));
  };

  useEffect(() => {
    let live = true;
    for (const env of targets) {
      loadUsage(env.id, win).then((hit) => {
        if (!live || !hit) return;
        setReports((r) => (r[env.id] ? r : { ...r, [env.id]: hit.report }));
        setRemembered((r) => ({ ...r, [env.id]: hit.at }));
      });
      fetchReport(env, false);
    }
    return () => { live = false; };
  }, [only?.id, envs.map((e) => e.id).join(','), win]);

  const answered = targets.filter((e) => reports[e.id]);
  const merged = useMemo(
    () => mergeReports(answered.map((e) => ({ env: e.id, report: reports[e.id] }))),
    [answered.map((e) => e.id).join(','), Object.values(reports)],
  );

  // The daemon applied the window, so totals, series and breakdown all
  // describe the same span. Nothing is re-filtered here.
  const scoped = merged.totals;
  const groups = useMemo(() => groupBy(merged.groups, facet), [merged, facet]);
  const days = merged.daily;

  const stale = answered.filter((e) => remembered[e.id]);
  const loading = pending.size > 0 && answered.length === 0;

  return (
    <>
      <div className="bar">
        <button className="back" onClick={onBack}>‹</button>
        <b>{only ? only.name : 'Usage'}</b>
        {pending.size > 0 && answered.length > 0 && <span className="conn"><i />updating</span>}
      </div>

      <div className="scroll"><div className="pad">
        {loading && <div className="empty quiet">reading what the CLIs recorded…</div>}

        {!loading && (
          <>
            <div className="filterbar usage-filters">
              {WINDOWS.map((w) => (
                <button key={w.id} className={`usage-chip${w.id === win ? ' on' : ''}`} onClick={() => setWin(w.id)}>
                  {w.label}
                </button>
              ))}
            </div>

            <Headline totals={scoped} window={WINDOWS.find((w) => w.id === win)!.label} />
            <CacheCard totals={scoped} />
            <Spend days={days} />

            <div className="section">where it went</div>
            <div className="filterbar usage-filters">
              {FACETS.map((f) => (
                <button key={f.id} className={`usage-chip${f.id === facet ? ' on' : ''}`} onClick={() => setFacet(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>
            <Breakdown groups={groups} facet={facet} />

            {!only && (
              <>
                <div className="section">machines</div>
                <div className="rows">
                  {targets.map((e) => {
                    const r = reports[e.id];
                    return (
                      <button key={e.id} className="row" onClick={() => onPickEnv?.(e.id)}>
                        <span className={`mdot ${e.online ? 'on' : 'off'}`} />
                        <span className="grow">
                          <span className="rt">{e.name}</span>
                          <span className="rm">
                            {r ? `${money(r.totals.costUsd)} · ${tokens(r.totals.total)} tokens`
                              : failed[e.id] ? 'could not be read'
                                : pending.has(e.id) ? 'reading…' : 'no answer yet'}
                          </span>
                        </span>
                        <span className="chev">›</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            <Provenance
              answered={answered.length}
              total={targets.length}
              stale={stale.length}
              unpriced={scoped.unpriced}
              rescanning={pending.size > 0}
              onRescan={() => targets.forEach((e) => fetchReport(e, true))}
            />
          </>
        )}
      </div></div>
    </>
  );
}

/**
 * The one number the screen leads with, and the three that give it scale.
 * Exactly one hero per view; the tiles beside it are not competing heroes.
 */
function Headline({ totals, window }: { totals: UsageTotals; window: string }) {
  return (
    <div className="card usage-hero">
      <div className="usage-hero-fig">{money(totals.costUsd)}</div>
      <div className="usage-hero-cap">
        API-equivalent, {window.toLowerCase()} · {tokens(totals.total)} tokens · {totals.turns.toLocaleString()} turns
      </div>
    </div>
  );
}

/**
 * The prompt cache, as a ratio against its limit: a meter, not a chart. The
 * fill and the track are steps of one hue so the state reads across the bar.
 */
function CacheCard({ totals }: { totals: UsageTotals }) {
  const rate = hitRate(totals);
  const saved = cacheSaved(totals);
  if (!totals.cacheRead && !totals.input) return null;
  return (
    <div className="card usage-cache">
      <div className="usage-cache-top">
        <span className="usage-cache-pct">{(rate * 100).toFixed(1)}%</span>
        <span className="usage-cache-cap">of input served from cache</span>
      </div>
      <div className="usage-meter" role="img" aria-label={`${(rate * 100).toFixed(0)} percent of input tokens served from cache`}>
        <span style={{ width: `${Math.min(100, rate * 100)}%` }} />
      </div>
      <div className="usage-cache-note">
        {saved > 0
          ? <>Saved <b>{money(saved)}</b> against the fresh-input rate, after the cache-write premium.</>
          : <>Not enough priced traffic yet to say what caching saved.</>}
      </div>
    </div>
  );
}

/**
 * Spend per day: one series, so one colour and no legend - the heading says
 * what is plotted. Bars are capped and carry a 2px surface gap, and only the
 * peak is labelled; every other value lives in the tooltip.
 */
function Spend({ days }: { days: { date: string; costUsd: number; total: number }[] }) {
  if (days.length < 2) return null;
  const peak = Math.max(...days.map((d) => d.costUsd), 0);
  if (peak <= 0) return null;
  const peakDay = days.find((d) => d.costUsd === peak);
  return (
    <div className="card usage-spend">
      <div className="usage-spend-head">
        <span className="usage-spend-title">Cost per day</span>
        <span className="usage-spend-peak">peak {money(peak)}</span>
      </div>
      <div className="usage-bars">
        {days.map((d) => (
          <span
            key={d.date}
            className={`usage-bar${d === peakDay ? ' peak' : ''}`}
            style={{ height: `${Math.max(2, (d.costUsd / peak) * 100)}%` }}
            title={`${d.date} · ${money(d.costUsd)} · ${tokens(d.total)} tokens`}
          />
        ))}
      </div>
      <div className="usage-axis">
        <span>{days[0].date.slice(5)}</span>
        <span>{days[days.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}

/**
 * Magnitude, low to high: length carries the comparison, so every row is the
 * same colour. The engine dot beside the name is identity, and it sits next to
 * a text label rather than standing in for one.
 */
function Breakdown({ groups, facet }: { groups: UsageGroup[]; facet: FacetId }) {
  if (!groups.length) return <div className="empty quiet">nothing recorded yet</div>;
  const peak = Math.max(...groups.map((g) => g.costUsd), 0);
  const shown = groups.slice(0, 12);
  return (
    <div className="rows usage-breakdown">
      {shown.map((g) => {
        const name = facet === 'project' ? shortFolder(g.project || '') : (g as any)[facet] || 'unknown';
        return (
          <div key={name + (g.engine ?? '')} className="usage-brow">
            <div className="usage-brow-top">
              <span className="usage-brow-name">
                {g.engine && <i className={`edot ${g.engine}`} aria-hidden="true" />}
                {name}
              </span>
              <span className="usage-brow-cost">{money(g.costUsd)}</span>
            </div>
            <div className="usage-brow-track">
              <span style={{ width: `${peak > 0 ? Math.max(1, (g.costUsd / peak) * 100) : 0}%` }} />
            </div>
            <div className="usage-brow-meta">
              {tokens(g.total)} tokens · {(hitRate(g) * 100).toFixed(0)}% cached
              {g.unpriced ? ' · unpriced' : ''}
            </div>
          </div>
        );
      })}
      {groups.length > shown.length && (
        <div className="quiet usage-more">+{groups.length - shown.length} more</div>
      )}
    </div>
  );
}

/** What the number on screen is, and is not - plus the way to count it again. */
function Provenance({ answered, total, stale, unpriced, rescanning, onRescan }: {
  answered: number; total: number; stale: number; unpriced: boolean;
  rescanning: boolean; onRescan: () => void;
}) {
  return (
    <div className="diag usage-note">
      <span>
        {answered === total
          ? `${total} of ${total} machines reporting`
          : `${answered} of ${total} machines reporting — the rest are not answering`}
        {stale > 0 ? `, ${stale} from memory` : ''}
      </span>
      <span>
        costs are published rates × real tokens
        {unpriced ? ' · some models have no published rate and are counted in tokens only' : ''}
      </span>
      {/* The daemon aggregates what it already read; a rescan re-reads the
          transcripts, so it is the answer to "that cannot be right" rather
          than a refresh button. */}
      <button className="linkish" disabled={rescanning} onClick={onRescan}>
        {rescanning ? 'rescanning…' : 'rescan the transcripts'}
      </button>
    </div>
  );
}

/** Fold the daemon's groups down to one dimension. */
function groupBy(groups: UsageGroup[], facet: FacetId): UsageGroup[] {
  const out = new Map<string, UsageGroup>();
  for (const g of groups) {
    const k = String((g as any)[facet] ?? '');
    const cur = out.get(k);
    if (!cur) { out.set(k, { ...g }); continue; }
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'turns',
      'costUsd', 'cacheSavedUsd', 'cacheWritePremiumUsd'] as const) {
      (cur as any)[f] += (g as any)[f] || 0;
    }
    if (g.unpriced) cur.unpriced = true;
    // Once a fold spans engines, the dot would be a lie about which one.
    if (cur.engine !== g.engine) cur.engine = undefined;
  }
  return [...out.values()].sort((a, b) => b.costUsd - a.costUsd);
}
