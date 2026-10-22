import type { SendJob } from '../client';
import { Icon } from '../Icon';
import { sendName, sendPercent, sending } from './store';

export function SendActivity({ jobs, onOpen }: { jobs: SendJob[]; onOpen: (job: SendJob) => void }) {
  const active = jobs.filter(sending);
  if (!active.length) return null;
  return <div className="send-activity" aria-label="Running sends">
    <div className="section">{active.length > 1 ? `${active.length} sends` : 'Sending'}</div>
    <div className="rows plain">{active.map(job => <button key={`${job.source.machineId}:${job.id}`} className="row" onClick={() => onOpen(job)}>
      <Icon name="transfer" size={15} /><span className="grow">
        <span className="rt"><span className="rt-text">{sendName(job)} → {job.target.name}</span></span>
        <span className="rm">{job.phase === 'finishing' ? 'Finishing…' : job.phase === 'preparing' ? 'Preparing…'
          : sendPercent(job) === null ? 'Sending…' : `${sendPercent(job)}%`}{job.eta !== null && job.phase === 'sending' ? ` · ${Math.ceil(job.eta)}s left` : ''}</span>
      </span>
    </button>)}</div>
  </div>;
}
export function SendNotice({ job, onOpen, onDismiss }: { job: SendJob; onOpen: () => void; onDismiss: () => void }) {
  return <div className="send-notice" role="status">
    <button className="linkish grow" title={`${sendName(job)} is on ${job.target.name}.`} onClick={onOpen}>View {sendName(job)} on {job.target.name}</button>
    <button className="iconbtn" aria-label="Dismiss send notification" onClick={onDismiss}><Icon name="close" size={15} /></button>
  </div>;
}
