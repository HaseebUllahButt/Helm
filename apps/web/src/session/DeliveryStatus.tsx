import { useEffect, useRef, useState } from 'react';
import type { Client } from '../client';
import { errorMessage } from '../errors';

/** A send is quiet this long before the chat says it is still on its way. */
export const SEND_NOTE_AFTER_MS = 3000;
/** A round trip this slow makes the note say the link is slow. */
export const SLOW_LINK_MS = 1500;
/** While a message waits, try again this often. The receiver drops repeats. */
const RESEND_EVERY_MS = 15_000;

/**
 * Messages and answers this device sent that the machine has not confirmed.
 *
 * Each unconfirmed message shows its own words and a short note after a few
 * seconds, so a slow link looks slow, not lost (owner, 2026-11-18: four first
 * messages to the laptop waited minutes behind a slow hub with nothing on
 * screen). A failed one keeps its words with Retry and Dismiss.
 */
export function DeliveryStatus({ client, env, id, machine }: { client: Client; env: string; id: string; machine?: string }) {
  const [pending, setPending] = useState<any[]>([]);
  const [failures, setFailures] = useState<any[]>([]);
  const [problem, setProblem] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [slow, setSlow] = useState(false);
  const retry = useRef(() => {});
  const [retrying, setRetrying] = useState(false);
  const [resending, setResending] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let mounted = true;
    let running = false;
    const refresh = () => {
      try {
        setPending(client.pendingActions().filter(item => item.env === env && item.params.id === id));
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
    const off = client.on((machineId, kind, payload) => {
      if (machineId === env && kind === 'delivery') refresh();
      if (machineId === env && kind === 'latency') setSlow((payload?.ms ?? 0) >= SLOW_LINK_MS);
      if ((kind === 'connection' && payload?.online)
        || (machineId === env && ((kind === 'presence' && payload?.online)
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

  const waiting = pending.length > 0;
  // While something waits: tick for the 3 s note, measure the link, and
  // keep trying. A check that ran out of time must not leave it parked.
  useEffect(() => {
    if (!waiting) { setSlow(false); return; }
    const unwatch = client.watchLatency?.(env);
    const latency = client.latency?.(env);
    if (typeof latency === 'number') setSlow(latency >= SLOW_LINK_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const again = setInterval(() => { if (!document.hidden) retry.current(); }, RESEND_EVERY_MS);
    return () => { clearInterval(tick); clearInterval(again); unwatch?.(); };
  }, [client, env, waiting]);

  const name = machine || 'the machine';
  const quiet = (action: any) => now - (typeof action.savedAt === 'number' ? action.savedAt : 0) >= SEND_NOTE_AFTER_MS;
  const messages = pending.filter(action => action.method === 'session.deliver' && typeof action.params.data === 'string');
  const others = pending.filter(action => !messages.includes(action));
  const note = slow ? `${machine ? `${machine}'s` : 'The'} link is slow. Your message waits to send.` : `Sending to ${name}…`;
  const retryFailed = (action: any) => {
    setResending(current => new Set(current).add(action.actionId));
    // The failed words may also be back in the box. Clear them there, so one
    // tap does not become two sends.
    window.dispatchEvent(new CustomEvent('helm:retried-send', { detail: { env, id, text: action.params.data } }));
    Promise.resolve().then(() => client.retryFailedAction(action.actionId))
      .catch((failure) => setProblem(errorMessage(failure, { machine })))
      .finally(() => setResending(current => { const next = new Set(current); next.delete(action.actionId); return next; }));
  };
  return <>
    {messages.filter(quiet).map(action => <div key={action.actionId} className="thread-recovery sending-message" role="status">
      <div>
        <p className="failed-send-text">{action.params.data}</p>
        {action.params.attachments?.length > 0 && <p>{action.params.attachments.length === 1 ? '1 attached file' : `${action.params.attachments.length} attached files`}</p>}
        <p className="sending-note"><span className="sending-dot" aria-hidden="true" />{note}</p>
      </div>
      <button disabled={retrying} onClick={() => retry.current()}>Check again</button>
    </div>)}
    {others.length > 0 && <div className="thread-recovery" role="status">
      <span>{others.some(action => action.method === 'session.answer-deliver') ? `Sending your answer to ${name}…` : 'Checking delivery…'}</span>
      <button disabled={retrying} onClick={() => retry.current()}>Check again</button>
    </div>}
    {problem && <div className="thread-recovery" role="alert">{problem}</div>}
    {failures.map(action => <div key={action.actionId} className="thread-recovery failed-delivery" role="alert">
      <div>
        <strong>{action.method === 'session.deliver' ? 'Send failed' : 'Answer failed'}</strong>
        {action.params.data && <p className="failed-send-text">{action.params.data}</p>}
        {action.params.attachments?.map((file: any, index: number) => <p key={index}>{file.filename}</p>)}
        <p>{errorMessage(action.failure, { machine })}</p>
      </div>
      <span className="failed-send-actions">
        {action.method === 'session.deliver' && typeof action.params.data === 'string'
          && <button disabled={resending.has(action.actionId)} onClick={() => retryFailed(action)}>{resending.has(action.actionId) ? 'Sending…' : 'Retry'}</button>}
        <button disabled={resending.has(action.actionId)} onClick={() => {
          try { client.dismissFailedAction(action.actionId); }
          catch { setProblem('Cannot clear saved deliveries. Check this chat before sending again.'); }
        }}>Dismiss</button>
      </span>
    </div>)}
  </>;
}
