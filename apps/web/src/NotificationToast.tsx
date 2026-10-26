import { useEffect, useRef, useState } from 'react';
import type { Client, Session } from './client';
import { EngineMark } from './EngineMark';
import { Icon } from './Icon';
import { errorMessage } from './errors';
import { agentLabel, notificationContext } from '@helm/protocol/notifications';

/** "has a question", "wants to run a command" - what a waiting thread wants. */
export function askAction(ask: Session['ask']): string {
  switch (ask?.kind) {
    case 'question': return 'has a question';
    case 'command': return 'wants to run a command';
    case 'edit': return 'wants to change a file';
    case 'plan': return 'has a plan';
    case 'tool': return 'needs your approval';
    default: return 'needs you';
  }
}

const GO: Record<string, string> = { question: 'Answer', plan: 'Read the plan', edit: 'See the change' };

/** How long the notice stays before it goes by itself. */
const SHOW_MS = 12000;

/**
 * "Another chat is waiting on you", over whatever is open. It names the chat
 * first, then who wants what, then the request itself. A command shown whole
 * can be allowed right here; everything else opens the chat. It leaves by
 * itself unless a pointer or focus is resting on it.
 */
export function NotificationToast({ client, envId, session, machine, waiting = 0, onOpen, onDismiss }: {
  client: Client; envId: string; session: Session; machine?: string;
  /** Other chats that are waiting too. */
  waiting?: number;
  onOpen: () => void; onDismiss: () => void;
}) {
  const [held, setHeld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The parent re-renders all the time; only a new thread or a new ask
  // should start the clock again.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (held || busy || error) return;
    const timer = setTimeout(() => dismiss.current(), SHOW_MS);
    return () => clearTimeout(timer);
  }, [held, busy, error, session]);

  const who = agentLabel(session.engine);
  const chat = notificationContext(session);
  const ask = session.ask;
  const text = ask?.text || '';
  const canAllow = ask?.kind === 'command' && !!ask.whole && !!ask.requestId;
  const allow = async () => {
    setBusy(true); setError('');
    try {
      await client.rpc(envId, 'session.answer', { id: session.id, requestId: ask!.requestId, decision: { option: 'allow' } });
      dismiss.current();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const hold = { onPointerEnter: () => setHeld(true), onPointerLeave: () => setHeld(false), onFocus: () => setHeld(true), onBlur: () => setHeld(false) };
  return <div className="toast" role="status" aria-label={`${chat}: ${who} ${askAction(ask)}`} {...hold}>
    <div className="toast-head">
      <EngineMark engine={session.engine} />
      <span className="toast-copy">
        <b className="toast-chat">{chat}</b>
        <span className="toast-where">{[who, machine].filter(Boolean).join(' · ')}</span>
      </span>
      <button className="toast-dismiss" aria-label="Close notice" onClick={onDismiss}><Icon name="close" size={15} /></button>
    </div>
    <p className="toast-kind"><i />{who} {askAction(ask)}{ask?.more ? ` (+${ask.more} more)` : ''}</p>
    {text && <p className={`toast-ask${ask?.kind === 'command' ? ' mono' : ''}`}>{text}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="toast-actions">
      {canAllow && <button className="toast-allow" disabled={busy} onClick={() => void allow()}>{busy ? 'Allowing…' : 'Allow once'}</button>}
      <button className="toast-go" onClick={onOpen}>{GO[ask?.kind ?? ''] ?? 'Open chat'}<Icon name="forward" size={14} /></button>
      {waiting > 0 && <span className="toast-queue">{waiting} more {waiting === 1 ? 'chat waits' : 'chats wait'}</span>}
    </div>
    {!held && !busy && !error && <span className="toast-timer" style={{ animationDuration: `${SHOW_MS}ms` }} key={String(session.updatedAt) + (ask?.text ?? '')} />}
  </div>;
}
