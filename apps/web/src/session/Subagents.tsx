import { errorMessage } from '../errors';
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { Client, type CliAgent, type Environment, type ModelList, type Session, type DelegationResult, type NativeAgent, type NativeAgentDetail, type SubagentDefaults } from '../client';
import { loadModels, saveModels } from '../modelCache';
import { followModelRefresh } from '../modelRefresh';
import { ChoiceSheet, Controls, trayPrefs, type Kind } from './Controls';
import { failureUnseen } from './helperFailures';
import { EngineMark } from '../EngineMark';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { useDialog } from '../useDialog';
import { clipboardFiles, isImageAttachment, prepareAttachment } from './image';
import { AgentMessages } from './AgentMessages';
import { PermissionSheet } from './PermissionSheet';
import type { Permission, Decision } from './types';
import { useThreadTeam, helperState, type TeamMember } from './TeamSummary';

const STATUS: Record<string, string> = {
  blocked: 'Needs approval', working: 'Working', starting: 'Starting', waiting: 'Waiting for its helpers', done: 'Done',
  error: 'Failed', interrupted: 'Stopped', idle: 'Ready',
};
const ACTIVE = ['blocked', 'working', 'starting', 'waiting'];
/** A phone: no Shift+Enter, so Return makes a new line there. */
const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const stateOf = helperState;
/** A helper on a machine that did not answer: only its last state is known. */
const offline = (task: Session) => (task as Session & { offline?: boolean }).offline === true;
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
export function Subagents({ client, env, machines = [], parent, onClose, onOpen, onOpenNative, embedded = false, reviewAttention = false, onNativeAttention, nativeOnly = false, team }: {
  client: Client; env: Environment; parent: Session; onClose: () => void; onOpen?: (session: Session, envId?: string) => void;
  /** Every machine: a helper can run on another one (helm delegate --machine). */
  machines?: Environment[];
  /** Open one of the CLI's own subagents as a chat. */
  onOpenNative?: (agent: NativeAgent) => void;
  embedded?: boolean; reviewAttention?: boolean; onNativeAttention?: () => void; nativeOnly?: boolean;
  /** The helpers the chat already holds. They show at once; the machines' answers replace them. */
  team?: TeamMember[];
}) {
  const [agents, setAgents] = useState<CliAgent[]>([]);
  const seed = (team ?? []).filter((member) => member.depth === 0).map((member) => member.session);
  const [sessions, setSessions] = useState<Session[]>(seed);
  const liveTeam = useThreadTeam(client, env.id, parent.id, parent.remoteHelpers);
  useEffect(() => { setSessions(liveTeam.map((member) => member.session)); setListed(true); setRevision((n) => n + 1); }, [liveTeam]);
  const [listed, setListed] = useState(seed.length > 0);
  const [account, setAccount] = useState(parent.profileId ?? '');
  const [model, setModel] = useState<string | null>(null);
  const [mode, setMode] = useState('');
  const [effort, setEffort] = useState('');
  const [catalog, setCatalog] = useState<ModelList | null>(null);
  const [choosingAccount, setChoosingAccount] = useState(false);
  // The machine whose accounts the new task form shows, and runs on.
  const [target, setTarget] = useState(env.id);
  const [choosingMachine, setChoosingMachine] = useState(false);
  const [task, setTask] = useState('');
  const [error, setError] = useState<{ text: string; at: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [selected, setSelected] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<DelegationResult | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [sending, setSending] = useState(false);
  // Pictures and files pasted, dropped or picked into the new task.
  const [files, setFiles] = useState<{ name: string; mime: string; data: string; url: string }[]>([]);
  const [preparing, setPreparing] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
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
  // Helpers on other machines: where each one runs, and the record this
  // machine keeps of it while that machine cannot be reached.
  const remote = (parent.remoteHelpers ?? []).filter((helper) => !helper.archived);
  const remoteOn = new Map([...remote.map((helper) => [helper.id, helper.machine] as const), ...liveTeam.map((member) => [member.session.id, member.envId ?? env.id] as const)]);
  const envOf = (id: string) => remoteOn.get(id) ?? env.id;
  const nameOf = (id: string) => id === env.id ? env.name : machines.find((machine) => machine.id === id)?.name ?? 'another machine';
  const remoteKey = remote.map((helper) => `${helper.machine}/${helper.id}/${helper.status}`).join(',');
  const hosts = [env, ...machines.filter((machine) => machine.id !== env.id && machine.online && machine.info?.remoteHelpers === true)];
  const targetEnv = hosts.find((machine) => machine.id === target) ?? env;
  const away = targetEnv.id !== env.id;
  const offered = offeredOf(agents, away ? null : parent.profileId);
  const agent = offered.find((candidate) => candidate.id === account);
  const savedDefaults = agent?.subagentDefaults ?? catalog?.subagentDefaults ?? {};
  // Match the server: keep the parent's model on the same CLI.
  const parentModel = agent?.engine === parent.engine ? parent.engineModel || parent.model : null;
  const fallbackModel = parentModel || catalog?.default || agent?.defaultModel || '';
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
    prefs: { ...catalog?.prefs, default: savedDefaults.model || parentModel || null, approved: catalog?.prefs?.approved ?? [] },
    defaults: { ...(catalog?.defaults ?? agent.defaults), ...savedDefaults },
    effort: savedDefaults.effort || catalog?.defaults?.effort || agent.defaults?.effort || catalog?.effort,
    // A helper's permissions are the account's, narrowed for a read-only
    // parent, and it never plans first. Its speed is not a choice here.
    modes, defaultMode: modes.find((m) => m.id === (savedDefaults.mode || catalog?.defaults?.mode || agent.defaultMode))?.id ?? modes[0]?.id ?? null,
    speeds: [], speedByModel: {},
  } : null;
  const picked = { engine: agent?.engine ?? '', profileId: account, model: selectedModel, effort, mode } as Session;
  const prefs = trayPrefs({ client, env: targetEnv.id, engine: agent?.engine ?? '', profileId: account || null,
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
    const result = await client.rpc<{ subagentDefaults: SubagentDefaults }>(targetEnv.id, 'profile.defaults', {
      profileId: account, scope: 'subagent', [kind]: value || null,
    }, 15_000);
    setAgents((all) => all.map((candidate) => candidate.id === account || agent.account && candidate.account === agent.account
      ? { ...candidate, subagentDefaults: result.subagentDefaults } : candidate));
    setCatalog((now) => {
      if (!now) return now;
      const updated = { ...now, subagentDefaults: result.subagentDefaults };
      void saveModels(targetEnv.id, account, updated);
      return updated;
    });
  };
  const controls = Controls({ options, session: picked, busy, onPick: pick, ...prefs, onDefault, defaultsFor: 'subagents' });
  const accountName = (candidate: CliAgent) => candidate.label || candidate.id;

  useEffect(() => {
    if (!liveTeam.length || firstList.current) return;
    firstList.current = true;
    if (reviewAttention) {
      // Open the helper that needs the owner, at any depth: a failure two
      // levels down shows that helper and its reason, not only its lead.
      const all = liveTeam.map((m) => m.session);
      const unseen = (s: Session) => failureUnseen(s, remote);
      const tasks = liveTeam.filter((m) => m.depth === 0).map((m) => m.session);
      const attention = all.find((s) => stateOf(s) === 'blocked') ?? all.find((s) => stateOf(s) === 'error' && unseen(s))
        ?? tasks.find((s) => s.team?.blocked || s.team?.failed);
      if (attention) {
        // Unfold its leads, so a nested helper is in view.
        const leads = new Set<string>();
        for (let at: Session | undefined = attention; at?.delegation?.parentId && !leads.has(at.delegation.parentId);) {
          const lead: string = at.delegation.parentId;
          leads.add(lead);
          at = all.find((s) => s.id === lead);
        }
        if (leads.size) setExpanded((now) => new Set([...now, ...leads]));
        select(attention.id); setFocus(attention.id);
      }
      else onNativeAttention?.();
    }
  }, [liveTeam]);

  const loadAgents = async (refresh = false) => {
    setLoading(true); setError(null);
    try {
      // Account discovery must not enumerate every installed CLI's models.
      // Only the chosen account needs a catalog, loaded independently below.
      const listing = await client.rpc<{ agents: CliAgent[] }>(targetEnv.id, 'agent.list', { refresh, models: false }, 60_000);
      setAgents(listing.agents);
      const offer = offeredOf(listing.agents, away ? null : parent.profileId);
      setAccount((current) => offer.some((candidate) => candidate.id === current && candidate.available)
        ? current : (offer.find((candidate) => candidate.id === parent.profileId && candidate.available)?.id
          ?? offer.find((candidate) => candidate.available && candidate.engine === parent.engine)?.id
          ?? offer.find((candidate) => candidate.available)?.id ?? ''));
    } catch (failure: any) { fail('form')(failure); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (!nativeOnly) { setAgents([]); void loadAgents(); } }, [client, targetEnv.id, nativeOnly]);
  useEffect(() => { setModel(null); setMode(''); setEffort(''); }, [account]);
  // The chosen account's catalogue, from this machine.
  useEffect(() => {
    setCatalog(null);
    if (!account || nativeOnly) return;
    let stale = false;
    loadModels(targetEnv.id, account).then((cached) => { if (!stale && cached) setCatalog((now) => now ?? cached); });
    const refresh = followModelRefresh(
      (settled) => client.rpc<ModelList>(targetEnv.id, 'model.list', { profileId: account, ...(settled ? { settled } : {}) }, 30_000),
      (list) => {
        if (!Array.isArray(list?.models)) return;
        setCatalog(list); void saveModels(targetEnv.id, account, list);
      },
      () => { /* the cached list or parent's model still shows */ },
    );
    return () => { stale = true; refresh.stop(); };
  }, [client, targetEnv.id, account, nativeOnly]);

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
        const child = sessions.find((s) => s.id === selected);
        const reply = await client.rpc<DelegationResult>(child?.removed ? child.delegation?.parentMachine || env.id : envOf(selected), 'session.delegation-result', { id: selected });
        if (stale) return;
        setResult(reply);
        if (reply.pending) {
          const history = await client.rpc<{ pending: Permission[] }>(envOf(selected), 'session.events', { id: selected, tail: 1 });
          if (!stale) setPermissions(history.pending ?? []);
        } else setPermissions([]);
        if (!reply.complete) timer = setTimeout(load, 2500);
      } catch (failure: any) { if (!stale) fail(selected)(failure); }
    };
    void load();
    return () => { stale = true; clearTimeout(timer); };
  }, [client, env.id, selected, revision, remoteKey]);

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
  // An older machine drops what it does not know, so it is not offered there.
  const canAttachFiles = env.info?.helperAttachments === true && targetEnv.info?.helperAttachments === true;
  const seesImages = options?.imagesByModel?.[selectedModel] ?? options?.images ?? true;
  const attach = async (chosen: File[]) => {
    if (!chosen.length) return;
    setError(null);
    setPreparing((count) => count + 1);
    const failures: string[] = [];
    const ready: typeof files = [];
    try {
      for (const file of chosen) {
        try {
          const prepared = await prepareAttachment(file);
          if (isImageAttachment(prepared) && !seesImages) failures.push(`${file.name || 'image'}: this model cannot see images`);
          else ready.push(prepared);
        } catch (failure) { failures.push(`${file.name || 'file'}: ${errorMessage(failure, { fallback: 'Helm cannot read the file.' })}`); }
      }
      if (ready.length) setFiles((all) => [...all, ...ready]);
      if (failures.length) setError({ text: `Not added: ${failures.join('; ')}`, at: 'form' });
    } finally { setPreparing((count) => Math.max(0, count - 1)); }
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!canAttachFiles) return;
    const pasted = clipboardFiles(event.clipboardData);
    if (!pasted.length) return;
    event.preventDefault();
    void attach(pasted);
  };
  const onDrop = (event: DragEvent) => {
    if (!canAttachFiles || !event.dataTransfer?.files.length) return;
    event.preventDefault();
    void attach(Array.from(event.dataTransfer.files));
  };
  const start = async () => {
    if (!agent?.available || !task.trim() || busy || preparing) return;
    setBusy(true); setError(null);
    try {
      const { session } = await client.rpc<{ session: Session }>(env.id, 'session.delegate', {
        id: parent.id, profileId: account, model: model || undefined,
        ...(effort ? { effort } : {}), mode: mode || undefined, task: task.trim(),
        ...(files.length ? { attachments: files.map((file) => ({ filename: file.name, mime: file.mime, data: file.data })) } : {}),
        ...(away ? { machine: targetEnv.id } : {}),
      }, 120_000);
      setTask(''); setFiles([]); setComposing(false); setChoosingAccount(false); controls.close();
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
  const answer = async (permission: Permission, decision: Decision) => {
    setSending(true); setError(null);
    try {
      await client.rpc(envOf(selected), 'session.answer', { id: selected, requestId: permission.requestId, decision });
      setPermissions((all) => all.filter((item) => item.requestId !== permission.requestId));
      bump();
    } catch (failure: any) { fail(selected)(failure); }
    finally { setSending(false); }
  };
  const stop = (child: Session) => act('stop', async () => {
    await client.rpc(envOf(child.id), 'session.interrupt', { id: child.id });
    setNotice('Helm sent the stop request.');
    bump();
  });
  const retry = (child: Session) => act('retry', async () => {
    const { session } = await client.rpc<{ session: Session }>(env.id, 'session.delegate', {
      id: parent.id, profileId: child.profileId, model: child.delegation?.requestedModel || undefined,
      effort: child.effort || undefined,
      mode: child.mode && child.mode !== 'plan' ? child.mode : undefined, task: child.delegation?.task || child.title,
      ...(envOf(child.id) !== env.id ? { machine: envOf(child.id) } : {}),
    }, 120_000);
    added(session);
  });
  const hide = (child: Session) => act('hide', async () => {
    await client.rpc(envOf(child.id), 'session.archive', { id: child.id, archived: true });
    setSessions((all) => all.filter((item) => item.id !== child.id));
    setSelected(''); setFocus('new');
  });
  // Enter sends and Shift+Enter makes a new line, as in the chat. A phone
  // keyboard has no Shift+Enter, so there Return stays a new line.
  const submitOnEnter = (submit: () => void) => (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
    if (!touch || event.metaKey || event.ctrlKey) { event.preventDefault(); submit(); }
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
      {result?.error && <p className="error">{errorMessage(result.error, { machine: nameOf(envOf(child.id)) })}</p>}
      {result?.truncated && <p className="note">Showing the most recent output.</p>}
      <div className="delegation-actions">
        {onOpen && !child.removed && !offline(child) && <button type="button" className="ghost" onClick={() => onOpen(child, envOf(child.id))}>Open chat</button>}
        {complete && !child.removed ? <>
          {['error', 'interrupted'].includes(state) && <button type="button" className="ghost" disabled={!!acting} onClick={() => void retry(child)}>
            {acting === 'retry' ? 'Retrying…' : 'Retry task'}</button>}
          <button type="button" className="ghost" disabled={!!acting} onClick={() => void hide(child)}>{acting === 'hide' ? 'Hiding…' : 'Hide task'}</button>
        </> : !complete && <button type="button" className="ghost destructive" disabled={!!acting} onClick={() => void stop(child)}>
          {acting === 'stop' ? 'Stopping…' : 'Stop helper'}</button>}
      </div>
      {notice && <p className="note" role="status">{notice}</p>}
      {errorBox(child.id)}
    </div>;
  };

  const row = (child: Session) => {
    const state = stateOf(child);
    const host = remoteOn.get(child.id);
    const where = host === env.id ? undefined : host;
    const open = selected === child.id;
    const nested = sessions.filter((s) => !s.archived && s.delegation?.parentId === child.id);
    const unfolded = expanded.has(child.id);
    const label = STATUS[state] || state;
    const toggle = () => select(open ? '' : child.id);
    return <li key={child.id} className={`delegation-branch${open ? ' selected' : ''}`}>
      <div className="delegation-row">
        <button type="button" className="delegation-task" title={nested.length ? 'Show helpers' : onOpen && !child.removed && !offline(child) ? 'Open helper chat' : undefined}
          onClick={() => nested.length ? setExpanded((now) => { const next = new Set(now); if (next.has(child.id)) next.delete(child.id); else next.add(child.id); return next; }) : child.removed ? toggle() : onOpen && !child.removed && !offline(child) ? onOpen(child, envOf(child.id)) : toggle()}
          aria-expanded={nested.length ? unfolded : undefined}>
          <EngineMark engine={child.engine} />
          <span className="grow"><b>{child.title}</b>{nested.length > 0 && <small>{nested.length} {nested.length === 1 ? 'helper' : 'helpers'} <Icon name={unfolded ? 'up' : 'down'} size={12} /></small>}<small>{offline(child) ? `${nameOf(where ?? '')} is offline`
            : [child.profileId, child.model || child.engineModel || 'Agent default', where && `on ${nameOf(where)}`].filter(Boolean).join(' · ')}</small></span>
        </button>
        <button type="button" className={`delegation-status state-${state}`} data-task={child.id} aria-label={`${label}, details`}
          aria-expanded={open} aria-controls={`task-detail-${child.id}`} onClick={toggle}>
          <i aria-hidden="true" />{label}<Icon name={open ? 'up' : 'down'} size={14} />
        </button>
      </div>
      {open && detail(child)}
      {unfolded && nested.length > 0 && <ul>{nested.map(row)}</ul>}
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
            value={task} disabled={busy} onChange={(event) => setTask(event.target.value)} onKeyDown={submitOnEnter(() => void start())}
            onPaste={onPaste} onDrop={onDrop} onDragOver={(event) => { if (canAttachFiles) event.preventDefault(); }} />
          {(files.length > 0 || preparing > 0) && <div className="attach-previews delegation-files">
            {files.map((file, index) => {
              const label = isImageAttachment(file) ? `Image ${files.slice(0, index + 1).filter(isImageAttachment).length}` : file.name;
              return <span key={index} className={`attach-preview${isImageAttachment(file) ? '' : ' file'}`} title={file.name}>
                {isImageAttachment(file) ? <img src={file.url} alt={label} /> : <span className="attach-file"><span className="attach-file-name">{file.name}</span></span>}
                <button type="button" aria-label={`Remove ${label}`} disabled={busy} onClick={() => setFiles((all) => all.filter((_, at) => at !== index))}>×</button>
              </span>;
            })}
            {preparing > 0 && <span className="note" role="status">Adding…</span>}
          </div>}
          <div className="delegation-chips">
            <span className="chips">
              {hosts.length > 1 && <button type="button" className={`chip-pick machine${choosingMachine ? ' on' : ''}`} disabled={busy}
                aria-label={`Machine: ${targetEnv.name}`}
                onClick={() => { controls.close(); setChoosingAccount(false); setChoosingMachine(!choosingMachine); }}>
                <span className="chip-label">{targetEnv.name}</span>
              </button>}
              <button type="button" className={`chip-pick account${choosingAccount ? ' on' : ''}`} disabled={busy || (loading && !agents.length)}
                aria-label={`Agent account: ${agent ? accountName(agent) : loading ? 'finding accounts' : 'none available'}`}
                onClick={() => { controls.close(); setChoosingMachine(false); setChoosingAccount(!choosingAccount); }}>
                {agent && <EngineMark engine={agent.engine} />}
                <span className="chip-label">{agent ? accountName(agent) : loading ? 'Finding accounts…' : 'No account'}</span>
              </button>
              {agent?.available && <span className="delegation-chip-rest" onClickCapture={() => setChoosingAccount(false)}>{controls.chips}</span>}
            </span>
          </div>
          {choosingMachine ? <ChoiceSheet title="Run the helper on" current={targetEnv.id} busy={busy}
            choices={hosts.map((machine) => ({ id: machine.id, label: machine.name, hint: machine.id === env.id ? 'this chat\'s machine' : 'uses its own accounts' }))}
            onPick={(id) => { setChoosingMachine(false); if (id !== targetEnv.id) { setTarget(id); setAccount(''); } }}
            onClose={() => setChoosingMachine(false)} />
            : choosingAccount ? <ChoiceSheet title={`Agent account on ${targetEnv.name}`} current={account} busy={busy}
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
            {canAttachFiles && <>
              <input ref={fileRef} type="file" multiple hidden onChange={(event) => { if (event.target.files?.length) void attach(Array.from(event.target.files)); event.target.value = ''; }} />
              <button type="button" className="ghost delegation-attach" disabled={busy} title="Attach files or images" aria-label="Attach files or images" onClick={() => fileRef.current?.click()}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
            </>}
            <button type="button" className="ghost" disabled={busy} onClick={() => { setComposing(false); setFiles([]); setFocus('new'); }}>Cancel</button>
            <button className="primary" disabled={busy || loading || preparing > 0 || !agent?.available || !task.trim()}>{busy ? 'Starting…' : 'Start helper'}</button>
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
