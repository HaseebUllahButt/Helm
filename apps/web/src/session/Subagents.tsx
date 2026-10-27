import { errorMessage } from '../errors';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Client, type CliAgent, type Environment, type ModelList, type Session, type DelegationResult, type NativeAgent, type NativeAgentDetail, type SubagentDefaults } from '../client';
import { loadModels, saveModels } from '../modelCache';
import { followModelRefresh } from '../modelRefresh';
import { ChoiceSheet, Controls, trayPrefs, type Kind } from './Controls';
import { EngineMark } from '../EngineMark';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { useDialog } from '../useDialog';
import { newMessageId } from '@helm/protocol/reliable-input';
import { AgentMessages } from './AgentMessages';
import { PermissionSheet } from './PermissionSheet';
import type { Permission, Decision } from './types';

const STATUS: Record<string, string> = {
  blocked: 'Needs approval', working: 'Working', starting: 'Starting', done: 'Finished',
  error: 'Failed', interrupted: 'Stopped', idle: 'Ready',
};
const ACTIVE = ['blocked', 'working', 'starting'];
const stateOf = (task: Session) => task.delegation?.status || task.status;
/**
 * The accounts new chats offer on this machine, plus the one this chat runs
 * as in place of its account's usual row. An older machine does not say
 * which those are, so it offers all of them.
 */
const offeredOf = (agents: CliAgent[], profileId?: string | null) => {
  if (!agents.some((candidate) => 'shown' in candidate)) return agents;
  const own = agents.find((candidate) => candidate.id === profileId && candidate.available);
  return agents.filter((candidate) => candidate === own || candidate.shown && candidate.account !== own?.account);
};

/**
 * Account → model → task, then a live branch list beside the parent thread.
 * `nativeOnly` is for a terminal thread Helm cannot delegate from: just the
 * subagents its CLI ran, with no task form.
 */
