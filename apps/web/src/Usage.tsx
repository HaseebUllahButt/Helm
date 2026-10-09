import { useEffect, useMemo, useRef, useState } from 'react';
import type { Client, Environment, UsageReport, UsageGroup, UsageTotals } from './client';
import { hitRate, cacheSaved } from './client';
import { loadUsage, saveUsage, mergeReports, today, daysAgo } from './usageCache';
import { BackIcon } from './Icon';
import { AccountLimits, useAccountLimits } from './AccountLimits';
import type { PlanSpend } from './AccountLimits';
import { Sheet } from './Modal';

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
  const [model, setModel] = useState<string | null>(null);
  const generation = useRef(0);
  const received = useRef(new Set<string>());

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
    const request = generation.current;
    setPending((p) => new Set(p).add(env.id));
    client.usage(env.id, { since: since || undefined, by: ['engine', 'account', 'model', 'provider', 'project'], rebuild })
      .then((report) => {
        if (request !== generation.current) return;
        received.current.add(env.id);
        setFailed((f) => { const { [env.id]: _gone, ...rest } = f; return rest; });
        if (report.stale) {
          // The hub answered for a machine that is asleep - a memory too,
          // and possibly an older one than this device already holds. A
          // memory must never walk the number backwards.
          setReports((r) => {
            const cur = r[env.id];
            return cur && (cur.at || 0) > (report.at || 0) ? r : { ...r, [env.id]: report };
          });
          setRemembered((r) => ({ ...r, [env.id]: Math.max(report.at || 0, r[env.id] || 0) }));
          return;
        }
        setReports((r) => ({ ...r, [env.id]: report }));
        setRemembered((r) => { const { [env.id]: _drop, ...rest } = r; return rest; });
        saveUsage(env.id, report, win, since);
      })
      .catch((e) => { if (request === generation.current) setFailed((f) => ({ ...f, [env.id]: String(e?.message || e) })); })
      .finally(() => { if (request === generation.current) setPending((p) => { const n = new Set(p); n.delete(env.id); return n; }); });
  };

  useEffect(() => {
    let live = true;
    generation.current++;
    received.current = new Set();
    setReports({}); setRemembered({}); setFailed({}); setPending(new Set()); setModel(null);
    for (const env of targets) {
      loadUsage(env.id, win, since).then((hit) => {
        if (!live || !hit || received.current.has(env.id)) return;
        setReports((r) => (r[env.id] ? r : { ...r, [env.id]: hit.report }));
        setRemembered((r) => ({ ...r, [env.id]: hit.at }));
      });
      fetchReport(env, false);
    }
    return () => { live = false; generation.current++; };
  }, [client, scope, envs.map((e) => e.id).join(','), win, since]);

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
  const limits = useAccountLimits(client, targets);

  const stale = answered.filter((e) => remembered[e.id]);
  const loading = pending.size > 0 && answered.length === 0;

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <b>Usage</b>
        {pending.size > 0 && answered.length > 0 && <span className="conn"><i />updating</span>}
      </div>

      <div className="scroll"><div className="pad usage">
        <div className="usage-controls">
          <select aria-label="Environment" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All machines</option>
            {envs.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
          </select>
          <Tabs label="Period" items={WINDOWS} value={win} onChange={setWin} />
        </div>

        {loading && <div className="empty quiet">reading what the CLIs recorded…</div>}

        {!loading && answered.length === 0 && <div className="empty quiet">
          <p>{targets.length ? 'Usage unavailable. No machine has returned a report.' : 'No machines to report usage.'}</p>
          {!!targets.length && <button className="linkish" onClick={() => targets.forEach(e => fetchReport(e, false))}>Retry usage</button>}
        </div>}
        {!loading && answered.length > 0 && <Headline totals={scoped} window={WINDOWS.find((w) => w.id === win)!.label} />}

        <AccountLimits targets={targets} limits={limits}
          spend={answered.length ? planSpend(merged.groups, merged.accounts) : undefined} win={answered.length ? win : undefined} />

        {!loading && answered.length > 0 && (
          <section className="usage-where" aria-label="Where it went">
            <div className="usage-where-head">
              <h2 className="usage-h">Where it went</h2>
              <Tabs label="Group by" items={FACETS} value={facet} onChange={setFacet} />
            </div>
            <DonutBreakdown groups={groups} facet={facet} onModel={setModel} />
            {Object.keys(failed).length > 0 && <p className="usage-limits-note">Usage unavailable from {targets.filter(e => failed[e.id]).map(e => e.name).join(', ')}. Try Rescan below.</p>}
            <Provenance
              answered={answered.length}
              total={targets.length}
              stale={stale.length}
              unpriced={scoped.unpriced}
              rescanning={pending.size > 0}
              onRescan={() => targets.forEach((e) => fetchReport(e, true))}
            />
          </section>
        )}
      </div></div>
      {model !== null && <ModelDetail key={`${scope}:${win}:${model}`} client={client} targets={targets} model={model} since={since}
        window={WINDOWS.find(w => w.id === win)!.label} onClose={() => setModel(null)} />}
    </>
  );
}

