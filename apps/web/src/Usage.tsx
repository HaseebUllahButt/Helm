import { useEffect, useMemo, useState } from 'react';
import type { Client, Environment, UsageReport, UsageGroup, UsageTotals } from './client';
import { hitRate, cacheSaved } from './client';
import { loadUsage, saveUsage, mergeReports, today, daysAgo } from './usageCache';

/**
 * What the agents on this network have cost.
 *
 * Read from what each CLI already wrote, not from helm's own event log - that
 * is trimmed to the last couple of thousand events, so a long thread would
 * start forgetting what its early turns cost. The daemon pre-aggregates, so
 * what crosses the wire is day-by-model buckets rather than the gigabytes of
 * transcript behind them.
 *
 * One screen, two scopes: every machine summed, or one machine on its own.
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
  { id: 'machine', label: 'Machine' },
] as const;

type WindowId = typeof WINDOWS[number]['id'];
type FacetId = typeof FACETS[number]['id'];
/** The facets the daemon's own groups can fold onto; machine is a per-report fold. */
type GroupFacet = Exclude<FacetId, 'machine'>;

/** A group to chart: a daemon fold, or one machine's whole report. */
interface ChartGroup extends UsageGroup {
  machine?: string;
  /** Stable identity where the folded fields would not be. */
  key?: string;
}

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

