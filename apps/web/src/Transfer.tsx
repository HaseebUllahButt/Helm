import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type Client, type Environment, type Session,
  type TransferPreview, type TransferReadiness, type TransferResult, type TaskTransferResult,
} from './client';
import { bytes } from './format';
import { BackIcon, Icon } from './Icon';
import { Route } from './Route';
import { TaskReturn } from './session/TaskReturn';
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

export function TransferView({ client, source, envs, folder, session, onBack, onOpenSession }: {
  client: Client;
  source: Environment;
  envs: Environment[];
  folder: string;
  session?: Session;
  onBack: () => void;
  onOpenSession: (envId: string, session: Session) => void;
}) {
  const [targetId, setTargetId] = useState('');
  const [locked, setLocked] = useState(false);
  const targets = useMemo(
    () => envs.filter((e) => e.id !== source.id && (e.online || (locked && e.id === targetId))),
    [envs, source.id, locked, targetId],
  );
  const [includeEnv, setIncludeEnv] = useState(!!session);
  const [task, setTask] = useState(!!session);
  const [prompt, setPrompt] = useState('');
  const [agents, setAgents] = useState<{ id: string; label: string; available: boolean }[]>([]);
  const [profileId, setProfileId] = useState('');
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
    if (!targets.some((t) => t.id === targetId)) setTargetId(targets[0]?.id ?? '');
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
    client.rpc<{ agents: { id: string; label: string; available: boolean }[] }>(targetId, 'agent.list', { models: false })
      .then(({ agents: found }) => {
        if (!live) return;
        const available = found.filter((agent) => agent.available);
        setAgents(available);
        setProfileId(available.find((agent) => agent.id === session?.profileId)?.id ?? available[0]?.id ?? '');
      })
      .catch((err) => { if (live) setError(err.message); })
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
        .catch((e) => { if (live) { setPreview(null); setError(e.message); } })
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
  const canSend = !!preview && !!target && !busy && !previewing && (!needsAck || ack)
    && (!task || (!!profileId && !agentsLoading && (!!session || !!prompt.trim())));

  const send = async () => {
    if (!preview || !target) return;
    setBusy(true); setError(''); setResult(null); setRecheck(null);
    try {
      if (task) {
        setLocked(true);
        setStep(session ? `pausing this task and sending it to ${target.name}` : `sending the task to ${target.name}`);
        const sent = await client.rpc<TaskTransferResult>(source.id, 'task.send', {
          handoffId, folder, sessionId: session?.id, targetMachineId: target.id,
          targetFolder: targetFolder.trim() || undefined, profileId,
          prompt, includeEnv: true, allowSkipped: true,
        }, 360_000);
        if (!sent.sent && sent.requiresAcknowledgement) {
          setLocked(false);
          setPreview((now) => now ? { ...now, preflight: sent.preflight } : now);
          setAck(false);
          setError('Review what stays behind, then confirm it.');
          return;
        }
        setTaskResult(sent);
        return;
      }
      setStep(`asking ${target.name} for a one-time invitation`);
      const invite = await client.transferInvite(target.id, source.id);
      setStep(`encrypting and sending to ${target.name}`);
      const r = await client.transferSend(source.id, {
        folder,
        targetMachineId: target.id,
        targetFolder: targetFolder.trim() || undefined,
        includeEnv,
        grant: invite.grant,
        allowSkipped: needsAck && ack,
      });
      if (!r.sent && r.requiresAcknowledgement) {
        setPreview((now) => now ? { ...now, preflight: r.preflight } : now);
        setError('review what stays behind, then confirm it');
        return;
      }
      setResult(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false); setStep('');
    }
  };

  const receipt = result?.receipt ?? null;
  const readiness = recheck ?? receipt?.readiness ?? null;

  const openTask = async () => {
    if (!taskResult?.receipt || !taskResult.targetMachineId) return;
    setBusy(true); setError('');
    try {
      const reply = await client.rpc<{ session: Session }>(taskResult.targetMachineId,
        'session.events', { id: taskResult.receipt.sessionId, tail: 1, limit: 1 });
      onOpenSession(taskResult.targetMachineId, reply.session);
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  };

  const checkAgain = async () => {
    if (!receipt || !result?.targetMachineId) return;
    setChecking(true); setError('');
    try {
      setRecheck(await client.transferVerify(result.targetMachineId, receipt.folder));
    } catch (e: any) {
      setError(e.message);
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
      setError(e.message);
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
                  ? 'The destination has accepted the task. You can close this laptop.'
                  : 'Another machine’s hub has stored the task for delivery when the destination reconnects.'}</span>
              </span>
            </div>
            {taskResult.receipt && <p className="note">{taskResult.receipt.files} files · {bytes(taskResult.receipt.bytes)} · {taskResult.route === 'direct' ? 'Direct WebRTC' : 'Via hub'}<br />{taskResult.receipt.folder}</p>}
            <p className="note">The destination agent checks project setup and recreates dependencies before continuing. Its progress and any questions appear in the destination thread.</p>
            <TaskReturn client={client} envId={source.id} transfer={{ ...returnState, handoffId, role: 'source',
              machineId: taskResult.targetMachineId!, machineName: taskResult.targetName! }} />
            {taskResult.warning && <div className="banner">{taskResult.warning}</div>}
            {error && <div className="error">{error}</div>}
            <div className="transfer-actions">
              {taskResult.receipt && <button className="primary big" disabled={busy} onClick={openTask}>Open task there</button>}
              {taskResult.status === 'queued' && <button className="primary big" disabled={busy} onClick={send}>Check / retry delivery</button>}
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
              <label className="field-label">Git origin
                <input className="custom" value={receipt.repository.remote} readOnly onFocus={(e) => e.target.select()} />
              </label>
              <p className="note">{receipt.repository.configured
                ? 'Origin is configured. Fetch or pull here using this machine’s GitHub login.'
                : receipt.repository.error}</p>
            </div>}

            {readiness && (
              <>
                <div className="section">
                  target readiness
                  <span className={`transfer-status ${readiness.status}`}>
                    {readiness.status === 'needs-setup' ? 'needs setup' : 'unverified'}
                  </span>
                </div>
                <Readiness readiness={readiness} />
              </>
            )}

            <p className="note">
              Files arrived{receipt.repository?.configured ? ' and Git origin was configured' : ''}. Install dependencies,
              start services and verify environment values only when you choose to.
            </p>
            {error && <div className="error">{error}</div>}
            <div className="transfer-actions">
              <button className="primary big" disabled={busy} onClick={openTerminal}>
                {busy ? 'opening…' : 'Open a terminal there'}
              </button>
              <button className="linkish" disabled={checking} onClick={checkAgain}>
                {checking ? 'checking…' : 'Check setup again'}
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
                {previewing ? <span>inspecting…</span> : (
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
                onChange={(event) => { setTask(event.target.checked); setIncludeEnv(event.target.checked); }} />
              <span>Send a task with this project<small>Start an agent on the destination and keep working there.</small></span>
            </label>}
            {task && <>
              <div className="field"><label className="field-label">{session ? 'Instructions for continuing' : 'Task'}
                <textarea className="custom" value={prompt} disabled={busy || locked} maxLength={32000} rows={4}
                  placeholder={session ? 'Continue where this conversation left off' : 'What should the agent do?'}
                  onChange={(event) => setPrompt(event.target.value)} />
              </label></div>
              {session && <p className="note">Sending pauses this thread, copies its current files and recent conversation, and starts a continuation on the destination.</p>}
            </>}
            {!task && preview?.git?.remote && <div className="field">
              <label className="field-label">Git origin
                <input className="custom" value={preview.git.remote} readOnly onFocus={(e) => e.target.select()} />
              </label>
              <p className="note">The origin URL travels with the files. Pull on the target using its GitHub login.</p>
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
                <div className="empty quiet">no other machines are online right now</div>
              )}
            </div>

            <details open={task ? undefined : true}><summary>Agent and destination options</summary>
            {task && <div className="field"><label className="field-label">Agent account on the destination
              <select className="custom" value={profileId} disabled={busy || locked || agentsLoading}
                onChange={(event) => setProfileId(event.target.value)}>
                {!agents.length && <option value="">{agentsLoading ? 'Loading accounts…' : 'No available agent accounts'}</option>}
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label || agent.id}</option>)}
              </select>
            </label></div>}

            {!task && <label className={`check-row${envCanChoose ? '' : ' disabled'}`}>
              <input
                type="checkbox" checked={includeEnv} disabled={!envCanChoose || busy || locked}
                onChange={(e) => setIncludeEnv(e.target.checked)}
              />
              <span>
                Include .env files
                <small>
                  {envCount
                    ? `${envCount} found. Encrypted in transit and written owner-only on ${target?.name ?? 'the target'}.`
                    : preflight?.skipped
                      ? 'Check to include any .env files that exist.'
                      : 'No .env files were found.'}
                </small>
              </span>
            </label>}

            <div className="field">
              <label className="field-label">
                Folder on the target <span className="quiet">optional</span>
                <input
                  className="custom" value={targetFolder} disabled={busy || locked}
                  placeholder={`~/.helm/transfers/${preview?.rootName ?? leaf(folder)}`}
                  autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                  onChange={(e) => setTargetFolder(e.target.value)}
                />
              </label>
            </div>

            </details>
            {task && <p className="note">Project files and .env are included automatically, encrypted end to end. Finished changes return here when this machine is online; conflicting local edits are kept for review.</p>}

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
                    <div className="note">+ {warnings.length - shownWarnings.length} more omission{warnings.length - shownWarnings.length === 1 ? '' : 's'}</div>
                  )}
                </div>
                {needsAck && (
                  <label className="check-row ack">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    <span>
                      I understand what stays behind
                      <small>Secrets, symlinks and sensitive files are not included unless the .env option above covers them.</small>
                    </span>
                  </label>
                )}
              </>
            )}

            <p className="note">
              What is left behind is decided by filename policy, not file contents.
              {task
                ? ' Project .env files travel encrypted. Agent logins and machine-wide credentials stay on each machine. No GitHub access is required. Wait for the destination to confirm the task is running before closing this laptop.'
                : ` Nothing on ${target?.name ?? 'the target'} is overwritten. Git origin is configured when available; project commands are not run.`}
            </p>
            {busy && <div className="banner">{step || 'working…'}</div>}
            {error && <div className="error">{error}</div>}
            {task && locked && error && <p className="note">Retry resumes this same handoff: {handoffId}. The original thread may already be paused.</p>}
          </>
        )}
      </div></div>

      {!receipt && !taskResult && preview && (
        <div className="startbar">
          <button className="primary big" disabled={!canSend} onClick={send}>
            {busy ? 'sending…' : target ? `${locked ? 'Retry' : task ? 'Send task' : 'Send'} to ${target.name}` : 'Send'}
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
      .catch((e) => setError(e.message))
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
      setError(e.message);
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
        {checking && !readiness && <div className="empty quiet">inspecting…</div>}
        {readiness && (
          <>
            <div className="section">
              readiness
              <span className={`transfer-status ${readiness.status}`}>
                {readiness.status === 'needs-setup' ? 'needs setup' : 'unverified'}
              </span>
            </div>
            <Readiness readiness={readiness} />
          </>
        )}
        <p className="note">
          This only reads project metadata. Nothing was installed, launched or verified end-to-end.
        </p>
        {error && <div className="error">{error}</div>}
        <div className="transfer-actions">
          <button className="primary big" disabled={busy || !env.online} onClick={openTerminal}>
            {busy ? 'opening…' : 'Open a terminal here'}
          </button>
          <button className="linkish" disabled={checking || !env.online} onClick={load}>
            {checking ? 'checking…' : 'Check again'}
          </button>
          <button className="linkish" onClick={onBack}>Done</button>
        </div>
      </div></div>
    </>
  );
}