function ModelDetail({ client, targets, model, since, window, onClose }: {
  client: Client; targets: Environment[]; model: string; since: string; window: string; onClose: () => void;
}) {
  const [reports, setReports] = useState<Record<string, UsageReport>>({});
  const [done, setDone] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    for (const env of targets) {
      client.usage(env.id, { model, since: since || undefined, by: ['model'] }).then(report => {
        // Older daemons ignore unknown filters. Never show their whole bill
        // as this model's history.
        if (report.groups.some(g => g.model !== model) || (!report.groups.length && report.totals.total > 0)) return;
        if (live) setReports(r => ({ ...r, [env.id]: report }));
      }).catch(() => {}).finally(() => { if (live) setDone(d => [...d, env.id]); });
    }
    return () => { live = false; };
  }, [client, model, since, targets.map(e => e.id).join(',')]);
  const merged = mergeReports(Object.entries(reports).map(([env, report]) => ({ env, report })));
  const t = merged.totals;
  const answered = Object.keys(reports).length;
  const pending = done.length < targets.length;
  return <Sheet label={`${model || 'Unknown model'} usage`} onClose={onClose}>
    <div className="usage-model-detail">
      <div className="modal-head"><div className="modal-title">{model || 'Unknown model'}</div><button className="ghost" onClick={onClose}>Close</button></div>
      <p className="usage-limits-note">{window} · {targets.map(e => e.name).join(', ')}</p>
      {pending && <p role="status" className="usage-limits-note">Reading model history…</p>}
      {answered > 0 && <>
        <Headline totals={t} window={window} />
        {t.unpriced && <p className="usage-limits-note">Cost is incomplete: some usage has no published rate.</p>}
        <dl className="usage-token-detail">
          {([['Fresh input', t.input], ['Output', t.output], ['Cache read', t.cacheRead], ['Cache write', t.cacheWrite], ['Reasoning', t.reasoning]] as const)
            .map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count.toLocaleString()}</dd></div>)}
        </dl>
        <p className="usage-limits-note">Reasoning is included in output where the provider reports it.</p>
      </>}
      {!pending && answered === 0 && <p className="usage-limits-note">Model history unavailable. The machines may be offline or need an update.</p>}
      <p className="usage-limits-note">{answered} of {targets.length} machines reporting{Object.values(reports).some(r => r.stale) ? ' · includes remembered usage' : ''}.</p>
    </div>
  </Sheet>;
}

/** The app's segmented control: one choice of a few, the chosen one lit. */
function Tabs<T extends string>({ label, items, value, onChange }: {
  label: string; items: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void;
}) {
  return <div className="segmented usage-tabs" role="group" aria-label={label}>
    {items.map((item) => <button key={item.id} className={item.id === value ? 'on' : ''} aria-pressed={item.id === value}
      onClick={() => onChange(item.id)}>{item.label}</button>)}
  </div>;
}

/**
 * The one number the screen leads with, what it covers, and what the prompt
 * cache did to it - one block, no card.
 */