export function UsageView({ client, envs, initialEnvId, onBack }: {
  client: Client;
  envs: Environment[];
  initialEnvId?: string;
  onBack: () => void;
}) {
  const [scope, setScope] = useState(initialEnvId ?? 'all');
  const [reports, setReports] = useState<Record<string, UsageReport>>({});
  const [remembered, setRemembered] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [win, setWin] = useState<WindowId>('7d');
  const [facet, setFacet] = useState<FacetId>('model');

  // A machine can leave the network while the screen scoped to it is open;
  // the select is controlled, so the scope falls back to every machine
  // rather than pointing at an option that no longer exists.
  useEffect(() => {
    if (scope !== 'all' && !envs.some((e) => e.id === scope)) setScope('all');
  }, [scope, envs]);
  const picked = scope === 'all' ? undefined : envs.find((e) => e.id === scope);
  const targets = picked ? [picked] : envs;

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
  }, [scope, envs.map((e) => e.id).join(','), win]);

  const answered = targets.filter((e) => reports[e.id]);
  const merged = useMemo(
    () => mergeReports(answered.map((e) => ({ env: e.id, report: reports[e.id] }))),
    [answered.map((e) => e.id).join(','), Object.values(reports)],
  );

  // The daemon applied the window, so totals, series and breakdown all
  // describe the same span. Nothing is re-filtered here.
  const scoped = merged.totals;
  const groups = useMemo<ChartGroup[]>(() => {
    // Machine is a fold the daemon's groups cannot answer: one slice per
    // reporting machine, from the totals each one sent.
    if (facet === 'machine') {
      return answered
        .map((e) => ({ ...reports[e.id].totals, machine: e.name, key: e.id }))
        .sort((a, b) => b.costUsd - a.costUsd);
    }
    return groupBy(merged.groups, facet);
  }, [merged, facet, answered.map((e) => e.id).join(','), Object.values(reports)]);
  const days = merged.daily;

  const stale = answered.filter((e) => remembered[e.id]);
  const loading = pending.size > 0 && answered.length === 0;

  return (
    <>
      <div className="bar">
        <button className="back" onClick={onBack}>‹</button>
        <b>Usage</b>
        {pending.size > 0 && answered.length > 0 && <span className="conn"><i />updating</span>}
      </div>

      <div className="scroll"><div className="pad">
        <label className="usage-scope">
          <span>Environment</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All machines</option>
            {envs.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
          </select>
        </label>

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
            <DonutBreakdown groups={groups} facet={facet} />

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
 * A share that is not exact must never round up to a whole: 99.96% cached is
 * not 100%, and a rounded "100%" would claim a rate the raw counts deny.
 */
const cachePercent = (rate: number) => {
  if (rate <= 0) return '0%';
  if (rate >= 1) return '100%';
  return `${Math.min(99.9, Math.round(rate * 1000) / 10).toFixed(1)}%`;
};

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
        <span className="usage-cache-pct">{cachePercent(rate)}</span>
        <span className="usage-cache-cap">of input served from cache</span>
        <span className="usage-cache-counts">
          {totals.cacheRead.toLocaleString()} cached · {totals.input.toLocaleString()} fresh
        </span>
      </div>
      <div className="usage-meter" role="img" aria-label={`${cachePercent(rate)} of input tokens served from cache`}>
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
 * One ring, one dimension. The magnitude is cost; tokens are the fallback
 * when nothing in the window carried a published rate, because an all-zero
 * ring would pretend nothing happened. Five named slices at most - past that
 * a slice is sliver, so the tail folds into Other. Colour only tells slices
 * apart: every legend row still carries a name, a value and a share, and the
 * palette stays on helm's own muted hues (the sixth, grey, always lands on
 * Other because Other is always the sixth slice).
 */
const SLICE_COLORS = [
  'var(--primary-t)', 'var(--sky)', 'var(--devin)',
  'var(--amber)', 'var(--opencode)', 'var(--mutedfg)',
];

function DonutBreakdown({ groups, facet }: { groups: ChartGroup[]; facet: FacetId }) {
  if (!groups.length) return <div className="empty quiet">nothing recorded yet</div>;
  const priced = groups.some((g) => g.costUsd > 0);
  const value = (g: ChartGroup) => (priced ? g.costUsd : g.total);
  const name = (g: ChartGroup) =>
    facet === 'project' ? shortFolder(g.project || '')
      : facet === 'machine' ? g.machine || 'unknown'
        : String((g as any)[facet] || 'unknown');

  const sorted = [...groups].sort((a, b) => value(b) - value(a));
  const slices = sorted.slice(0, 5).map((g, i) => ({
    // Two folders can shorten to the same display name, so the key falls
    // back to position, not text.
    key: g.key ?? `${i}`,
    name: name(g),
    value: value(g),
  }));
  const rest = sorted.slice(5);
  if (rest.length) {
    slices.push({ key: 'other', name: 'Other', value: rest.reduce((s, g) => s + value(g), 0) });
  }
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <div className="empty quiet">nothing recorded yet</div>;

  const fmt = priced ? money : tokens;
  const share = (v: number) => (v / total) * 100;
  const facetLabel = FACETS.find((f) => f.id === facet)!.label;
  const aria = `${facetLabel} share of ${priced ? 'cost' : 'tokens'}: `
    + slices.map((s) => `${s.name} ${share(s.value).toFixed(1)}%`).join(', ');

  let cumulative = 0;
  return (
    <div className="card usage-donut-card">
      <div className="usage-donut-layout">
        <div className="usage-donut">
          <svg className="usage-donut-ring" viewBox="0 0 42 42" role="img" aria-label={aria}>
            <g transform="rotate(-90 21 21)">
              {slices.map((s, i) => {
                const pct = share(s.value);
                const offset = cumulative;
                cumulative += pct;
                // pathLength=100 makes dasharray speak in percent; the 0.8
                // shaved off each slice is the gap between neighbours.
                return (
                  <circle
                    key={s.key} cx="21" cy="21" r="15.9155" fill="none"
                    stroke={SLICE_COLORS[i]} strokeWidth="5" pathLength={100}
                    strokeDasharray={`${Math.max(0, pct - 0.8)} ${100 - Math.max(0, pct - 0.8)}`}
                    strokeDashoffset={-offset}
                  />
                );
              })}
            </g>
          </svg>
          <div className="usage-donut-center">
            <span className="usage-donut-total">{fmt(total)}</span>
            <span className="usage-donut-unit">{priced ? 'total cost' : 'total tokens'}</span>
          </div>
        </div>
        <ul className="usage-legend">
          {slices.map((s, i) => (
            <li className="usage-legend-row" key={s.key}>
              <span className="usage-legend-dot" style={{ background: SLICE_COLORS[i] }} />
              <span className="usage-legend-name">{s.name}</span>
              <span className="usage-legend-value">{fmt(s.value)}</span>
              <span className="usage-legend-share">{share(s.value).toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      </div>
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
function groupBy(groups: UsageGroup[], facet: GroupFacet): UsageGroup[] {
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
