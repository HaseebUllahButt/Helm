import { errorMessage } from '../errors';
import { useState } from 'react';
import { type Client, type Session } from '../client';

export function TaskReturn({ client, envId, transfer, original, onOpenSession }: {
  client: Client; envId: string; transfer?: Session['taskTransfer']; original?: Session['parent'];
  onOpenSession?: (machineId: string, session: Session) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!transfer) return null;
  const source = transfer.role === 'source';
  const returned = transfer.status === 'returned';
  const conflict = transfer.status === 'conflict';
  const openOriginal = async () => {
    if (!original || !onOpenSession) return;
    setBusy(true); setError('');
    try {
      const reply = await client.rpc<{ session: Session }>(original.machineId, 'session.events', { id: original.sessionId, tail: 1 });
      onOpenSession(original.machineId, reply.session);
    } catch (err: any) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const recheck = async (keepLocal = false) => {
    setBusy(true); setError('');
    try {
      await client.rpc(envId, 'task.retry-return', { handoffId: transfer.handoffId,
        ...(keepLocal ? { keepLocal: transfer.conflicts ?? [] } : {}) }, 180_000);
    } catch (err: any) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <div className="banner" role="status">
    <strong>{source
      ? returned ? 'Task returned here' : conflict ? 'Returned changes need review' : `Task sent to ${transfer.machineName}`
      : returned ? `Task returned to ${transfer.machineName}` : conflict ? `Changes need review on ${transfer.machineName}`
        : `Finished changes return to ${transfer.machineName}`}</strong>
    <p className="note">{source
      ? returned ? 'Your project is updated. Continue in this chat.'
        : conflict ? `Your edits stay. Find the returned project at ${transfer.folder}.`
          : 'Changes come back here when the task finishes.'
      : returned || conflict || transfer.status === 'returning' ? 'Continue from the original machine.'
        : 'This task keeps running here.'}</p>
    {source && conflict && <>
      <p className="note">{transfer.conflicts?.slice(0, 8).join(', ')}</p>
      <div className="transfer-actions">
        <button className="linkish" disabled={busy} onClick={() => recheck()}>Check changes again</button>
        <button className="linkish" disabled={busy} onClick={() => recheck(true)}>Keep my edits where changes conflict</button>
      </div>
    </>}
    {!source && (returned || conflict) && original && onOpenSession &&
      <button className="linkish" disabled={busy} onClick={openOriginal}>Continue on original machine</button>}
    {transfer.error && <p className="note">Return pending. {errorMessage(transfer.error)} Helm will try again.</p>}
    {error && <p className="error">{error}</p>}
  </div>;
}
