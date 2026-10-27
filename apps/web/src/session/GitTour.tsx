import { useEffect, useRef, useState } from 'react';
import type { Client, Environment } from '../client';
import { errorMessage } from '../errors';
import { DiffView } from './CodeView';

export type TourTarget = { scope: 'edits' | 'branch' | 'commit'; hash?: string };
type Stop = { title: string; summary: string; path: string; start: number; end: number; side: string; diff: string; decision: string };
type Tour = { state: 'none' | 'writing' | 'ready' | 'failed' | 'stopped'; old?: boolean; error?: string; helperId?: string;
  change?: { label: string; commit: string; files: { path: string }[] };
  guide?: { stops: Stop[]; alsoChanged: { path: string; note: string }[] } };

export function GitTour({ client, env, cwd, sessionId, target, wrap, onClose }: {
  client: Client; env: Environment; cwd: string; sessionId: string; target: TourTarget; wrap: boolean; onClose: () => void;
}) {
  const stopped = useRef(false);
  const [tour, setTour] = useState<Tour | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState(0);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    stopped.current = false;
    setTour(null); setError(''); setPosition(0);
    const load = async (action: string) => {
      try {
        const result = await client.rpc<Tour>(env.id, 'git.tour', { cwd, sessionId, ...target, action }, 90_000);
        if (disposed || stopped.current) return;
        if (result.state === 'none') { void load('start'); return; }
        setTour(result);
        if (result.state === 'writing') timer = setTimeout(() => void load('get'), 1000);
      } catch (e) { if (!disposed) setError(errorMessage(e, { fallback: 'Helm cannot open this tour.' })); }
    };
    void load(attempt ? 'start' : 'get');
    return () => { disposed = true; clearTimeout(timer); };
  }, [client, env.id, cwd, sessionId, target.scope, target.hash, attempt]);

  const stop = async () => {
    stopped.current = true;
    setBusy(true); setError('');
    try { setTour(await client.rpc<Tour>(env.id, 'git.tour', { cwd, sessionId, ...target, action: 'stop' }, 30_000)); }
    catch (e) { setError(errorMessage(e, { fallback: 'Helm cannot stop the helper.' })); }
    finally { setBusy(false); }
  };
  const stops = tour?.guide?.stops ?? [];
  const current = stops[position];
  return <section className="git-tour" aria-label="Change tour">
    <header className="tour-header">
      <div><h2>Tour</h2><p>{tour?.change?.label ?? (target.scope === 'edits' ? 'Uncommitted edits' : target.scope === 'branch' ? 'Branch compared with main' : `Commit ${target.hash?.slice(0, 7)}`)}</p></div>
      <button className="ghost" onClick={onClose}>Close tour</button>
    </header>
    {tour?.old && <div className="tour-old" role="status">This tour is old. The change or the current commit is different.</div>}
    {error && <p className="error" role="alert">{error}</p>}
    {!tour && !error && <p role="status">Opening tour…</p>}
    {tour?.state === 'writing' && <div className="tour-writing" role="status"><span>The helper is writing the tour…</span>
      <button className="ghost" disabled={busy} onClick={() => void stop()}>{busy ? 'Stopping…' : 'Stop writing'}</button></div>}
    {(error || tour?.state === 'failed' || tour?.state === 'stopped' || (tour?.old && target.scope !== 'commit')) && <div className="tour-writing">
      <span>{tour?.state === 'failed' ? tour.error : tour?.state === 'stopped' ? 'The tour stopped.' : ''}</span>
      <button className="ghost" onClick={() => setAttempt(n => n + 1)}>{tour?.old ? 'Write a new tour' : 'Try again'}</button>
    </div>}
    {tour?.state === 'ready' && <>
      {!tour.change?.files.length && <p>No files changed.</p>}
      {!!stops.length && <div className="tour-layout">
        <label className="tour-picker">Stops<select aria-label="Tour stop" value={position} onChange={e => setPosition(Number(e.target.value))}>{stops.map((s, i) => <option key={i} value={i}>{i + 1}. {s.title}{s.decision ? ' · Needs your decision' : ''}</option>)}</select></label>
        <nav className="tour-stops" aria-label="Tour stops">{stops.map((s, i) => <button key={i} aria-current={i === position ? 'step' : undefined}
          onClick={() => setPosition(i)}><span>{i + 1}. {s.title}</span>{s.decision && <small>Needs your decision</small>}</button>)}</nav>
        <article className="tour-stop">
          <div className="tour-step">Stop {position + 1} of {stops.length}
            <div><button className="ghost" disabled={position === 0} onClick={() => setPosition(p => p - 1)}>Previous</button>
              <button className="ghost" disabled={position === stops.length - 1} onClick={() => setPosition(p => p + 1)}>Next</button></div></div>
          {current && <><h3>{current.title}</h3><p>{current.summary}</p>
            {current.decision && <div className="tour-decision"><b>Needs your decision</b><p>{current.decision}</p></div>}
            <div className="tour-excerpt"><div className="tour-path"><code>{current.path}</code><span>{current.side === 'old' ? 'Old lines' : 'Lines'} {current.start}–{current.end}</span></div>
              <DiffView text={current.diff} path={current.path} wrap={wrap} /></div>
          </>}
        </article>
      </div>}
      {!!tour.guide?.alsoChanged.length && <details className="tour-also" open={!stops.length}><summary>Also changed · {tour.guide.alsoChanged.length}</summary>
        <ul>{tour.guide.alsoChanged.map(file => <li key={file.path}><code>{file.path}</code>{file.note && <p>{file.note}</p>}</li>)}</ul>
      </details>}
    </>}
  </section>;
}
