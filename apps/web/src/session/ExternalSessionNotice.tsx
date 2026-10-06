import { useState } from 'react';
import type { Session } from '../client';

/**
 * A conversation whose CLI was opened before Helm. Take over moves it into a
 * terminal both sides share - at the prompt, or once the step it is on is
 * done, so nothing it is doing gets cut off.
 */
export function ExternalSessionNotice({ session, onTakeOver }: {
  session: Session;
  onTakeOver?: (cancel?: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!session.external) return null;
  const waiting = session.takeover === 'waiting';
  const run = async (cancel = false) => {
    setBusy(true); setError('');
    try { await onTakeOver?.(cancel); } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const problem = error || session.takeoverError;
  return <div className="thread-recovery" role="status"><div>
    <strong>{!session.externalActive ? 'Saved CLI conversation' : waiting ? 'Taking over' : 'Open in a terminal'}</strong>
    <p>{!session.externalActive ? 'Your next message continues it here.'
      : waiting ? (session.status === 'working' ? 'Moving after the current step finishes.' : 'Moving now.')
      : problem || 'Take over to use it here and in the terminal.'}</p>
  </div>
    {session.externalActive && onTakeOver && (waiting
      ? <button disabled={busy} onClick={() => void run(true)}>Cancel</button>
      : <button disabled={busy} onClick={() => void run()}>Take over</button>)}
  </div>;
}
