import { useEffect, useState } from 'react';
import type { Client } from '../client';
import { errorMessage } from '../errors';

export function DeliveryStatus({ client, env, id }: { client: Client; env: string; id: string }) {
  const [checking, setChecking] = useState(false);
  const [failures, setFailures] = useState<any[]>([]);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    const refresh = () => {
      try {
        setChecking(client.pendingActions().some(item => item.env === env && item.params.id === id));
        setFailures((client.failedActions?.() ?? []).filter(item => item.env === env && item.params.id === id));
        setProblem(client.deliveryStorageError ?? '');
        return true;
      } catch {
        setProblem('Cannot read saved deliveries. Check this chat before sending again.');
        return false;
      }
    };
    const off = client.on((machine, kind) => { if (machine === env && kind === 'delivery') refresh(); });
    if (refresh()) {
      try { void client.resumeActions(env, id).catch(() => refresh()); }
      catch { refresh(); }
    }
    return off;
  }, [client, env, id]);
  return <>
    {checking && <div className="thread-recovery" role="status">Checking delivery…</div>}
    {problem && <div className="thread-recovery" role="alert">{problem}</div>}
    {failures.map(action => <div key={action.actionId} className="thread-recovery failed-delivery" role="alert">
      <div>
        <strong>{action.method === 'session.deliver' ? 'Send failed' : 'Answer failed'}</strong>
        {action.params.data && <p className="failed-send-text">{action.params.data}</p>}
        {action.params.attachments?.map((file: any, index: number) => <p key={index}>{file.filename}</p>)}
        <p>{errorMessage(action.failure)}</p>
      </div>
      <button onClick={() => {
        try { client.dismissFailedAction(action.actionId); }
        catch { setProblem('Cannot clear saved deliveries. Check this chat before sending again.'); }
      }}>Dismiss</button>
    </div>)}
  </>;
}
