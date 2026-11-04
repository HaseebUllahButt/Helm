import { useEffect, useRef, useState } from 'react';
import type { Client } from '../client';
import { errorMessage } from '../errors';

export function DeliveryStatus({ client, env, id }: { client: Client; env: string; id: string }) {
  const [checking, setChecking] = useState(false);
  const [failures, setFailures] = useState<any[]>([]);
  const [problem, setProblem] = useState('');
  const retry = useRef(() => {});
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let mounted = true;
    let running = false;
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
    const resume = () => {
      if (running || !refresh()) return;
      running = true;
      setRetrying(true);
      // Keep the original action number. A lost reply must not send twice.
      Promise.resolve().then(() => client.resumeActions(env, id)).catch(() => {}).finally(() => {
        running = false;
        if (mounted) { setRetrying(false); refresh(); }
      });
    };
    retry.current = resume;
    const off = client.on((machine, kind, payload) => {
      if (machine === env && kind === 'delivery') refresh();
      if ((kind === 'connection' && payload?.online)
        || (machine === env && ((kind === 'presence' && payload?.online)
          || (kind === 'transport' && payload?.direct)))) resume();
    });
    const visible = () => { if (!document.hidden) resume(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', resume);
    resume();
    return () => {
      mounted = false;
      retry.current = () => {};
      off();
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', resume);
    };
  }, [client, env, id]);
  return <>
    {checking && <div className="thread-recovery" role="status">
      <span>Checking delivery…</span>
      <button disabled={retrying} onClick={() => retry.current()}>Check again</button>
    </div>}
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
