import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Client, type CliAgent, type Environment, type Session, type DelegationResult } from '../client';
import { EngineMark } from '../EngineMark';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { useDialog } from '../useDialog';
import { PermissionSheet } from './PermissionSheet';
import type { Permission, Decision } from './types';

const STATUS: Record<string, string> = {
  blocked: 'Needs approval', working: 'Working', starting: 'Starting', done: 'Finished',
  error: 'Failed', interrupted: 'Stopped', idle: 'Ready',
};
const ACTIVE = ['blocked', 'working', 'starting'];
const stateOf = (task: Session) => task.delegation?.status || task.status;

/** Account → model → task, then a live branch list beside the parent thread. */
export function Subagents({ client, env, parent, onClose, onOpen, embedded = false }: {
  client: Client; env: Environment; parent: Session; onClose: () => void; onOpen?: (session: Session) => void;
  embedded?: boolean;
}) {
  const [agents, setAgents] = useState<CliAgent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [listed, setListed] = useState(false);
  const [account, setAccount] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState('');
  const [task, setTask] = useState('');
  const [error, setError] = useState<{ text: string; at: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState<DelegationResult | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [focus, setFocus] = useState('');
  const firstList = useRef(false);
  const ref = useDialog(() => { if (!busy) onClose(); }, !embedded);
  const fail = (at: string) => (failure: any) => setError({ text: failure?.message || String(failure), at });
  const bump = () => setRevision((count) => count + 1);
  const agent = agents.find((candidate) => candidate.id === account);
  const belongsHere = (session: Session) => !session.archived && session.delegation?.parentId === parent.id;
  const children = sessions.filter(belongsHere);
  const active = children.filter((child) => ACTIVE.includes(stateOf(child))).sort((left, right) =>
    Number(stateOf(right) === 'blocked') - Number(stateOf(left) === 'blocked') || (left.createdAt ?? 0) - (right.createdAt ?? 0));
  const finished = children.filter((child) => !ACTIVE.includes(stateOf(child)))
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  const readOnly = ['plan', 'readonly', 'read'].includes(parent.mode ?? '');
  const modes = agent?.modes.filter((option) => option.id !== 'plan' && (!readOnly || ['readonly', 'read'].includes(option.id))) ?? [];
  const showOptions = advanced || (!loading && !agent?.available);
  const modeLabel = (id?: string | null) => modes.find((option) => option.id === id)?.label;
  const permissionLabel = readOnly ? 'Read only'
    : mode ? modeLabel(mode) || mode
    : agent?.defaultMode && agent.defaultMode !== 'plan' ? modeLabel(agent.defaultMode) || 'YOLO'
    : agent && !agent.modes.length ? 'CLI permissions' : 'Inherited permissions';
  const summary = loading && !agent ? 'Finding CLI accounts…'
    : !agent?.available ? 'No CLI account available'
    : [agent.label || agent.id, model.trim() || agent.defaultModel || 'CLI default', permissionLabel].join(' · ');

  useEffect(() => {
    let stale = false;
    const load = () => client.rpc<{ sessions: Session[] }>(env.id, 'session.list', { parentId: parent.id })
      .then((listing) => {
        if (stale) return;
        setSessions(listing.sessions);
        if (!firstList.current) {
          firstList.current = true;
          if (!listing.sessions.some(belongsHere)) setComposing(true);
        }
        setListed(true);
      })
      .catch((failure) => { if (!stale) { fail('')(failure); setListed(true); } });
    void load();
    const off = client.on((envId, kind, payload: any) => {
      if (envId === env.id && kind === 'session.update' && payload?.session?.delegation?.parentId === parent.id) {
        const updated = payload.session as Session;
        const belongs = belongsHere(updated);
        setSessions((all) => [...all.filter((existing) => existing.id !== updated.id), ...(belongs ? [updated] : [])]);
        if (!belongs) setSelected((id) => id === updated.id ? '' : id);
        bump();
      }
      if ((kind === 'connection' && payload?.online) || (envId === env.id && kind === 'session.exit')) void load();
    });
    return () => { stale = true; off(); };
  }, [client, env.id, parent.id]);

  const loadAgents = async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      const listing = await client.rpc<{ agents: CliAgent[] }>(env.id, 'agent.list', { refresh }, 60_000);
      setAgents(listing.agents);
      setAccount((current) => listing.agents.some((candidate) => candidate.id === current && candidate.available)
        ? current : (listing.agents.find((candidate) => candidate.available)?.id ?? ''));
    } catch (failure: any) { fail('form')(failure); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadAgents(); }, [client, env.id]);
  useEffect(() => { setModel(''); setMode(''); }, [account]);

  useEffect(() => {
    if (!focus) return;
    ref.current?.querySelector<HTMLElement>(focus === 'new' ? '.delegation-new' : `[data-task="${CSS.escape(focus)}"]`)?.focus();
    setFocus('');
  }, [focus]);

  useEffect(() => {
    if (!selected) { setResult(null); return; }
    let stale = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const reply = await client.rpc<DelegationResult>(env.id, 'session.delegation-result', { id: selected });
        if (stale) return;
        setResult(reply);
        if (reply.pending) {
          const history = await client.rpc<{ pending: Permission[] }>(env.id, 'session.events', { id: selected, tail: 1 });
          if (!stale) setPermissions(history.pending ?? []);
        } else setPermissions([]);
        if (!reply.complete) timer = setTimeout(load, 2500);
      } catch (failure: any) { if (!stale) fail(selected)(failure); }
    };
    void load();
    return () => { stale = true; clearTimeout(timer); };
  }, [client, env.id, selected, revision]);

  const select = (id: string) => {
    setSelected(id); setResult(null); setPermissions([]); setMessage(''); setNotice(''); setError(null);
  };
  const added = (session: Session) => {
    setSessions((all) => [...all.filter((existing) => existing.id !== session.id), session]);
    select(session.id); setFocus(session.id);
  };
  const start = async () => {
    if (!agent?.available || !task.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const { session } = await client.rpc<{ session: Session }>(env.id, 'session.delegate', {
        id: parent.id, profileId: account, model: model.trim() || undefined,
        mode: mode || undefined, task: task.trim(),
      }, 70_000);
      setTask(''); setComposing(false); setAdvanced(false);
      added(session);
    } catch (failure: any) { fail('form')(failure); }
    finally { setBusy(false); }
  };
  const act = async (kind: string, action: () => Promise<void>) => {
    if (acting) return;
    setActing(kind); setError(null); setNotice('');
    try { await action(); } catch (failure: any) { fail(selected)(failure); }
    finally { setActing(''); }
  };
  const sendMessage = async () => {
    if (!message.trim() || sending) return;
    setSending(true); setError(null); setNotice('');
    try {
      await client.rpc(env.id, 'session.delegation-message', { parentId: parent.id, id: selected, data: message.trim() });
      setMessage('');
      setNotice(result?.complete ? 'Message sent.' : 'Message sent. It reaches the agent mid-task or on its next turn.');
      bump();
    } catch (failure: any) { fail(selected)(failure); }
    finally { setSending(false); }
  };
  const answer = async (permission: Permission, decision: Decision) => {
    setSending(true); setError(null);
    try {
      await client.rpc(env.id, 'session.answer', { id: selected, requestId: permission.requestId, decision });
      setPermissions((all) => all.filter((item) => item.requestId !== permission.requestId));
      bump();
    } catch (failure: any) { fail(selected)(failure); }
    finally { setSending(false); }
  };
  const stop = (child: Session) => act('stop', async () => {
    await client.rpc(env.id, 'session.interrupt', { id: child.id });
    setNotice('Stop requested.');
    bump();
  });
  const retry = (child: Session) => act('retry', async () => {
    const { session } = await client.rpc<{ session: Session }>(env.id, 'session.delegate', {
      id: parent.id, profileId: child.profileId, model: child.delegation?.requestedModel || undefined,
      effort: child.effort || undefined,
      mode: child.mode && child.mode !== 'plan' ? child.mode : undefined, task: child.delegation?.task || child.title,
    }, 70_000);
    added(session);
  });
  const hide = (child: Session) => act('hide', async () => {
    await client.rpc(env.id, 'session.archive', { id: child.id, archived: true });
    setSessions((all) => all.filter((item) => item.id !== child.id));
    setSelected(''); setFocus('new');
  });
  const submitOnShortcut = (submit: () => void) => (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
  };
  const errorBox = (at: string) => error?.at === at && <p className="error" role="alert">{error.text}</p>;

  const detail = (child: Session) => {
    const state = result?.status || stateOf(child);
    const complete = result ? result.complete : !ACTIVE.includes(stateOf(child));
    return <div className="delegation-detail" id={`task-detail-${child.id}`}>
      {child.delegation?.task && child.delegation.task !== child.title && <p className="delegation-request">{child.delegation.task}</p>}
      {permissions.map((permission) => <PermissionSheet key={permission.requestId} permission={permission} busy={sending}
        onAnswer={(decision) => void answer(permission, decision)} />)}
      {result?.pending && !permissions.length && <p className="note">Needs approval: {result.pending.title || result.pending.kind}</p>}
      {!result ? <p className="note" role="status">Reading result…</p>
        : result.output ? <div className="delegation-output"><Markdown text={result.output} live={!result.complete} /></div>
        : !result.error && <p className="note">{result.complete ? 'Finished without a written reply.' : 'No reply yet.'}</p>}
      {result?.error && <p className="error">{result.error}</p>}
      {result?.truncated && <p className="note">Showing the most recent output.</p>}
      <form className="delegation-follow" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
        <label htmlFor={`message-${child.id}`} className="vh">Message subagent</label>
        <textarea id={`message-${child.id}`} rows={2} maxLength={32000} value={message} disabled={sending}
          placeholder={complete ? 'Give a follow-up task…' : 'Clarify or redirect…'} onChange={(event) => setMessage(event.target.value)}
          onKeyDown={submitOnShortcut(() => void sendMessage())} />
        <button className="primary" disabled={sending || !message.trim()}>{sending ? 'Sending…' : 'Send message'}</button>
      </form>
      <div className="delegation-actions">
        {onOpen && <button type="button" className="ghost" onClick={() => onOpen(child)}>Open conversation</button>}
        {complete ? <>
          {['error', 'interrupted'].includes(state) && <button type="button" className="ghost" disabled={!!acting} onClick={() => void retry(child)}>
            {acting === 'retry' ? 'Retrying…' : 'Retry task'}</button>}
          <button type="button" className="ghost" disabled={!!acting} onClick={() => void hide(child)}>{acting === 'hide' ? 'Hiding…' : 'Hide task'}</button>
        </> : <button type="button" className="ghost destructive" disabled={!!acting} onClick={() => void stop(child)}>
          {acting === 'stop' ? 'Stopping…' : 'Stop subagent'}</button>}
      </div>
      {notice && <p className="note" role="status">{notice}</p>}
      {errorBox(child.id)}
    </div>;
  };

  const row = (child: Session) => {
    const state = stateOf(child);
    const open = selected === child.id;
    const label = STATUS[state] || state;
    const toggle = () => select(open ? '' : child.id);
    return <li key={child.id} className={`delegation-branch${open ? ' selected' : ''}`}>
      <div className="delegation-row">
        <button type="button" className="delegation-task" title={onOpen ? 'Open subagent conversation' : undefined}
          onClick={() => onOpen ? onOpen(child) : toggle()}>
          <EngineMark engine={child.engine} />
          <span className="grow"><b>{child.title}</b><small>{child.profileId} · {child.model || child.engineModel || 'CLI default'}</small></span>
        </button>
        <button type="button" className={`delegation-status state-${state}`} data-task={child.id} aria-label={`${label}, details`}
          aria-expanded={open} aria-controls={`task-detail-${child.id}`} onClick={toggle}>
          <i aria-hidden="true" />{label}<Icon name={open ? 'up' : 'down'} size={14} />
        </button>
      </div>
      {open && detail(child)}
    </li>;
  };

  const group = (id: string, title: string, items: Session[]) => !!items.length &&
    <section className={`delegation-group ${id}`} aria-labelledby={`delegation-${id}`}>
      <h3 id={`delegation-${id}`}>{title} <span>{items.length}</span></h3>
      <ul>{items.map(row)}</ul>
    </section>;

  return <div className={embedded ? 'embedded-agents' : 'modal-back'} onClick={(event) => { if (!embedded && event.target === event.currentTarget && !busy) onClose(); }}>
    <div className={`${embedded ? '' : 'modal '}delegation-panel`} ref={ref} role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : true} aria-label="Subagents" tabIndex={-1}>
      {!embedded && <div className="delegation-heading">
        <div><h2>Subagents</h2><p>{env.name} · {parent.title}</p></div>
        <button className="iconbtn" aria-label="Close subagents" disabled={busy} onClick={onClose}><Icon name="close" size={18} /></button>
      </div>}
      <div className="delegation-body">
        {errorBox('')}
        {composing ? <form className="delegation-form" aria-label="New task" onSubmit={(event) => { event.preventDefault(); void start(); }}>
          <label htmlFor="delegate-task">Task</label>
          <textarea id="delegate-task" rows={3} maxLength={32000} autoFocus placeholder="Describe a specific, bounded task…"
            value={task} disabled={busy} onChange={(event) => setTask(event.target.value)} onKeyDown={submitOnShortcut(() => void start())} />
          <button type="button" className="delegation-config" aria-expanded={showOptions} aria-controls="delegate-options"
            disabled={busy} onClick={() => setAdvanced(!showOptions)}>
            {agent && <EngineMark engine={agent.engine} />}
            <span className="grow">{summary}</span>
            <span className="delegation-config-more">Options<Icon name={showOptions ? 'up' : 'down'} size={14} /></span>
          </button>
          {showOptions && <div className="delegation-options" id="delegate-options">
            <div className="delegation-account-label"><label htmlFor="delegate-account">CLI account</label>
              <button type="button" className="linkish" disabled={loading || busy} onClick={() => void loadAgents(true)}>
                {loading ? 'Refreshing…' : 'Refresh accounts'}</button></div>
            <select id="delegate-account" value={account} disabled={loading || busy} onChange={(event) => setAccount(event.target.value)}>
              {!account && <option value="">{loading ? 'Finding CLI accounts…' : 'No CLI accounts available'}</option>}
              {agents.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={!candidate.available}>
                {candidate.label || candidate.id} · {candidate.engine} · {candidate.auth === 'authenticated' ? 'signed in' : candidate.auth === 'unauthenticated' ? 'signed out' : 'sign-in not verified'}
              </option>)}
            </select>
            <div className="delegation-pickers">
              <label>Model<input aria-label="Subagent model" list="delegate-models" placeholder={agent?.defaultModel || 'CLI default'}
                value={model} disabled={!agent || busy} onChange={(event) => setModel(event.target.value)} /></label>
              <datalist id="delegate-models">{agent?.models?.map((name) => <option key={name} value={name}>{agent.labels?.[name] || name}</option>)}</datalist>
              {!!modes.length && <label>Permissions<select aria-label="Subagent permissions" value={mode} disabled={busy} onChange={(event) => setMode(event.target.value)}>
                <option value="">{readOnly ? 'Read only' : agent?.defaultMode && agent.defaultMode !== 'plan' ? `${modeLabel(agent.defaultMode) || 'YOLO'} (account default)` : 'Inherit orchestrator · YOLO by default'}</option>
                {modes.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select></label>}
            </div>
            {agent && !agent.modes.length && <p className="note">This CLI controls its own permissions.</p>}
          </div>}
          {errorBox('form')}
          <div className="delegation-start">
            <span>{readOnly ? 'Read only, in this thread’s folder.' : 'Works in this thread’s folder.'}</span>
            {children.length > 0 && <button type="button" className="ghost" disabled={busy} onClick={() => { setComposing(false); setFocus('new'); }}>Cancel</button>}
            <button className="primary" disabled={busy || loading || !agent?.available || !task.trim()}>{busy ? 'Starting…' : 'Start subagent'}</button>
          </div>
        </form>
          : <button type="button" className="delegation-new" onClick={() => setComposing(true)}><Icon name="plus" size={16} />New task</button>}
        <div className="delegation-branches" aria-label="Delegated tasks">
          {!listed ? <p className="note" role="status">Loading tasks…</p>
            : !children.length && !composing && <p className="note">No tasks yet.</p>}
          {group('active', 'Active', active)}
          {group('finished', 'Finished', finished)}
        </div>
      </div>
    </div>
  </div>;
}
