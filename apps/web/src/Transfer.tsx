import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type Client, type Environment, type Session,
  type TransferPreview, type TransferReadiness, type TransferResult,
} from './client';
import { bytes } from './format';
import { BackIcon, Icon } from './Icon';
import { Route } from './Route';

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

export function TransferView({ client, source, envs, folder, onBack, onOpenSession }: {
  client: Client;
  source: Environment;
  envs: Environment[];
  folder: string;
  onBack: () => void;
  onOpenSession: (envId: string, session: Session) => void;
}) {
  const targets = useMemo(
    () => envs.filter((e) => e.id !== source.id && e.online),
    [envs, source.id],
  );
  const [targetId, setTargetId] = useState('');
  const [includeEnv, setIncludeEnv] = useState(false);
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
  const needsAck = !!preflight?.requiresAcknowledgement;
  const envCanChoose = !!preflight && !previewing
    && (preflight.skipped > 0 || preflight.envFiles.length > 0 || includeEnv);
  const canSend = !!preview && !!target && !busy && !previewing && (!needsAck || ack);

  const send = async () => {
    if (!preview || !target) return;
    setBusy(true); setError(''); setResult(null); setRecheck(null);
    try {
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
          <h1>{receipt ? 'Project sent' : 'Send a project'}</h1>
          <span className="sub"><Route machine={source.name} folder={folder} /></span>
        </div>
      </div>

      <div className="scroll"><div className="pad column">
        {receipt ? (
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
              Files arrived, but no project commands were run. Install dependencies,
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

            <div className="section">send to</div>
            <div className="rows">
              {targets.map((t) => (
                <button
                  key={t.id}
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

            <label className={`check-row${envCanChoose ? '' : ' disabled'}`}>
              <input
                type="checkbox" checked={includeEnv} disabled={!envCanChoose}
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
            </label>

            <div className="field">
              <label className="field-label">
                Folder on the target <span className="quiet">optional</span>
                <input
                  className="custom" value={targetFolder} disabled={busy}
                  placeholder={`~/.helm/transfers/${preview?.rootName ?? leaf(folder)}`}
                  autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                  onChange={(e) => setTargetFolder(e.target.value)}
                />
              </label>
            </div>

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
              Nothing on {target?.name ?? 'the target'} is overwritten, and nothing is run.
            </p>
            {busy && <div className="banner">{step || 'working…'}</div>}
            {error && <div className="error">{error}</div>}
          </>
        )}
      </div></div>

      {!receipt && preview && (
        <div className="startbar">
          <button className="primary big" disabled={!canSend} onClick={send}>
            {busy ? 'sending…' : target ? `Send to ${target.name}` : 'Send'}
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
