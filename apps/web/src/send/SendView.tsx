import { useEffect, useRef, useState } from 'react';
import type { Client, Environment, SendJob, SendPlan } from '../client';
import { BackIcon } from '../Icon';
import { bytes } from '../format';
import { sendName, sendPercent, sendTime, sending, useSends } from './store';

/** A future device upload adapter can supply its own picker/plan, then reuse SendProgress. */
export type MachineSendSource = { kind: 'machine'; machine: Environment; path: string };
type Props = {
  client: Client; source: Environment; folder: string; jobId?: string;
  initialIncludeEnv?: boolean; preferredTargetId?: string;
  onTask?: (options: { targetMachineId: string; includeEnv: boolean }) => void;
  onBack: () => void; onJob?: (job: SendJob) => void; onAgain?: () => void;
  onOpenFolder?: (machineId: string, path: string) => void;
  onStartChat?: (machineId: string, path: string) => void;
};
const leaf = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;
const parent = (path: string) => path.replace(/\/[^/]+\/?$/, '') || '/';
const phaseWords: Record<SendJob['phase'], string> = {
  preparing: 'Preparing…', sending: 'Sending…', finishing: 'Finishing…', done: 'Sent',
  failed: 'Send stopped', interrupted: 'Send interrupted', cancelled: 'Cancelled',
};
const count = (n: number) => n.toLocaleString();
function LeftBehind({ left }: { left: SendJob['left'] }) {
  if (!left.length) return null;
  return <details className="send-details"><summary>What stays here</summary>
    <div className="rows plain">{left.map((item, i) => <div className="row" key={`${item.path}:${i}`}>
      <span className="grow"><span className="rt send-path">{item.path}</span><span className="rm">{item.why}</span></span>
    </div>)}</div>
  </details>;
}
export function SendProgress({ job }: { job: SendJob }) {
  const percent = sendPercent(job);
  return <div className="send-progress">
    <h2 className="screen-title" role="status">{phaseWords[job.phase]}</h2>
    <div className="send-progress-line" role="progressbar" aria-label="Files sent"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
      aria-valuetext={percent === null ? 'Total size not known yet' : `${percent}% · ${phaseWords[job.phase]}`}>
      <span style={{ width: percent === null ? '0%' : `${percent}%` }} />
    </div>
    <p className="readout">{bytes(job.bytes.sent)}{job.bytes.total !== null ? ` of ${bytes(job.bytes.total)}` : ' sent'}
      {percent !== null ? ` · ${percent}%` : ''}</p>
    <p className="note">{count(job.files.sent)}{job.files.total !== null ? ` of ${count(job.files.total)}` : ''} files
      {job.rate !== null ? ` · ${bytes(job.rate)}/s` : ''}
      {job.eta !== null ? ` · ${Math.ceil(job.eta)}s left` : sending(job) ? ' · Estimating time…' : ''}</p>
    {job.again && <p className="note">{job.changed
      ? `${count(job.changed.files)} changed files · ${bytes(job.changed.bytes)}` : 'Only changes are being sent.'}</p>}
  </div>;
}
export function SendView({ client, source, folder, jobId: initialJobId, onBack, onJob, onAgain, onOpenFolder, onStartChat, initialIncludeEnv = true, preferredTargetId, onTask }: Props) {
  const { store, jobs, errors } = useSends(client, [source]);
  const [jobId, setJobId] = useState(initialJobId);
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [targetId, setTargetId] = useState('');
  const [includeEnv, setIncludeEnv] = useState(initialIncludeEnv);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'start' | 'cancel' | 'retry'>('');
  const [uncertain, setUncertain] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const mutating = useRef(false);
  const intent = useRef<{ path: string; target: string; at: number } | null>(null);
  const callback = useRef(onJob); callback.current = onJob;
  const job = jobs.find(item => item.source.machineId === source.id && (jobId ? item.id === jobId
    : (item.source.path === folder || item.source.path === plan?.path) && (sending(item)
      || !!intent.current && item.target.machineId === intent.current.target && sendTime(item.createdAt) >= intent.current.at - 1000)));
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [job?.id, job?.phase === 'done']);
  const target = plan?.targets.find(item => item.machineId === targetId);
  const again = !!target?.sentBefore;

  useEffect(() => {
    if (initialJobId) { setJobId(initialJobId); void store.status(source.id, initialJobId); }
  }, [initialJobId, source.id, store]);
  useEffect(() => {
    if (!job || jobId || busy) return;
    setJobId(job.id); setUncertain(false); setError(''); callback.current?.(job);
  }, [job, jobId, busy]);
  useEffect(() => {
    if (jobId || job) { setLoading(false); return; }
    let live = true;
    setLoading(true); setError('');
    client.sendPlan(source.id, folder).then(reply => {
      if (!live) return;
      setPlan(reply);
      setTargetId(reply.targets.some(item => item.machineId === preferredTargetId) ? preferredTargetId! : reply.defaultTarget ?? reply.targets.find(item => item.online)?.machineId ?? reply.targets[0]?.machineId ?? '');
    }).catch(() => { if (live) setError(`Couldn't check ${leaf(folder)} on ${source.name}. Try again.`); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [client, source.id, folder, attempt, jobId, !!job, preferredTargetId]);

  const remember = (next: SendJob) => {
    store.accept(next);
    if (mounted.current) { setJobId(next.id); callback.current?.(next); }
  };
  const start = async () => {
    if (!plan || !target || mutating.current || uncertain) return;
    mutating.current = true; intent.current = { path: plan.path, target: target.machineId, at: Date.now() }; setBusy('start'); setError('');
    try {
      const { job } = await client.sendStart(source.id, { path: plan.path, targetMachineId: target.machineId,
        destination: target.destination, includeEnv });
      remember(job);
    } catch {
      // An unacknowledged start may already be running. Discover it; never automatically start a second job.
      setUncertain(true); setError(`Couldn't confirm the send. Check its status before sending again.`);
      await store.refresh(source.id);
    } finally { mutating.current = false; setBusy(''); }
  };
  const action = async (kind: 'cancel' | 'retry') => {
    if (!job || mutating.current) return;
    mutating.current = true; setBusy(kind); setError('');
    try {
      const { job: next } = await (kind === 'cancel' ? client.sendCancel(source.id, job.id) : client.sendRetry(source.id, job.id));
      remember(next);
    } catch { setError(`Couldn't ${kind === 'cancel' ? 'stop' : 'resume'} the send. Check the connection and try again.`); }
    finally { mutating.current = false; setBusy(''); }
  };
  const sendAgain = () => {
    if (job) store.dismiss(job.id);
    intent.current = null; setJobId(undefined); setPlan(null); setAttempt(value => value + 1); setError(''); setUncertain(false);
    // The finished job stays in the shared history; a fresh plan remembers its destination.
    onAgain?.();
  };
  const title = job?.phase === 'done' ? 'Sent' : job?.phase === 'cancelled' ? 'Cancelled' : again || job?.again ? 'Send again' : 'Send';
  return <>
    <div className="bar"><button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
      <div className="titles"><h1>{title}</h1><span className="sub">{source.name}</span></div></div>
    <div className="scroll" ref={scroll}><div className="pad column send-view">
      <div className="send-context"><h2 className="screen-title">{job ? sendName(job) : plan?.name ?? leaf(folder)}</h2>
        <p className="note send-path">{job?.source.path ?? folder}</p></div>
      {job ? <>
        <div className="send-destination"><strong className="send-path">{job.phase === 'done' ? `On ${job.target.name} in ${job.target.path}` : `To ${job.target.name}`}</strong>
          {job.phase !== 'done' && <p className="note send-path">{job.target.path}</p>}</div>
        {job.phase === 'done' ? <>
          <p className="readout">{job.again && job.changed?.files === 0 ? 'Already up to date.'
            : job.changed ? `${count(job.changed.files)} changed files · ${bytes(job.changed.bytes)}`
            : `${count(job.files.sent)} files · ${bytes(job.bytes.sent)}`}</p>
          <p className="note">Files stay on {job.source.name}.</p>
          <div className="send-actions">
            {onOpenFolder && <button className="primary big" onClick={() => onOpenFolder(job.target.machineId,
              job.source.kind === 'file' ? parent(job.target.path) : job.target.path)}>Open folder there</button>}
            {onStartChat && <button className="linkish" onClick={() => onStartChat(job.target.machineId,
              job.source.kind === 'file' ? parent(job.target.path) : job.target.path)}>Start a chat there</button>}
            <button className="linkish" onClick={sendAgain}>Send again</button>
          </div>
        </> : <>
          <SendProgress job={job} />
          {job.error && <p className="error" role="alert">{job.error}</p>}
          {job.phase === 'cancelled' && <p className="note">The send stopped. Retry to continue to the same place.</p>}
          {job.phase === 'interrupted' && <p className="note">The source stopped before the send finished. Retry to continue.</p>}
          {sending(job) ? <button className="linkish send-stop" disabled={!!busy} onClick={() => void action('cancel')}>
            {busy === 'cancel' ? 'Stopping…' : 'Cancel send'}</button>
            : <button className="primary big" disabled={!!busy || !source.online} onClick={() => void action('retry')}>
              {busy === 'retry' ? 'Resuming…' : 'Retry'}</button>}
          <p className="note">You can leave this screen. {job.source.name} needs to stay on.</p>
        </>}
        {errors[source.id] && <p className="note" role="status">{errors[source.id]}</p>}
        <LeftBehind left={job.left} />
      </> : busy === 'start' ? <div className="send-progress" role="status"><h2 className="screen-title">Preparing…</h2>
        <p className="note">To {target?.name} · {target?.destination}</p><p className="note">You can leave this screen. {source.name} needs to stay on.</p></div>
      : initialJobId ? <><p role="status">{errors[source.id] || 'Getting send status…'}</p>
        <button className="linkish" onClick={() => void store.status(source.id, initialJobId)}>Check status</button></>
      : <>
        {loading ? <p role="status" className="note">Checking what to send…</p> : plan && <>
          <div className="send-destination"><div className="section"><span className="send-path">To {target?.name ?? 'another machine'}</span><span className="spacer" />
            {plan.targets.length > 1 && <button className="linkish" disabled={uncertain} aria-expanded={choosing} onClick={() => setChoosing(value => !value)}>Change</button>}</div>
            <p className="note send-path">{target?.destination ?? 'No other machines yet.'}</p>
            {choosing && <div className="rows plain">{plan.targets.map(item => <button className="row" key={item.machineId}
              disabled={uncertain} aria-pressed={item.machineId === targetId} onClick={() => { setTargetId(item.machineId); setChoosing(false); }}>
              <span className="grow"><span className="rt">{item.name}{item.online ? '' : ' · Offline'}</span>
                <span className="rm send-path">{item.destination}</span></span></button>)}</div>}
          </div>
          {again ? <p className="readout">Only changes will be sent.</p> : <p className="readout">{plan.estimate ? 'About ' : ''}{count(plan.files)} {plan.kind === 'file' ? 'file' : 'files'} · {bytes(plan.bytes)}</p>}
          {plan.git && !again && <p className="note">Project files and history included.</p>}
          {!!plan.envFiles.length && <label className="send-env"><input type="checkbox" disabled={uncertain} checked={includeEnv} onChange={event => setIncludeEnv(event.target.checked)} />
            <span>{plan.envFiles.length} environment {plan.envFiles.length === 1 ? 'file' : 'files'} {includeEnv ? 'included' : 'staying here'}</span></label>}
          <p className="note">Files stay on {source.name}.</p>
          <LeftBehind left={plan.left} />
          {onTask && <details className="send-details"><summary>Options</summary><button className="linkish" disabled={uncertain || !target?.online || !source.online} onClick={() => target && onTask({ targetMachineId: target.machineId, includeEnv })}>Send a task with these files</button></details>}
          {target && !target.online && <p className="note" role="status">{target.name} is offline. Try again when it is back.</p>}
          <div className="send-actions"><button className="primary big" disabled={!target?.online || !source.online || uncertain}
            onClick={() => void start()}>{again ? `Send again to ${target?.name ?? 'machine'}` : `Send to ${target?.name ?? 'machine'}`}</button></div>
        </>}
      </>}
      {error && <div className="error" role="alert">{error}</div>}
      {error && !job && !busy && (!plan || uncertain) && <button className={uncertain ? 'linkish' : 'primary big'}
        onClick={() => { if (uncertain) void store.refresh(source.id); else setAttempt(value => value + 1); }}>
        {uncertain ? 'Check status' : 'Retry'}</button>}
    </div></div>
  </>;
}
