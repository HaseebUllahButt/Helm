import { useEffect, useMemo, useRef, useState } from 'react';
import type { Client, Environment, UsageReport, UsageGroup, UsageTotals } from './client';
import { hitRate, cacheSaved } from './client';
import { loadUsage, saveUsage, mergeReports, today, daysAgo } from './usageCache';
import { BackIcon, Icon } from './Icon';
import { EngineMark } from './EngineMark';
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

        {!loading && answered.length > 0 && (
          <section className="usage-where" aria-label="Where it went">
            <div className="usage-where-head">
              <h2 className="section">Where it went</h2>
              <Tabs label="Group by" items={FACETS} value={facet} onChange={setFacet} />
            </div>
            <Breakdown key={facet} groups={groups} facet={facet} onModel={setModel} />
          </section>
        )}

        <AccountLimits targets={targets} limits={limits}
          spend={answered.length ? planSpend(merged.groups, merged.accounts) : undefined} win={answered.length ? win : undefined} />

        {!loading && answered.length > 0 && <Provenance
          answered={answered.length}
          total={targets.length}
          stale={stale.length}
          failed={targets.filter((e) => failed[e.id]).map((e) => e.name)}
          unpriced={scoped.unpriced}
          rescanning={pending.size > 0}
          onRescan={() => targets.forEach((e) => fetchReport(e, true))}
        />}
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
      <p className="usage-limits-note">{targets.map(e => e.name).join(', ')}</p>
      {pending && <p role="status" className="usage-limits-note">Reading model history…</p>}
      {answered > 0 && <>
        <Headline totals={t} window={window} tiles={false} />
        {t.unpriced && <p className="usage-limits-note">Cost is incomplete: some usage has no published rate.</p>}
        <dl className="usage-token-detail">
          {([['Turns', t.turns], ['Fresh input', t.input], ['Output', t.output], ['Cache read', t.cacheRead], ['Cache write', t.cacheWrite], ['Reasoning', t.reasoning]] as const)
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

/** "7 days" as the end of a sentence: "last 7 days". */
const spanPhrase = (window: string) =>
  window === 'Today' ? 'today' : window === 'All' ? 'all time' : `last ${window}`;

/**
 * The one number the screen leads with, what it covers, and the three
 * figures behind it as small tiles: how much was read and written, how many
 * turns, and what the prompt cache took off.
 */
function Headline({ totals, window, tiles = true }: { totals: UsageTotals; window: string; tiles?: boolean }) {
  const rate = hitRate(totals);
  const saved = cacheSaved(totals);
  return (
    <div className="usage-hero">
      <div className="usage-hero-fig">{money(totals.costUsd)}</div>
      <div className="usage-hero-cap" title="Published rates × the tokens the CLIs recorded">
        At API prices · {spanPhrase(window)}
      </div>
      {tiles && <dl className="usage-stats">
        <div><dt>Tokens</dt><dd>{tokens(totals.total)}</dd></div>
        <div><dt>Turns</dt><dd>{totals.turns.toLocaleString()}</dd></div>
        {(totals.cacheRead > 0 || totals.input > 0) && (
          <div className="usage-cache" title={`${totals.cacheRead.toLocaleString()} cached · ${totals.input.toLocaleString()} fresh input tokens`}>
            <dt>Saved by cache</dt>
            <dd>{saved > 0 ? money(saved) : '$0'}</dd>
            <small>{cachePercent(rate)} cached</small>
          </div>
        )}
      </dl>}
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
 * One bar per slice, longest first. Bars, not a ring: lengths on a shared
 * start compare at a glance where ring slices do not. One hue, because the
 * row's name already says what it is; the engine's own mark sits beside a
 * model or CLI so Claude and Codex rows tell apart without reading. The
 * magnitude is cost; tokens are the fallback when nothing in the window
 * carried a published rate, because all-zero bars would pretend nothing
 * happened. Six rows, the rest one tap away.
 */
const SHOWN = 6;

function Breakdown({ groups, facet, onModel }: { groups: ChartGroup[]; facet: FacetId; onModel: (model: string) => void }) {
  const [all, setAll] = useState(false);
  const priced = groups.some((g) => g.costUsd > 0);
  const value = (g: ChartGroup) => (priced ? g.costUsd : g.total);
  const sorted = [...groups].sort((a, b) => value(b) - value(a)).filter((g) => value(g) > 0 || g.total > 0);
  const whole = sorted.reduce((s, g) => s + value(g), 0);
  if (!sorted.length) return <div className="empty quiet">nothing recorded yet</div>;

  const top = value(sorted[0]) || 1;
  const name = (g: ChartGroup) =>
    facet === 'project' ? shortFolder(g.project || '')
      : facet === 'machine' ? g.machine || 'unknown'
        : String((g as any)[facet] || 'unknown');
  // A model with no published rate still used tokens; say how many rather
  // than showing it as free.
  const amount = (g: ChartGroup) => (priced ? (g.unpriced && !g.costUsd ? `${tokens(g.total)} tokens` : money(g.costUsd)) : tokens(g.total));
  const share = (g: ChartGroup) => {
    const pct = whole > 0 ? (value(g) / whole) * 100 : 0;
    if (!pct) return '–';
    return pct >= 10 ? `${Math.round(pct)}%` : pct >= 0.1 ? `${pct.toFixed(1)}%` : '<0.1%';
  };
  const marked = facet === 'model' || facet === 'engine';
  const shown = all ? sorted : sorted.slice(0, SHOWN);
  const facetLabel = FACETS.find((f) => f.id === facet)!.label;

  return (
    <>
      <ul className="usage-shares" aria-label={`${facetLabel} share of ${priced ? 'cost' : 'tokens'}`}>
        {shown.map((g, i) => {
          const body = <>
            {marked && <EngineMark engine={g.engine} className="usage-share-mark" />}
            <span className="usage-share-name">{name(g)}</span>
            <span className="usage-share-value">{amount(g)}</span>
            <span className="usage-share-pct">{share(g)}</span>
            {facet === 'model' && <Icon name="forward" size={14} className="usage-share-go" />}
            <span className="usage-share-track" aria-hidden><span style={{ width: `${Math.max(0.6, (value(g) / top) * 100)}%` }} /></span>
          </>;
          // Two folders can shorten to the same display name, so the key
          // falls back to position, not text.
          const key = g.key ?? `${i}:${name(g)}`;
          return <li key={key} className={marked ? 'marked' : ''}>
            {facet === 'model'
              ? <button className="usage-share" aria-label={`${name(g)}, ${amount(g)}, ${share(g)}`} onClick={() => onModel(g.model ?? '')}>{body}</button>
              : <div className="usage-share">{body}</div>}
          </li>;
        })}
      </ul>
      {sorted.length > SHOWN && <button className="linkish usage-more" aria-expanded={all} onClick={() => setAll(!all)}>
        {all ? 'Show fewer' : `Show ${sorted.length - SHOWN} more`}
      </button>}
    </>
  );
}

/** How many machines the number covers, and the way to count it again. */
function Provenance({ answered, total, stale, failed, unpriced, rescanning, onRescan }: {
  answered: number; total: number; stale: number; failed: string[]; unpriced: boolean;
  rescanning: boolean; onRescan: () => void;
}) {
  return (
    <p className="usage-note">
      {`${answered} of ${total} machines reporting`}
      {stale > 0 ? `, ${stale} from memory` : ''}
      {failed.length > 0 ? ` · no answer from ${failed.join(', ')}` : ''}
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
