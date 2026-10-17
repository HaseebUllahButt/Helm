import { useEffect, useState } from 'react';
import type { Account } from '../accounts';
import { newsLines } from '../session/Controls';
import { BackIcon, Icon } from '../Icon';
import { Client, type Environment, type ModelList, type ModelNote } from '../client';
import { loadModels, saveModels } from '../modelCache';
import { followModelRefresh } from '../modelRefresh';
import { engineOf } from '../engines';

/**
 * The model prefs editor for one account: a checklist over the CLI's full
 * list - long for opencode, so it filters - plus the model new sessions
 * start with. Checking nothing means "offer everything", the state the
 * account was in before this screen existed.
 */
export function ModelPrefsView({ client, env, account, onBack }: {
  client: Client; env: Environment; account: Account; onBack: () => void;
}) {
  const [list, setList] = useState<ModelList | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [def, setDef] = useState('');
  // On unless the owner switched it off; an older machine says nothing, and acts as on.
  const [auto, setAuto] = useState(true);
  const [news, setNews] = useState<ModelNote[]>([]);
  const [effort, setEffort] = useState(account.defaults?.effort ?? '');
  const [mode, setMode] = useState(account.defaults?.mode === 'plan' ? '' : account.defaults?.mode ?? '');
  const [speed, setSpeed] = useState(account.defaults?.speed ?? '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eng = engineOf(account.engine);

  useEffect(() => {
    let stale = false;
    let initialized = false;
    const take = (r: ModelList, remembered?: boolean) => {
      if (stale) return;
      setList(r);
      if (!initialized) {
        setApproved(new Set(r.prefs?.approved ?? []));
        setDef(r.prefs?.default ?? '');
        setAuto(r.auto !== false);
        setNews(r.news ?? []);
      }
      if (!remembered) initialized = true;
      if (!remembered) saveModels(env.id, account.profile.id, r, true);
    };
    // Paint the catalogue this device already knows - the whole list, which is
    // the slowest thing the app asks for - and let the real answer replace it.
    loadModels(env.id, account.profile.id, true).then((c) => { if (c && !initialized) take(c, true); });
    const catalog = followModelRefresh(
      () => client.rpc<ModelList>(env.id, 'model.list', { profileId: account.profile.id, all: true }, 45_000),
      (r) => take(r),
      (e) => { if (!list) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { stale = true; catalog.stop(); };
  }, [client, env.id, account.profile.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (m: string) => {
    const next = new Set(approved);
    if (next.has(m)) next.delete(m); else next.add(m);
    // A default has to be something the picker offers - unless the picker
    // offers everything, which is what an empty list means.
    if (def && next.size && !next.has(def)) setDef('');
    setApproved(next);
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      await Promise.all([
        client.rpc(env.id, 'model.prefs', {
          profileId: account.profile.id,
          default: def || null,
          approved: [...approved],
          auto,
        }, 20_000),
        client.rpc(env.id, 'profile.defaults', {
          profileId: account.profile.id,
          effort: efforts.includes(effort) ? effort : null,
          mode: mode || null,
          speed: speed || null,
        }, 20_000),
      ]);
      onBack();
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  const all = list?.models ?? [];
  const q = query.trim().toLowerCase();
  const match = (m: string) =>
    !q || m.toLowerCase().includes(q) || (list?.labels?.[m] ?? '').toLowerCase().includes(q);
  // Approved first in the CLI's own order, including any the CLI no longer
  // offers (kept visible so a stale entry can be unchecked, not hidden).
  const on = [...all.filter((m) => approved.has(m)), ...[...approved].filter((m) => !all.includes(m))]
    .filter(match);
  const off = all.filter((m) => !approved.has(m)).filter(match);
  // Approving nothing leaves the picker whole, so the default may be any
  // model the CLI offers: "start me on the big one" is a setting on its own,
  // and the daemon stores it as one.
  const defaults = approved.size ? all.filter((m) => approved.has(m)) : [...all];
  // A stored default the CLI stopped offering is still what sessions start
  // with - keep it selectable rather than silently dropping it.
  if (def && !defaults.includes(def)) defaults.push(def);
  const selectedModel = def || list?.default || list?.models?.[0] || '';
  const efforts = list?.effortsByModel?.[selectedModel] ?? list?.efforts ?? [];
  useEffect(() => {
    if (list && effort && !efforts.includes(effort)) setEffort('');
  }, [list, selectedModel, effort]);
  const speeds = [...new Set([
    ...(list?.speedByModel?.[selectedModel] ?? list?.speeds ?? []),
    ...(speed ? [speed] : []),
  ])];
  const modes = (list?.modes ?? []).filter((m) => m.id !== 'plan');
  if (mode && mode !== 'plan' && !modes.some((m) => m.id === mode)) modes.push({ id: mode, label: mode });

  const row = (m: string, checked: boolean) => (
    <button key={m} className={`row tall${checked ? ' active' : ''}`} onClick={() => toggle(m)}>
      <span className="grow">
        <span className="rt"><span className="rt-text">{list?.labels?.[m] ?? m}</span></span>
        {(list?.labels?.[m] && list.labels[m] !== m) && <span className="rm">{m}</span>}
        {!all.includes(m) && <span className="rm">not offered by the CLI anymore</span>}
      </span>
      {checked && <span className="check"><Icon name="check" size={16} /></span>}
    </button>
  );

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>CLI defaults</h1><span className="sub">{eng.label} · {account.account} · {env.name}</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        {list === null && !error && <div className="empty quiet">asking the CLI for its models…</div>}

        {list !== null && (
          <>
            {news.length > 0 && (
              <div className="model-news" role="status">
                <span className="grow">{newsLines(news).map((l) => <span key={l}>{l}</span>)}</span>
                <button onClick={() => {
                  setNews([]);
                  client.rpc(env.id, 'model.news', { profileId: account.profile.id }, 15_000).catch(() => { /* shows once more */ });
                }}>OK</button>
              </div>
            )}
            <div className="section">start new sessions with</div>
            <select value={def} onChange={(e) => setDef(e.target.value)} disabled={!defaults.length}>
              <option value="">the CLI's default</option>
              {defaults.map((m) => <option key={m} value={m}>{list.labels?.[m] ?? m}</option>)}
            </select>
            {efforts.length > 0 && (
              <label className="field-label">Thinking
                <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">the CLI's default</option>
                  {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
            )}
            {modes.length > 0 && (
              <label className="field-label">Permissions
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="">YOLO (default)</option>
                  {modes.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </select>
              </label>
            )}
            {speeds.length > 0 && (
              <label className="field-label">Speed
                <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
                  <option value="">normal</option>
                  {speeds.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
            )}

            <div className="section">in the picker</div>
            <input
              value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={`filter ${all.length} models`} autoCapitalize="off" autoCorrect="off"
            />
            {on.length > 0 && <div className="rows">{on.map((m) => row(m, true))}</div>}
            {on.length > 0 && off.length > 0 && <div className="section">everything else</div>}
            <div className="rows">{off.map((m) => row(m, false))}</div>
            {q && !on.length && !off.length && <div className="empty quiet">no matches</div>}

            <div className="section">new models</div>
            <div className="rows">
              <button className="row tall toggle" role="switch" aria-checked={auto} onClick={() => setAuto(!auto)}>
                <span className="grow">
                  <span className="rt">Add new models automatically</span>
                  <span className="rm wrap">A new release joins the short list. If your default was the newest of its kind, it moves up too.</span>
                </span>
                <span className={`switch${auto ? ' on' : ''}`}><i /></span>
              </button>
            </div>

            <p className="note">
              Checked models are the picker's short list; the rest stay reachable
              under “more”. Check nothing to offer the whole list.
            </p>
            <button className="primary big" disabled={busy} onClick={save}>
              {busy ? 'saving…' : 'Save'}
            </button>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}
