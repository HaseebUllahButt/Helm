import { useEffect, useState } from 'react';
import { Client, type CliAgent, type Environment, type Session, type DelegationResult } from '../client';
import { EngineMark } from '../EngineMark';
import { Markdown } from '../Markdown';
import { useDialog } from '../useDialog';
import { PermissionSheet } from './PermissionSheet';
import type { Permission, Decision } from './types';

/** Account → model → task, then a live branch list beside the parent thread. */
export function Subagents({ client, env, parent, onClose }: {
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
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const ref = useDialog(() => { if (!busy) onClose(); });
  const agent = agents.find((a) => a.id === account);
  const children = sessions.filter((s) => !s.archived && s.delegation?.parentId === parent.id);
  const readOnly = ['plan', 'readonly', 'read'].includes(parent.mode ?? '');
  const modes = agent?.modes.filter((m) => m.id !== 'plan' && (!readOnly || ['readonly', 'read'].includes(m.id))) ?? [];

  useEffect(() => {
    let stale = false;
    const load = () => client.rpc<{ sessions: Session[] }>(env.id, 'session.list', { parentId: parent.id })
      .then((r) => { if (!stale) setSessions(r.sessions); })
      .catch((e) => { if (!stale) setError(e.message); });
    void load();
    const off = client.on((e, kind, payload: any) => {
      if (e === env.id && kind === 'session.update' && payload?.session?.delegation?.parentId === parent.id) {
        const s = payload.session as Session;
        const belongs = !s.archived && s.delegation?.parentId === parent.id;
        setSessions((all) => [...all.filter((existing) => existing.id !== s.id), ...(belongs ? [s] : [])]);
        if (!belongs) setSelected((id) => id === s.id ? '' : id);
        setRevision((r) => r + 1);
      }
      if ((kind === 'connection' && payload?.online) || (e === env.id && kind === 'session.exit')) void load();
    });
    return () => { stale = true; off(); };
  }, [client, env.id, parent.id]);

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
  useEffect(() => { setResult(null); setPermissions([]); setMessage(''); setNotice(''); }, [selected]);

  useEffect(() => {
    if (!selected) { setResult(null); return; }
    let stale = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await client.rpc<DelegationResult>(env.id, 'session.delegation-result', { id: selected });
        if (stale) return;
        setResult(r);
        if (r.pending) {
          const history = await client.rpc<{ pending: Permission[] }>(env.id, 'session.events', { id: selected, tail: 1 });
          if (!stale) setPermissions(history.pending ?? []);
        } else setPermissions([]);
        if (!r.complete) timer = setTimeout(load, 2500);
      } catch (e: any) { if (!stale) setError(e.message); }
    };
    void load();
    return () => { stale = true; clearTimeout(timer); };
  }, [client, env.id, selected, revision]);

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
  const sendMessage = async () => {
    if (!message.trim() || sending) return;
    setSending(true); setError('');
    try {
      await client.rpc(env.id, 'session.delegation-message', { parentId: parent.id, id: selected, data: message.trim() });
      setMessage(''); setNotice('Message sent. A busy agent receives it as a steering message or on its next turn.');
      setRevision((r) => r + 1);
    } catch (e: any) { setError(e.message); }
    finally { setSending(false); }
  };
  const answer = async (permission: Permission, decision: Decision) => {
    setSending(true); setError('');
    try {
      await client.rpc(env.id, 'session.answer', { id: selected, requestId: permission.requestId, decision });
      setPermissions((all) => all.filter((p) => p.requestId !== permission.requestId));
      setRevision((r) => r + 1);
    } catch (e: any) { setError(e.message); }
    finally { setSending(false); }
  };

  return <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="modal delegation-panel" ref={ref} role="dialog" aria-modal="true" aria-label="Subagents" tabIndex={-1}>
      <div className="delegation-heading">
        <div><h2>Subagents</h2><p>{env.name} · {parent.title}</p></div>
        <button className="iconbtn" aria-label="Close subagents" disabled={busy} onClick={onClose}>×</button>
      </div>
      <p className="delegation-intro">Dispatch a task in this folder. Subagents belong to this orchestrator, not your recent chats. Steer them here without opening another thread.</p>
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
            <option value="">{readOnly ? 'Read only' : agent?.defaultMode && agent.defaultMode !== 'plan' ? `${modes.find((m) => m.id === agent.defaultMode)?.label || 'YOLO'} (account default)` : 'Inherit orchestrator · YOLO by default'}</option>
            {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select></label>}
        </div>
        {agent && !agent.modes.length && <p className="note">This CLI controls its own permissions.</p>}
        <label htmlFor="delegate-task">Task</label>
        <textarea id="delegate-task" rows={3} maxLength={32000} placeholder="Implement a specific, bounded task…"
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
            {result?.pending && !permissions.length && <p className="note">Needs approval: {result.pending.title || result.pending.kind}</p>}
            {permissions.map((p) => <PermissionSheet key={p.requestId} permission={p} busy={sending} onAnswer={(d) => void answer(p, d)} />)}
            {result?.truncated && <p className="note">Showing the most recent output from this task.</p>}
            <form onSubmit={(e) => { e.preventDefault(); void sendMessage(); }}>
              <label htmlFor={`message-${s.id}`}>Message subagent</label>
              <textarea id={`message-${s.id}`} rows={2} maxLength={32000} value={message} disabled={sending}
                placeholder="Clarify, redirect, or give a follow-up task…" onChange={(e) => setMessage(e.target.value)} />
              <button className="primary" disabled={sending || !message.trim()}>{sending ? 'Sending…' : 'Send message'}</button>
              {notice && <p className="note" role="status">{notice}</p>}
            </form>
            {result?.complete
              ? <button className="linkish" onClick={async () => {
                try {
                  await client.rpc(env.id, 'session.archive', { id: s.id, archived: true });
                  setSessions((all) => all.filter((item) => item.id !== s.id));
                  setSelected('');
                } catch (e: any) { setError(e.message); }
              }}>Hide finished task</button>
              : <button className="linkish destructive" onClick={() => client.rpc(env.id, 'session.interrupt', { id: s.id }).catch((e) => setError(e.message))}>Stop subagent</button>}
          </div>}
        </div>)}
      </div>
    </div>
  </div>;
}
