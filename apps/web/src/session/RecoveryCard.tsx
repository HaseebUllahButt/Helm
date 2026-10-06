import { useState } from 'react';
import type { Session } from '../client';
import { Icon } from '../Icon';
import { plainProblem } from './problem';

/**
 * The task stopped and was not finished: what happened, in a sentence, and
 * the one thing to do about it. It sits above the message box, where the
 * eye already is when a turn ends, not at the top of a long thread. The
 * CLI's own words are kept behind "Details".
 */
export function RecoveryCard({ recovery, busy, offline, onRetry }: {
  recovery: NonNullable<Session['recovery']>;
  busy: boolean; offline: boolean;
  /** Absent while there is nothing to retry from here. */
  onRetry?: () => void;
}) {
  const [details, setDetails] = useState(false);
  // Hidden on this screen only; the next turn's outcome replaces it anyway.
  const [hiddenAt, setHiddenAt] = useState(0);
  if (hiddenAt === recovery.at) return null;
  const p = plainProblem(recovery.kind, recovery.message);
  const tone = recovery.kind === 'error' ? 'bad' : recovery.kind === 'limited' ? 'warn' : 'quiet';
  return (
    <div className={`recovery ${tone}`} role="status">
      <div className="recovery-top">
        <span className="recovery-icon"><Icon name={recovery.kind === 'interrupted' ? 'stop' : recovery.kind === 'restart' ? 'refresh' : 'alert'} size={16} /></span>
        <div className="recovery-copy">
          <b>{p.title}</b>
          <p>{p.text}</p>
        </div>
        <button className="recovery-x" aria-label="Hide" onClick={() => setHiddenAt(recovery.at)}><Icon name="close" size={14} /></button>
      </div>
      {details && p.raw && <pre className="recovery-raw">{p.raw}</pre>}
      {(p.raw || onRetry) && (
        <div className="recovery-actions">
          {p.raw && <button className="ghost" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'Hide details' : 'Details'}</button>}
          {onRetry && <button className="primary" disabled={busy || offline} title={offline ? 'The machine is offline' : undefined} onClick={onRetry}>{p.action}</button>}
        </div>
      )}
    </div>
  );
}