export function Subagents({ client, env, parent, onClose, onOpen, onOpenNative, embedded = false, reviewAttention = false, onNativeAttention, nativeOnly = false }: {
  client: Client; env: Environment; parent: Session; onClose: () => void; onOpen?: (session: Session) => void;
  /** Open one of the CLI's own subagents as a chat. */
  onOpenNative?: (agent: NativeAgent) => void;
  embedded?: boolean; reviewAttention?: boolean; onNativeAttention?: () => void; nativeOnly?: boolean;
}) {
  const [agents, setAgents] = useState<CliAgent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [listed, setListed] = useState(false);
  const [account, setAccount] = useState(parent.profileId ?? '');
  const [model, setModel] = useState<string | null>(null);
  const [mode, setMode] = useState('');
  const [effort, setEffort] = useState('');
  const [catalog, setCatalog] = useState<ModelList | null>(null);
  const [choosingAccount, setChoosingAccount] = useState(false);
  const [task, setTask] = useState('');
  const [error, setError] = useState<{ text: string; at: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState<DelegationResult | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const message = messageDrafts[selected] ?? '';
  const setMessage = (text: string) => setMessageDrafts((all) => ({ ...all, [selected]: text }));
  const [sending, setSending] = useState(false);
  const messageAttempt = useRef<{ id: string; target: string; text: string } | null>(null);
  const [acting, setActing] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [focus, setFocus] = useState('');
  const [nativeOpen, setNativeOpen] = useState('');
  const [nativeDetail, setNativeDetail] = useState<NativeAgentDetail | null>(null);
  const firstList = useRef(false);
  const ref = useDialog(() => { if (!busy) onClose(); }, !embedded);
  const fail = (at: string) => (failure: any) => setError({ text: errorMessage(failure), at });
  const bump = () => setRevision((count) => count + 1);
  const offered = offeredOf(agents, parent.profileId);
  const agent = offered.find((candidate) => candidate.id === account);
  const savedDefaults = agent?.subagentDefaults ?? catalog?.subagentDefaults ?? {};
  // What this machine starts the account on, the same as a new chat.
  const fallbackModel = catalog?.default || agent?.defaultModel || '';
  const selectedModel = model || savedDefaults.model || fallbackModel;
  const belongsHere = (session: Session) => !session.archived && session.delegation?.parentId === parent.id;
  const children = sessions.filter(belongsHere);
  const active = children.filter((child) => ACTIVE.includes(stateOf(child))).sort((left, right) =>
    Number(stateOf(right) === 'blocked') - Number(stateOf(left) === 'blocked') || (left.createdAt ?? 0) - (right.createdAt ?? 0));
  const finished = children.filter((child) => !ACTIVE.includes(stateOf(child)))
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  // The CLI's own subagents: read from its records, opened as chats.
  const natives = parent.nativeCards ?? [];
  const nativeActive = natives.filter((agent) => ACTIVE.includes(agent.status))
    .sort((left, right) => Number(right.status === 'blocked') - Number(left.status === 'blocked'));
  const nativeFinished = natives.filter((agent) => !ACTIVE.includes(agent.status)).sort((left, right) => right.startedAt - left.startedAt);
  const openNative = natives.find((agent) => agent.id === nativeOpen);
  const readOnly = ['plan', 'readonly', 'read'].includes(parent.mode ?? '');
  const modes = agent?.modes.filter((option) => option.id !== 'plan' && (!readOnly || ['readonly', 'read'].includes(option.id))) ?? [];
  // The same chips and sheets as the message box, fed the machine's own
  // list for the chosen account: its models, favorites and defaults. What
  // the account list carried paints first, the machine's answer replaces it.
  const options: ModelList | null = agent ? {
    default: agent.defaultModel ?? null, models: agent.models ?? [], labels: agent.labels,
    ...catalog,
    prefs: { ...catalog?.prefs, default: savedDefaults.model ?? null, approved: catalog?.prefs?.approved ?? [] },
    defaults: { ...(catalog?.defaults ?? agent.defaults), ...savedDefaults },
    effort: savedDefaults.effort || catalog?.defaults?.effort || agent.defaults?.effort || catalog?.effort,
    // A helper's permissions are the account's, narrowed for a read-only
    // parent, and it never plans first. Its speed is not a choice here.
    modes, defaultMode: modes.find((m) => m.id === (savedDefaults.mode || catalog?.defaults?.mode || agent.defaultMode))?.id ?? modes[0]?.id ?? null,
    speeds: [], speedByModel: {},
  } : null;
  const picked = { engine: agent?.engine ?? '', profileId: account, model: selectedModel, effort, mode } as Session;
  const prefs = trayPrefs({ client, env: env.id, engine: agent?.engine ?? '', profileId: account || null,
    options, setOptions: (update) => setCatalog((now) => update(now ?? options)),
    setError: (text) => setError(text ? { text, at: 'form' } : null) });
  const pick = (kind: Kind, id: string) => {
    if (kind === 'model') {
      setModel(id);
      // A thinking level the new model does not offer is not kept.
      const levels = options?.effortsByModel?.[id] ?? options?.efforts ?? [];
      if (effort && !levels.includes(effort)) setEffort('');
    } else if (kind === 'effort') setEffort(id);
    else if (kind === 'mode') setMode(id);
  };
  const onDefault = async (kind: Kind, value: string) => {
    if (!agent || kind === 'speed') return;
    setError(null);
    const result = await client.rpc<{ subagentDefaults: SubagentDefaults }>(env.id, 'profile.defaults', {
      profileId: account, scope: 'subagent', [kind]: value || null,
    }, 15_000);
    setAgents((all) => all.map((candidate) => candidate.id === account || agent.account && candidate.account === agent.account
      ? { ...candidate, subagentDefaults: result.subagentDefaults } : candidate));
    setCatalog((now) => {
      if (!now) return now;
      const updated = { ...now, subagentDefaults: result.subagentDefaults };
      void saveModels(env.id, account, updated);
      return updated;
    });
  };
  const controls = Controls({ options, session: picked, busy, onPick: pick, ...prefs, onDefault, defaultsFor: 'subagents' });
  const accountName = (candidate: CliAgent) => candidate.label || candidate.id;

  useEffect(() => {
    let stale = false;
    const load = () => client.rpc<{ sessions: Session[] }>(env.id, 'session.list', { parentId: parent.id })
      .then((listing) => {
        if (stale) return;
        setSessions(listing.sessions);
        if (!firstList.current) {
          firstList.current = true;
          if (reviewAttention) {
            const tasks = listing.sessions.filter(belongsHere);
            const attention = tasks.find((task) => stateOf(task) === 'blocked')
              ?? tasks.find((task) => stateOf(task) === 'error')
              ?? tasks.find((task) => task.team?.blocked || task.team?.failed);
            if (attention) { select(attention.id); setFocus(attention.id); }
            else onNativeAttention?.();
          }
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
      // Account discovery must not enumerate every installed CLI's models.
      // Only the chosen account needs a catalog, loaded independently below.
      const listing = await client.rpc<{ agents: CliAgent[] }>(env.id, 'agent.list', { refresh, models: false }, 60_000);
      setAgents(listing.agents);
      const offer = offeredOf(listing.agents, parent.profileId);
      setAccount((current) => offer.some((candidate) => candidate.id === current && candidate.available)
        ? current : (offer.find((candidate) => candidate.id === parent.profileId && candidate.available)?.id
          ?? offer.find((candidate) => candidate.available && candidate.engine === parent.engine)?.id
          ?? offer.find((candidate) => candidate.available)?.id ?? ''));
    } catch (failure: any) { fail('form')(failure); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (!nativeOnly) void loadAgents(); }, [client, env.id, nativeOnly]);
  useEffect(() => { setModel(null); setMode(''); setEffort(''); }, [account]);
  // The chosen account's catalogue, from this machine.
  useEffect(() => {
    setCatalog(null);
    if (!account || nativeOnly) return;
    let stale = false;
    loadModels(env.id, account).then((cached) => { if (!stale && cached) setCatalog((now) => now ?? cached); });
    const refresh = followModelRefresh(
      (settled) => client.rpc<ModelList>(env.id, 'model.list', { profileId: account, ...(settled ? { settled } : {}) }, 30_000),
      (list) => {
        if (!Array.isArray(list?.models)) return;
        setCatalog(list); void saveModels(env.id, account, list);
      },
      () => { /* the cached list or parent's model still shows */ },
    );
    return () => { stale = true; refresh.stop(); };
  }, [client, env.id, account, nativeOnly]);

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

  // Re-read when the card moves on (a new step, a final reply), not on a timer:
  // the session update that moved it is the signal.
  useEffect(() => {
    if (!nativeOpen) { setNativeDetail(null); return; }
    let stale = false;
    client.rpc<{ agent: NativeAgentDetail }>(env.id, 'session.native-agent', { id: parent.id, agentId: nativeOpen })
      .then((reply) => { if (!stale) setNativeDetail(reply.agent); })
      .catch((failure) => { if (!stale) fail(`native:${nativeOpen}`)(failure); });
    return () => { stale = true; };
  }, [client, env.id, parent.id, nativeOpen, openNative?.status, openNative?.last]);

  const select = (id: string) => {
    setSelected(id); setResult(null); setPermissions([]); setNotice(''); setError(null);
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
        id: parent.id, profileId: account, model: model || undefined,
        ...(effort ? { effort } : {}), mode: mode || undefined, task: task.trim(),
      }, 70_000);
      setTask(''); setComposing(false); setChoosingAccount(false); controls.close();
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
      if (!env.info?.agentMessages) {
        await client.rpc(env.id, 'session.delegation-message', { parentId: parent.id, id: selected, data: message.trim() });
      } else {
        const text = message.trim();
        if (messageAttempt.current?.target !== selected || messageAttempt.current?.text !== text) {
          messageAttempt.current = { id: newMessageId(), target: selected, text };
        }
        await client.rpc(env.id, 'session.agent-send', { id: parent.id, to: { env: env.id, id: selected },
          text, messageId: messageAttempt.current.id, asUser: true }, 70_000);
        messageAttempt.current = null;
      }
      setMessage('');
      setNotice(result?.complete ? 'Helm sent the message.' : 'Helm sent the message. The agent receives it when it next starts work.');
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
    setNotice('Helm sent the stop request.');
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
      {!result ? <p className="note" role="status">Loading result…</p>
        : result.output ? <div className="delegation-output"><Markdown text={result.output} live={!result.complete} /></div>
        : !result.error && <p className="note">{result.complete ? 'The agent finished without a written reply.' : 'The agent has not replied yet.'}</p>}
      {result?.error && <p className="error">{errorMessage(result.error, { machine: env.name })}</p>}
      {result?.truncated && <p className="note">Showing the most recent output.</p>}
      <form className="delegation-follow" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
        <label htmlFor={`message-${child.id}`} className="vh">Message helper</label>
        <textarea id={`message-${child.id}`} rows={2} maxLength={32000} value={message} disabled={sending}
          placeholder={complete ? 'Enter the next task' : 'Give more instructions'} onChange={(event) => setMessage(event.target.value)}
          onKeyDown={submitOnShortcut(() => void sendMessage())} />
        <button className="primary" disabled={sending || !message.trim()}>{sending ? 'Sending…' : 'Send message'}</button>
      </form>
      <div className="delegation-actions">
        {onOpen && <button type="button" className="ghost" onClick={() => onOpen(child)}>Open chat</button>}
        {complete ? <>
          {['error', 'interrupted'].includes(state) && <button type="button" className="ghost" disabled={!!acting} onClick={() => void retry(child)}>
            {acting === 'retry' ? 'Retrying…' : 'Retry task'}</button>}
          <button type="button" className="ghost" disabled={!!acting} onClick={() => void hide(child)}>{acting === 'hide' ? 'Hiding…' : 'Hide task'}</button>
        </> : <button type="button" className="ghost destructive" disabled={!!acting} onClick={() => void stop(child)}>
          {acting === 'stop' ? 'Stopping…' : 'Stop helper'}</button>}
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
        <button type="button" className="delegation-task" title={onOpen ? 'Open helper chat' : undefined}
          onClick={() => onOpen ? onOpen(child) : toggle()}>
          <EngineMark engine={child.engine} />
          <span className="grow"><b>{child.title}</b><small>{child.profileId} · {child.model || child.engineModel || 'Agent default'}</small></span>
        </button>
        <button type="button" className={`delegation-status state-${state}`} data-task={child.id} aria-label={`${label}, details`}
          aria-expanded={open} aria-controls={`task-detail-${child.id}`} onClick={toggle}>
          <i aria-hidden="true" />{label}<Icon name={open ? 'up' : 'down'} size={14} />
        </button>
      </div>
      {open && detail(child)}
    </li>;
  };

  const nativeRow = (agent: NativeAgent) => {
    const key = `native-${agent.id}`;
    const open = nativeOpen === agent.id;
    const label = STATUS[agent.status] || agent.status;
    const toggle = () => { setNativeOpen(open ? '' : agent.id); setNativeDetail(null); setError(null); };
    const detail = open && nativeDetail?.id === agent.id ? nativeDetail : null;
    return <li key={key} className={`delegation-branch${open ? ' selected' : ''}`}>
      <div className="delegation-row">
        <button type="button" className="delegation-task" title={onOpenNative ? 'Open helper chat' : undefined}
          aria-expanded={onOpenNative ? undefined : open} aria-controls={onOpenNative ? undefined : `task-detail-${key}`}
          onClick={() => onOpenNative ? onOpenNative(agent) : toggle()}>
          <EngineMark engine={agent.engine ?? parent.engine} />
          <span className="grow"><b>{agent.title}</b>
            <small>{[agent.agentType || 'subagent', agent.model || 'Agent default', agent.branch].filter(Boolean).join(' · ')}</small></span>
        </button>
        <button type="button" className={`delegation-status state-${agent.status}`} data-task={key} aria-label={`${label}, details`}
          aria-expanded={open} aria-controls={`task-detail-${key}`} onClick={toggle}>
          <i aria-hidden="true" />{label}<Icon name={open ? 'up' : 'down'} size={14} />
        </button>
      </div>
      {open && <div className="delegation-detail" id={`task-detail-${key}`}>
        {detail?.task && detail.task !== agent.title && <p className="delegation-request">{detail.task}</p>}
        {!detail ? (agent.last ? <p className="note">{agent.last}</p> : <p className="note" role="status">Loading result…</p>)
          : detail.result ? <div className="delegation-output"><Markdown text={detail.result} live={ACTIVE.includes(agent.status)} /></div>
          : <p className="note">{ACTIVE.includes(agent.status) ? 'The agent has not replied yet.' : 'The agent finished without a written reply.'}</p>}
        {agent.status === 'blocked' && <p className="note">Approve the request in the chat.</p>}
        {!!detail?.activity.length && <details className="native-activity">
          <summary>Recent activity</summary>
          <ol>{detail.activity.map((line, index) => <li key={index}>{line}</li>)}</ol>
        </details>}
        {onOpenNative && <div className="delegation-actions">
          <button type="button" className="ghost" onClick={() => onOpenNative(agent)}>{agent.canMessage ? 'Open and message' : 'Open chat'}</button>
        </div>}
        {errorBox(`native:${agent.id}`)}
      </div>}
    </li>;
  };

  const group = (id: string, title: string, items: Session[], native: NativeAgent[] = []) => !!(items.length + native.length) &&
    <section className={`delegation-group ${id}`} aria-labelledby={`delegation-${id}`}>
      <h3 id={`delegation-${id}`}>{title} <span>{items.length + native.length}</span></h3>
      <ul>{items.map(row)}{native.map(nativeRow)}</ul>
    </section>;

  return <div className={embedded ? 'embedded-agents' : 'modal-back'} onClick={(event) => { if (!embedded && event.target === event.currentTarget && !busy) onClose(); }}>
    <div className={`${embedded ? '' : 'modal '}delegation-panel`} ref={ref} role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : true} aria-label="Helpers" tabIndex={-1}>
      {/* Inside the Agents panel its own heading already names the chat. */}
      {!embedded && <div className="delegation-heading">
        <div><h2>Helpers</h2><p>{env.name} · {parent.title}</p></div>
        <button className="iconbtn" aria-label="Close helpers" disabled={busy} onClick={onClose}><Icon name="close" size={18} /></button>
      </div>}
      <div className="delegation-body">
        {errorBox('')}
        {nativeOnly ? null : composing ? <form className="delegation-form" aria-label="New task" onSubmit={(event) => { event.preventDefault(); void start(); }}>
          <label htmlFor="delegate-task">Task</label>
          <textarea id="delegate-task" rows={3} maxLength={32000} autoFocus placeholder="Describe one task"
            value={task} disabled={busy} onChange={(event) => setTask(event.target.value)} onKeyDown={submitOnShortcut(() => void start())} />
          <div className="delegation-chips">
            <span className="chips">
              <button type="button" className={`chip-pick account${choosingAccount ? ' on' : ''}`} disabled={busy || (loading && !agents.length)}
                aria-label={`Agent account: ${agent ? accountName(agent) : loading ? 'finding accounts' : 'none available'}`}
                onClick={() => { controls.close(); setChoosingAccount(!choosingAccount); }}>
                {agent && <EngineMark engine={agent.engine} />}
                <span className="chip-label">{agent ? accountName(agent) : loading ? 'Finding accounts…' : 'No account'}</span>
              </button>
              {agent?.available && <span className="delegation-chip-rest" onClickCapture={() => setChoosingAccount(false)}>{controls.chips}</span>}
            </span>
          </div>
          {choosingAccount ? <ChoiceSheet title={`Agent account on ${env.name}`} current={account} busy={busy}
            choices={offered.map((candidate) => ({ id: candidate.id, label: `${accountName(candidate)} · ${candidate.engine}`,
              icon: <EngineMark engine={candidate.engine} />,
              hint: candidate.auth === 'authenticated' ? 'signed in' : candidate.auth === 'unauthenticated' ? 'signed out' : 'sign-in not checked' }))}
            onPick={(id) => { setChoosingAccount(false); if (offered.find((candidate) => candidate.id === id)?.available) setAccount(id); }}
            onClose={() => setChoosingAccount(false)}
            footer={<button type="button" className="moderow more" disabled={loading} onClick={() => void loadAgents(true)}>
              <span className="grow"><span className="rt">{loading ? 'Looking again…' : 'Look for accounts again'}</span></span></button>} />
            : controls.sheet}
          {errorBox('form')}
          <div className="delegation-start">
            <button type="button" className="ghost" disabled={busy} onClick={() => { setComposing(false); setFocus('new'); }}>Cancel</button>
            <button className="primary" disabled={busy || loading || !agent?.available || !task.trim()}>{busy ? 'Starting…' : 'Start helper'}</button>
          </div>
        </form>
          : null}
        {!nativeOnly && (!composing || env.info?.agentMessages === true) && <div className="delegation-tools">
          {!composing && <button type="button" className="delegation-new" onClick={() => setComposing(true)}><Icon name="plus" size={15} />New task</button>}
          {env.info?.agentMessages === true && <AgentMessages client={client} envId={env.id} parent={parent} children={children} />}
        </div>}
        <div className="delegation-branches" aria-label="Helper tasks">
          {!listed ? <p className="note" role="status">Loading tasks…</p>
            : !children.length && !natives.length && !composing && <p className="note">This chat has no helper tasks.</p>}
          {group('active', 'Active', active, nativeActive)}
          {group('finished', 'Finished', finished, nativeFinished)}
        </div>
      </div>
    </div>
  </div>;
}