function Headline({ totals, window }: { totals: UsageTotals; window: string }) {
  return (
    <div className="usage-hero">
      <div className="usage-hero-fig">{money(totals.costUsd)}</div>
      <div className="usage-hero-cap" title="Published rates × the tokens the CLIs recorded">
        API-equivalent, {window.toLowerCase()} · {tokens(totals.total)} tokens · {totals.turns.toLocaleString()} turns
      </div>
      <CacheLine totals={totals} />
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

/** The prompt cache in one sentence; the raw counts are on hover. */
function CacheLine({ totals }: { totals: UsageTotals }) {
  const rate = hitRate(totals);
  const saved = cacheSaved(totals);
  if (!totals.cacheRead && !totals.input) return null;
  return (
    <p className="usage-cache" title={`${totals.cacheRead.toLocaleString()} cached · ${totals.input.toLocaleString()} fresh input tokens`}>
      {cachePercent(rate)} of input came from cache
      {saved > 0 ? <>, saving <b>{money(saved)}</b> after the cache-write premium.</> : '.'}
    </p>
  );
}

/**
 * API-equivalent spend per login home, summed across machines that share it,
 * for the account rows to set beside each allowance. Usage is counted per
 * login home, so several logins sharing one config folder are one line here.
 */
const PLAN_ENGINES = new Set(['claude', 'codex']);
/** "/home/me/.claude" and "~/.claude" name the same account. */
const tilde = (p: string) => p.replace(/^\/(home|Users)\/[^/|]+/, '~');

function planSpend(groups: ChartGroup[], accounts: UsageReport['accounts']): PlanSpend[] {
  const spend = new Map<string, PlanSpend>();
  const at = (engine: string, account: string, profileId: string) => {
    const key = `${engine}|${tilde(account.split('|')[1] ?? '')}`;
    if (!spend.has(key)) spend.set(key, { key, engine, profileId, costUsd: 0, unpriced: false });
    return spend.get(key)!;
  };
  for (const a of accounts) if (PLAN_ENGINES.has(a.engine)) at(a.engine, a.account, a.profileId);
  for (const g of groups) {
    if (!g.account || !g.engine || !PLAN_ENGINES.has(g.engine)) continue;
    const cur = at(g.engine, g.account, '');
    cur.costUsd += g.costUsd || 0;
    if (g.unpriced) cur.unpriced = true;
  }
  return [...spend.values()].sort((a, b) => b.costUsd - a.costUsd);
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

function DonutBreakdown({ groups, facet, onModel }: { groups: ChartGroup[]; facet: FacetId; onModel: (model: string) => void }) {
  if (!groups.length) return <div className="empty quiet">nothing recorded yet</div>;
  const priced = groups.some((g) => g.costUsd > 0);
  const value = (g: ChartGroup) => (priced ? g.costUsd : g.total);
  const name = (g: ChartGroup) =>
    facet === 'project' ? shortFolder(g.project || '')
      : facet === 'machine' ? g.machine || 'unknown'
        : String((g as any)[facet] || 'unknown');

  const sorted = [...groups].sort((a, b) => value(b) - value(a));
  const whole = sorted.reduce((s, g) => s + value(g), 0);
  // The few that matter get a row each; anything under 1% of the total is
  // folded into one "Other", which is left out when it comes to nothing.
  const big = sorted.filter((g, i) => i < 5 && whole > 0 && value(g) / whole >= 0.01);
  const slices = big.map((g, i) => ({
    // Two folders can shorten to the same display name, so the key falls
    // back to position, not text.
    key: g.key ?? `${i}`,
    name: name(g),
    value: value(g),
  }));
  const restValue = sorted.slice(big.length).reduce((s, g) => s + value(g), 0);
  if (restValue > 0 && (priced ? restValue >= 0.005 : restValue / whole >= 0.001)) {
    slices.push({ key: 'other', name: 'Other', value: restValue });
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
    <div className="usage-donut-card">
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
        </div>
        <ul className="usage-legend">
          {slices.map((s, i) => (
            <li className="usage-legend-row" key={s.key}>
              <span className="usage-legend-dot" style={{ background: SLICE_COLORS[i] }} />
              {facet === 'model' && s.key !== 'other'
                ? <button className="linkish usage-legend-name usage-model-link" onClick={() => onModel(big[i].model ?? '')}>{s.name}</button>
                : <span className="usage-legend-name">{s.name}</span>}
              <span className="usage-legend-value">{fmt(s.value)}</span>
              <span className="usage-legend-share">{share(s.value).toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      </div>
      {facet === 'model' && sorted.length > big.length && <details className="usage-more-models">
        <summary>More models ({sorted.length - big.length})</summary>
        {sorted.slice(big.length).map(g => <button key={g.model ?? ''} className="linkish usage-model-extra" onClick={() => onModel(g.model ?? '')}>
          <span>{g.model || 'unknown'}</span><span>{g.unpriced && !g.costUsd ? `${tokens(g.total)} tokens` : fmt(value(g))}</span>
        </button>)}
      </details>}
    </div>
  );
}

/** How many machines the number covers, and the way to count it again. */
function Provenance({ answered, total, stale, unpriced, rescanning, onRescan }: {
  answered: number; total: number; stale: number; unpriced: boolean;
  rescanning: boolean; onRescan: () => void;
}) {
  return (
    <p className="usage-note">
      {answered === total ? `${total} of ${total} machines reporting` : `${answered} of ${total} machines reporting`}
      {stale > 0 ? `, ${stale} from memory` : ''}
      {unpriced ? ' · some models have no published rate and count in tokens only' : ''}
      {' · '}
      {/* The daemon aggregates what it already read; a rescan re-reads the
          transcripts, so it is the answer to "that cannot be right" rather
          than a refresh button. */}
      <button className="linkish" disabled={rescanning} onClick={onRescan}>
        {rescanning ? 'Rescanning…' : 'Rescan'}
      </button>
    </p>
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
