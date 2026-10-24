import { errorMessage } from './errors';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type Client, type Environment, type Session,
  type TransferPreview, type TransferReadiness, type TransferResult, type TaskTransferResult,
} from './client';
import { bytes } from './format';
import { BackIcon, Icon } from './Icon';
import { Route } from './Route';
import { TaskReturn } from './session/TaskReturn';
import { SendView } from './send/SendView';
import type { SendJob } from './client';
import type { TaskReturnState } from './client';

const leaf = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

function readinessTone(status?: string) {
  if (status === 'pass') return 'pass';
  if (status === 'fail') return 'fail';
  return 'warn';
}

function Readiness({ readiness }: { readiness: TransferReadiness }) {
  return (
    <div className="transfer-readiness">
      {readiness.checks.map((c, i) => (
        <div key={`${c.code}-${i}`} className={`readiness-row ${readinessTone(c.status)}`}>
          <span className="readiness-mark">
            <Icon name={c.status === 'pass' ? 'check' : 'alert'} size={15} />
          </span>
          <span className="grow">
            <span className="rt">{c.message}</span>
            {c.path && <span className="rm">{c.path}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

type TransferProps = {
  client: Client; source: Environment; envs: Environment[]; folder: string; session?: Session; jobId?: string; initialTask?: boolean; initialTargetId?: string; initialIncludeEnv?: boolean;
  onBack: () => void; onOpenSession: (envId: string, session: Session) => void;
  onJob?: (job: SendJob) => void; onAgain?: () => void;
  onOpenFolder?: (machineId: string, path: string) => void;
  onStartChat?: (machineId: string, path: string) => void;
};
export function TransferView(props: TransferProps) {
  const [taskIntent, setTaskIntent] = useState<{ targetMachineId: string; includeEnv: boolean } | null>(null);
  return props.session || taskIntent ? <TaskTransferView {...props} initialTask
    initialTargetId={taskIntent?.targetMachineId} initialIncludeEnv={taskIntent?.includeEnv} />
    : <SendView {...props} onTask={setTaskIntent} />;
}

/** Task continuation still uses task.send; its folder copy is owned by the v2 engine. */
export function TaskTransferView({ client, source, envs, folder, session, onBack, onOpenSession, onJob, onAgain, onOpenFolder, onStartChat, initialTask, initialTargetId, initialIncludeEnv }: TransferProps) {
  const [targetId, setTargetId] = useState(initialTargetId ?? '');
  const [locked, setLocked] = useState(false);
  const targets = useMemo(
    () => envs.filter((e) => e.id !== source.id && (e.online || (locked && e.id === targetId))),
    [envs, source.id, locked, targetId],
  );
  const [includeEnv, setIncludeEnv] = useState(initialIncludeEnv ?? !!session);
  const [task, setTask] = useState(!!session || !!initialTask);
  const [prompt, setPrompt] = useState('');
  const [agents, setAgents] = useState<{ id: string; label: string; available: boolean; models?: string[]; defaultModel?: string | null }[]>([]);
  const [profileId, setProfileId] = useState('');
  const [model, setModel] = useState('');
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [taskResult, setTaskResult] = useState<TaskTransferResult | null>(null);
  const [returnState, setReturnState] = useState<TaskReturnState>({ status: 'waiting' });
  const [handoffId] = useState(() => Array.from(crypto.getRandomValues(new Uint8Array(12)),
    (value) => value.toString(16).padStart(2, '0')).join(''));
  const [targetFolder, setTargetFolder] = useState('');
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [previewing, setPreviewing] = useState(true);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [result, setResult] = useState<TransferResult | null>(null);
  const [recheck, setRecheck] = useState<TransferReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!targets.some((t) => t.id === targetId)) setTargetId(targets.find(t => t.name.toLowerCase() === 'vm')?.id ?? targets[0]?.id ?? '');
  }, [targets, targetId]);
  const target = targets.find((t) => t.id === targetId) ?? null;

  useEffect(() => {
    if (!taskResult) return;
    let live = true;
    const refresh = () => client.rpc<{ return: TaskReturnState }>(source.id, 'task.status', { handoffId })
      .then((reply) => { if (live) setReturnState(reply.return); }).catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [client, source.id, source.online, handoffId, taskResult]);

  useEffect(() => {
    if (!task || !targetId || locked) return;
    let live = true;
    setAgents([]); setProfileId(''); setAgentsLoading(true);
    client.rpc<{ agents: { id: string; label: string; available: boolean; models?: string[]; defaultModel?: string | null }[] }>(targetId, 'agent.list', { models: true }, 60_000)
      .then(({ agents: found }) => {
        if (!live) return;
        const available = found.filter((agent) => agent.available);
        setAgents(available);
        setModel('');
        setProfileId(available.find((agent) => agent.id === session?.profileId)?.id ?? available[0]?.id ?? '');
      })
      .catch((err) => { if (live) setError(errorMessage(err)); })
      .finally(() => { if (live) setAgentsLoading(false); });
    return () => { live = false; };
  }, [client, task, targetId, session?.profileId, locked]);

  useEffect(() => {
    let live = true;
    setPreviewing(true);
    setError('');
    setAck(false);
    setResult(null);
    setRecheck(null);
    const timer = setTimeout(() => {
      client.transferPreview(source.id, folder, includeEnv)
        .then((r) => { if (live) setPreview(r); })
        .catch((e) => { if (live) { setPreview(null); setError(errorMessage(e)); } })
        .finally(() => { if (live) setPreviewing(false); });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [client, source.id, folder, includeEnv]);

  const preflight = preview?.preflight ?? null;
  const envCount = includeEnv
    ? (preflight?.envFiles.length ?? 0)
    : (preflight?.warnings.filter((w) => w.code === 'env-omitted').length ?? 0);
  const warnings = (preflight?.warnings ?? []).filter((w) => w.code !== 'filename-policy');
  const shownWarnings = warnings.slice(0, 8);
  const needsAck = !task && !!preflight?.requiresAcknowledgement;
  const envCanChoose = !!preflight && !previewing
    && (preflight.skipped > 0 || preflight.envFiles.length > 0 || includeEnv);
  const bulk = preview?.bulk ?? null;
  const account = agents.find((agent) => agent.id === profileId);
  const canSend = !!preview && !!target && !busy && !previewing && (!needsAck || ack) && (task || !bulk)
    && (!task || (!!profileId && !agentsLoading && (!!session || !!prompt.trim())));

  const send = async () => {
    if (!preview || !target) return;
    setBusy(true); setError(''); setResult(null); setRecheck(null);
    try {
      if (task) {
        setLocked(true);
        setStep(session ? `Helm is pausing this task. Helm will send it to ${target.name}.` : `Helm is sending the task to ${target.name}.`);
        const request = {
          handoffId, folder, sessionId: session?.id, targetMachineId: target.id,
          targetFolder: targetFolder.trim() || undefined, profileId, model: model || undefined,
          prompt, includeEnv, allowSkipped: true,
        };
        let sent = await client.rpc<TaskTransferResult>(source.id, 'task.send', request, 360_000);
        // A big project copies in the background; the same request, asked
        // again, says how far it got and finally returns the running task.
        while (sent.status === 'copying') {
          const p = sent.progress;
          const percent = p?.percent ?? (p?.total ? Math.min(100, Math.round(p.bytes / p.total * 100)) : null);
          const rate = typeof p?.rate === 'number' ? `${bytes(p.rate)}/s` : p?.rate;
          setStep(p?.phase === 'pausing' ? 'Helm is pausing this task.'
            : p?.phase === 'starting' ? `Helm is starting the agent on ${target.name}.`
            : `Helm is copying files to ${target.name}: ${percent === null ? `${bytes(p?.bytes ?? 0)} sent` : `${percent}%`}${p?.total ? ` of ${bytes(p.total)}` : ''}${rate ? ` · ${rate}` : ''}`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          sent = await client.rpc<TaskTransferResult>(source.id, 'task.send', request, 360_000);
        }
        if (!sent.sent && sent.requiresAcknowledgement) {
          setLocked(false);
          setPreview((now) => now ? { ...now, preflight: sent.preflight } : now);
          setAck(false);
          setError('Review the files that stay here. Confirm your choice.');
          return;
        }
        setTaskResult(sent);
        return;
      }
    } catch (e: any) {
      setError(errorMessage(e));
    } finally {
      setBusy(false); setStep('');
    }
  };

  // Leaving task mode must use the same source-owned job flow as project sends.
  if (!task) return <SendView client={client} source={source} folder={folder}
    preferredTargetId={targetId} initialIncludeEnv={includeEnv} onBack={onBack}
    onJob={onJob} onAgain={onAgain} onOpenFolder={onOpenFolder} onStartChat={onStartChat}
    onTask={({ targetMachineId, includeEnv }) => { setTargetId(targetMachineId); setIncludeEnv(includeEnv); setTask(true); }} />;

  const receipt = result?.receipt ?? null;
  const readiness = recheck ?? receipt?.readiness ?? null;

  const openTask = async () => {
    if (!taskResult?.receipt || !taskResult.targetMachineId) return;
    setBusy(true); setError('');
    try {
      const reply = await client.rpc<{ session: Session }>(taskResult.targetMachineId,
        'session.events', { id: taskResult.receipt.sessionId, tail: 1, limit: 1 });
      onOpenSession(taskResult.targetMachineId, reply.session);
    } catch (err: any) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const checkAgain = async () => {
    if (!receipt || !result?.targetMachineId) return;
    setChecking(true); setError('');
    try {
      setRecheck(await client.transferVerify(result.targetMachineId, receipt.folder));
    } catch (e: any) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const openTerminal = async () => {
    if (!receipt || !result?.targetMachineId) return;
    setBusy(true); setError('');
    try {
      const r = await client.rpc<{ session: Session }>(result.targetMachineId, 'session.start', {
        cwd: receipt.folder,
        profileId: 'shell',
      }, 45_000);
      onOpenSession(result.targetMachineId, r.session);
    } catch (e: any) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles">
          <h1>{taskResult ? 'Task sent' : task ? 'Send task' : receipt ? 'Project sent' : 'Send a project'}</h1>
          <span className="sub"><Route machine={source.name} folder={folder} /></span>
        </div>
      </div>

      <div className="scroll"><div className="pad column">
        {taskResult ? (
          <>
            <div className="transfer-done">
              <span className="done-mark"><Icon name="check" size={18} /></span>
              <span className="grow">
                <span className="done-title">{taskResult.status === 'running' ? 'Running' : 'Queued'} on {taskResult.targetName}</span>
                <span className="done-sub">{taskResult.status === 'running'
                  ? 'The other machine has the task. You can close this laptop.'
                  : 'Helm will send the task when the other machine reconnects.'}</span>
              </span>
            </div>
            {taskResult.receipt && <p className="note" title={taskResult.route === 'direct' ? 'Sent directly' : 'Sent through home'}>{bulk ? `${bulk.files ?? ''} files and history · ${bytes(bulk.bytes)}` : `${taskResult.receipt.files} files · ${bytes(taskResult.receipt.bytes)}`}<br />{taskResult.receipt.folder}</p>}
            <p className="note">Open the new chat there to see progress and questions.</p>
            {!bulk && <TaskReturn client={client} envId={source.id} transfer={{ ...returnState, handoffId, role: 'source',
              machineId: taskResult.targetMachineId!, machineName: taskResult.targetName! }} />}
            {taskResult.warning && <div className="banner">{taskResult.warning}</div>}
            {error && <div className="error">{error}</div>}
            <div className="transfer-actions">
              {taskResult.receipt && <button className="primary big" disabled={busy} onClick={openTask}>Open task there</button>}
              {taskResult.status === 'queued' && <button className="primary big" disabled={busy} onClick={send}>Check or retry delivery</button>}
              <button className="linkish" onClick={onBack}>Done</button>
            </div>
          </>
        ) : receipt ? (
          <>
            <div className="transfer-done">
              <span className="done-mark"><Icon name="check" size={18} /></span>
              <span className="grow">
                <span className="done-title">Arrived on {result?.targetName}</span>
                <span className="done-sub">
                  {receipt.files} file{receipt.files === 1 ? '' : 's'} · {bytes(receipt.bytes)}
                  {includeEnv && preflight?.envFiles.length
                    ? ` · ${preflight.envFiles.length} .env file${preflight.envFiles.length === 1 ? '' : 's'}`
                    : ''}
                </span>
              </span>
            </div>

            <div className="field">
              <label className="field-label">
                Folder on {result?.targetName}
                <input className="custom" value={receipt.folder} readOnly onFocus={(e) => e.target.select()} />
              </label>
            </div>

            {receipt.repository && <div className="field">
              <label className="field-label">Git source address
                <input className="custom" value={receipt.repository.remote} readOnly onFocus={(e) => e.target.select()} />
              </label>
              <p className="note">{receipt.repository.configured
                ? 'The Git source address is set. Get updates with this machine’s GitHub login.'
                : errorMessage(receipt.repository.error, { fallback: 'Helm cannot prepare Git history. Try again.' })}</p>
            </div>}

            {readiness && (
              <>
                <div className="section">
                  Machine setup
                  <span className={`transfer-status ${readiness.status}`}>
                    {readiness.status === 'needs-setup' ? 'needs setup' : 'Not checked'}
                  </span>
                </div>
                <Readiness readiness={readiness} />
              </>
            )}

            <p className="note">
              The files arrived. Helm did not install or start anything.
            </p>
            {error && <div className="error">{error}</div>}
            <div className="transfer-actions">
              <button className="primary big" disabled={busy} onClick={openTerminal}>
                {busy ? 'Helm is opening the terminal.' : 'Open a terminal there'}
              </button>
              <button className="linkish" disabled={checking} onClick={checkAgain}>
                {checking ? 'Helm is checking the setup.' : 'Check setup again'}
              </button>
              <button className="linkish" onClick={onBack}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="transfer-hero">
              <div className="transfer-name">{preview?.rootName ?? leaf(folder)}</div>
              <div className="transfer-path">{folder}</div>
              <div className="transfer-stats">
                {previewing ? <span>Helm is checking files.</span> : (
                  <>
                    <span><b>{preflight?.files ?? 0}</b> files</span>
                    <span>{bytes(preflight?.bytes ?? 0)}</span>
                    {envCount > 0 && <span>{envCount} .env file{envCount === 1 ? '' : 's'}</span>}
                    {(preflight?.skipped ?? 0) > 0 && <span>{preflight!.skipped} stays behind</span>}
                  </>
                )}
              </div>
            </div>

            {!session && <label className="check-row">
              <input type="checkbox" checked={task} disabled={busy || locked}
                onChange={(event) => { setTask(event.target.checked); }} />
              <span>Send a task with this project<small>Start an agent on the other machine. Continue the work there.</small></span>
            </label>}
            {task && <>
              <div className="field"><label className="field-label">{session ? 'Instructions for continuing' : 'Task'}
                <textarea className="custom" value={prompt} disabled={busy || locked} maxLength={32000} rows={4}
                  placeholder={session ? 'Continue this chat’s work' : 'Describe the task'}
                  onChange={(event) => setPrompt(event.target.value)} />
              </label></div>
              {session && <p className="note">Helm pauses this chat. Helm copies its files and recent messages. The chat continues on the other machine.</p>}
              {session && <button className="linkish" disabled={busy || locked} onClick={() => setTask(false)}>Send files only</button>}
            </>}
            {!task && preview?.git?.remote && <div className="field">
              <label className="field-label">Git source address
                <input className="custom" value={preview.git.remote} readOnly onFocus={(e) => e.target.select()} />
              </label>
              <p className="note">Get updates on the other machine with its GitHub login.</p>
            </div>}
            <div className="section">send to</div>
            <div className="rows">
              {targets.map((t) => (
                <button
                  key={t.id}
                  disabled={busy || locked}
                  className={`row tall${t.id === targetId ? ' active' : ''}`}
                  onClick={() => setTargetId(t.id)}
                >
                  <span className="glyph"><Icon name="machine" size={16} /></span>
                  <span className="grow">
                    <span className="rt"><span className="rt-text">{t.name}</span></span>
                    <span className="rm">{t.info.host ?? 'online'}</span>
                  </span>
                  {t.id === targetId && <span className="check"><Icon name="check" size={16} /></span>}
                </button>
              ))}
              {!targets.length && (
                <div className="empty quiet">No other machines are online.</div>
              )}
            </div>

            <details open={task ? undefined : true}><summary>Agent and machine options</summary>
            {task && <div className="field"><label className="field-label">Agent account on the other machine
              <select className="custom" value={profileId} disabled={busy || locked || agentsLoading}
                onChange={(event) => setProfileId(event.target.value)}>
                {!agents.length && <option value="">{agentsLoading ? 'Loading accounts…' : 'No agent accounts available'}</option>}
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label || agent.id}</option>)}
              </select>
            </label></div>}
            {task && !!account?.models?.length && <div className="field"><label className="field-label">Model
              <select className="custom" value={model} disabled={busy || locked}
                onChange={(event) => setModel(event.target.value)}>
                <option value="">{account.defaultModel ? `Account default (${account.defaultModel})` : 'Account default'}</option>
                {account.models.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label></div>}

            <label className={`check-row${envCanChoose ? '' : ' disabled'}`}>
              <input
                type="checkbox" checked={includeEnv} disabled={!envCanChoose || busy || locked}
                onChange={(e) => setIncludeEnv(e.target.checked)}
              />
              <span>
                Include .env files
                <small>
                  {envCount
                    ? `${envCount} found. Helm encrypts these files to protect them during sending. ${bulk ? 'File access rules stay the same' : 'Only the file owner can read them'} on ${target?.name ?? 'the other machine'}.`
                    : preflight?.skipped
                      ? 'Select this option to include .env files.'
                      : 'Helm found no .env files.'}
                </small>
              </span>
            </label>

            <div className="field">
              <label className="field-label">
                Folder on the other machine <span className="quiet">optional</span>
                <input
                  className="custom" value={targetFolder} disabled={busy || locked}
                  placeholder={bulk && task ? `~/${preview?.rootName ?? leaf(folder)}` : `~/.helm/transfers/${preview?.rootName ?? leaf(folder)}`}
                  autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                  onChange={(e) => setTargetFolder(e.target.value)}
                />
              </label>
            </div>

            </details>
            {task && !bulk && <p className="note">Helm encrypts project files and .env files to protect them during sending. Finished changes return here. Helm keeps your edits here.</p>}
            {task && bulk && <p className="note">Helm sends this large project with its Git history. Sending continues after connection loss. Git keeps the work on the other machine.</p>}
            {!task && bulk && <div className="banner">This project needs its history. Select “Send a task with this project” to send both.</div>}

            {warnings.length > 0 && (
              <>
                <div className="section attention">review before sending</div>
                <div className="transfer-warnings">
                  {shownWarnings.map((w, i) => (
                    <div key={`${w.code}-${w.path ?? i}`} className="transfer-warning">
                      <span className="warn-mark">!</span>
                      <span className="grow">
                        <span className="rt">{w.message}</span>
                        {w.path && <span className="rm">{w.path}</span>}
                      </span>
                    </div>
                  ))}
                  {warnings.length > shownWarnings.length && (
                    <div className="note">+ {warnings.length - shownWarnings.length} more skipped item{warnings.length - shownWarnings.length === 1 ? '' : 's'}</div>
                  )}
                </div>
                {needsAck && (
                  <label className="check-row ack">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    <span>
                      I understand which files stay here
                      <small>Private files and file links stay here unless the .env option includes them.</small>
                    </span>
                  </label>
                )}
              </>
            )}

            <p className="note">
              {task
                ? 'Logins stay on each machine. Wait until the task is running before you close this laptop.'
                : `Helm keeps existing files on ${target?.name ?? 'the other machine'}. Helm does not run project commands.`}
            </p>
            {busy && <div className="banner">{step || 'Helm is sending the task.'}</div>}
            {error && <div className="error">{error}</div>}
            {task && locked && error && <p className="note" title={handoffId}>Retry continues the same send. Check whether the chat has paused.</p>}
          </>
        )}
      </div></div>

      {!receipt && !taskResult && preview && (
        <div className="startbar">
          <button className="primary big" disabled={!canSend} onClick={send}>
            {busy ? 'Helm is sending the task.' : target ? `${locked ? 'Retry' : task ? 'Send task' : 'Send'} to ${target.name}` : 'Send'}
          </button>
        </div>
      )}
    </>
  );
}

/** `helm verify`, drawn rather than typed: static checks only, never a run. */
export function VerifyView({ client, env, folder, onBack, onOpenSession }: {
  client: Client;
  env: Environment;
  folder: string;
  onBack: () => void;
  onOpenSession: (envId: string, session: Session) => void;
}) {
  const [readiness, setReadiness] = useState<TransferReadiness | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setChecking(true); setError('');
    client.transferVerify(env.id, folder)
      .then(setReadiness)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setChecking(false));
  }, [client, env.id, folder]);
  useEffect(load, [load]);

  const openTerminal = async () => {
    setBusy(true); setError('');
    try {
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start', {
        cwd: folder,
        profileId: 'shell',
      }, 45_000);
      onOpenSession(env.id, r.session);
    } catch (e: any) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>Check setup</h1><span className="sub"><Route machine={env.name} folder={folder} /></span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <div className="transfer-hero">
          <div className="transfer-name">{leaf(folder)}</div>
          <div className="transfer-path">{folder}</div>
        </div>
        {checking && !readiness && <div className="empty quiet">Helm is checking files.</div>}
        {readiness && (
          <>
            <div className="section">
              Machine setup
              <span className={`transfer-status ${readiness.status}`}>
                {readiness.status === 'needs-setup' ? 'needs setup' : 'Not checked'}
              </span>
            </div>
            <Readiness readiness={readiness} />
          </>
        )}
        <p className="note">
          Helm only reads project files. Helm did not install or start anything.
        </p>
        {error && <div className="error">{error}</div>}
        <div className="transfer-actions">
          <button className="primary big" disabled={busy || !env.online} onClick={openTerminal}>
            {busy ? 'Helm is opening the terminal.' : 'Open a terminal here'}
          </button>
          <button className="linkish" disabled={checking || !env.online} onClick={load}>
            {checking ? 'Helm is checking the setup.' : 'Check again'}
          </button>
          <button className="linkish" onClick={onBack}>Done</button>
        </div>
      </div></div>
    </>
  );
}
