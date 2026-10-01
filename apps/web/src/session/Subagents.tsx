import { useEffect, useState } from 'react';
import { Client, type CliAgent, type Environment, type Session, type DelegationResult } from '../client';
import { EngineMark } from '../EngineMark';
import { Markdown } from '../Markdown';
import { useDialog } from '../useDialog';

/** Account → model → task, then a live branch list beside the parent thread. */
export function Subagents({ client, env, parent, onClose, onOpen }: {
  client: Client; env: Environment; parent: Session; onClose: () => void; onOpen?: (s: Session) => void;
}) {
  const [agents, setAgents] = useState<CliAgent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [account, setAccount] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState('');
  const [task, setTask] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState<DelegationResult | null>(null);
  const ref = useDialog(() => { if (!busy) onClose(); });
  const agent = agents.find((a) => a.id === account);
  const children = sessions.filter((s) => s.delegation?.parentId === parent.id);
  const readOnly = ['plan', 'readonly', 'read'].includes(parent.mode ?? '');
  const modes = agent?.modes.filter((m) => !readOnly || ['plan', 'readonly', 'read'].includes(m.id)) ?? [];

  useEffect(() => {
    let stale = false;
    const load = () => client.rpc<{ sessions: Session[] }>(env.id, 'session.list')
      .then((r) => { if (!stale) setSessions(r.sessions); })
      .catch((e) => { if (!stale) setError(e.message); });
    void load();
    const off = client.on((e, kind, payload: any) => {
      if (e === env.id && kind === 'session.update' && payload?.session) {
        setSessions((all) => [...all.filter((s) => s.id !== payload.session.id), payload.session]);
      }
      if ((kind === 'connection' && payload?.online) || (e === env.id && kind === 'session.exit')) void load();
    });
    return () => { stale = true; off(); };
  }, [client, env.id]);

  const loadAgents = async (refresh = false) => {
    setLoading(true); setError('');
    try {
      const r = await client.rpc<{ agents: CliAgent[] }>(env.id, 'agent.list', { refresh }, 60_000);
      setAgents(r.agents);
      setAccount((current) => r.agents.some((a) => a.id === current && a.available)
        ? current : (r.agents.find((a) => a.available)?.id ?? ''));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadAgents(); }, [client, env.id]);
  useEffect(() => { setModel(''); setMode(''); }, [account]);

  useEffect(() => {
    if (!selected) { setResult(null); return; }
    let stale = false;
    let timer: ReturnType<typeof setTimeout>;
    setResult(null);
    const load = async () => {
      try {
        const r = await client.rpc<DelegationResult>(env.id, 'session.delegation-result', { id: selected });
        if (stale) return;
        setResult(r);
        if (!r.complete) timer = setTimeout(load, 2500);
      } catch (e: any) { if (!stale) setError(e.message); }
    };
    void load();
    return () => { stale = true; clearTimeout(timer); };
  }, [client, env.id, selected]);

  const start = async () => {
    if (!agent?.available || !task.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const { session } = await client.rpc<{ session: Session }>(env.id, 'session.delegate', {
        id: parent.id, profileId: account, model: model.trim() || undefined,
        mode: mode || undefined, task: task.trim(),
      }, 70_000);
      setSessions((all) => [...all.filter((s) => s.id !== session.id), session]);
      setSelected(session.id); setTask('');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const open = (s: Session) => { onClose(); onOpen?.(s); };

  return <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="modal delegation-panel" ref={ref} role="dialog" aria-modal="true" aria-label="Subagents" tabIndex={-1}>
      <div className="delegation-heading">
        <div><h2>Subagents</h2><p>{env.name} · {parent.title}</p></div>
        <button className="iconbtn" aria-label="Close subagents" disabled={busy} onClick={onClose}>×</button>
      </div>
      <p className="delegation-intro">Give another CLI a task in this folder. Each child has its own conversation and approvals.</p>
      <form className="delegation-form" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <div className="delegation-account-label"><label htmlFor="delegate-account">CLI account</label>
          <button type="button" className="linkish" disabled={loading || busy} onClick={() => void loadAgents(true)}>Refresh accounts</button></div>
        <select id="delegate-account" value={account} disabled={loading || busy} onChange={(e) => setAccount(e.target.value)}>
          {!account && <option value="">{loading ? 'Finding CLI accounts…' : 'No CLI accounts available'}</option>}
          {agents.map((a) => <option key={a.id} value={a.id} disabled={!a.available}>
            {a.label || a.id} · {a.engine} · {a.auth === 'authenticated' ? 'signed in' : a.auth === 'unauthenticated' ? 'signed out' : 'sign-in not verified'}
          </option>)}
        </select>
        <div className="delegation-pickers">
          <label>Model<input aria-label="Subagent model" list="delegate-models" placeholder={agent?.defaultModel || 'CLI default'}
            value={model} disabled={!agent || busy} onChange={(e) => setModel(e.target.value)} /></label>
          <datalist id="delegate-models">{agent?.models?.map((m) => <option key={m} value={m}>{agent.labels?.[m] || m}</option>)}</datalist>
          {!!modes.length && <label>Permissions<select aria-label="Subagent permissions" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value)}>
            <option value="">{readOnly ? 'Read only' : modes[0]?.label}</option>
            {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select></label>}
        </div>
        {agent && !agent.modes.length && <p className="note">This CLI controls its own permissions.</p>}
        <label htmlFor="delegate-task">Task</label>
        <textarea id="delegate-task" rows={3} maxLength={32000} placeholder="Ask Opus to review the security changes…"
          value={task} disabled={busy} onChange={(e) => setTask(e.target.value)} />
        <div className="delegation-start"><span>{readOnly ? 'This child will be read only.' : 'Works in the same folder as this thread.'}</span>
          <button className="primary" disabled={busy || loading || !agent?.available || !task.trim()}>{busy ? 'Starting…' : 'Start subagent'}</button></div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="delegation-branches" aria-label="Delegated tasks">
        <h3>Tasks <span>{children.length}</span></h3>
        {!children.length && <p className="note">Tasks you or this agent delegate will appear here.</p>}
        {children.map((s) => <div key={s.id} className={`delegation-branch${selected === s.id ? ' selected' : ''}`}>
          <button className="delegation-task" aria-expanded={selected === s.id} onClick={() => setSelected(selected === s.id ? '' : s.id)}>
            <EngineMark engine={s.engine} /><span className="grow"><b>{s.title}</b><small>{s.profileId} · {s.model || s.engineModel || 'CLI default'}</small></span>
            <span className={`delegation-status ${s.delegation?.status || s.status}`}>
              {{ blocked: 'Needs approval', working: 'Working', starting: 'Starting', done: 'Finished', error: 'Failed', interrupted: 'Stopped', idle: 'Ready' }[s.delegation?.status || s.status] || s.status}
            </span>
          </button>
          {selected === s.id && <div className="delegation-result">
            <p className="delegation-request">{s.delegation?.task}</p>
            {!result && <p className="note">Reading result…</p>}
            {result?.output && <Markdown text={result.output} live={!result.complete} />}
            {result?.error && <p className="error">{result.error}</p>}
            {result?.pending && <p className="note">Needs approval: {result.pending.title || result.pending.kind}</p>}
            {result?.truncated && <p className="note">Showing the end of the reply. Open the thread for the full conversation.</p>}
            {onOpen && <button className="linkish" onClick={() => open(result?.session ?? s)}>Open child thread →</button>}
            {!result?.complete && <button className="linkish destructive" onClick={() => client.rpc(env.id, 'session.interrupt', { id: s.id }).catch((e) => setError(e.message))}>Stop subagent</button>}
          </div>}
        </div>)}
      </div>
    </div>
  </div>;
}
