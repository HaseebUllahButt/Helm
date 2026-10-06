import { useEffect, useRef, useState } from 'react';
import type { Session } from './client';
import { EngineMark } from './EngineMark';
import { Icon } from './Icon';
import { agentLabel, notificationContext } from '@helm/protocol/notifications';

/** "has a question", "wants to run a command" - what a waiting thread wants. */
export function askAction(ask: Session['ask']): string {
  switch (ask?.kind) {
    case 'question': return 'has a question';
    case 'command': return 'wants to run a command';
    case 'edit': return 'wants to change a file';
    case 'plan': return 'has a plan for you';
    case 'tool': return 'needs your OK';
    default: return 'needs you';
  }
}

/** How long the notice stays before it goes by itself. */
const SHOW_MS = 9000;

/**
 * "Another thread is waiting on you", over whatever is open. It says who,
 * what they want - the question itself, when the machine sent it - and
 * where; the whole card opens that thread. It leaves by itself unless a
 * pointer or focus is resting on it.
 */
export function NotificationToast({ session, machine, onOpen, onDismiss }: {
  session: Session; machine?: string; onOpen: () => void; onDismiss: () => void;
}) {
  const [held, setHeld] = useState(false);
  // The parent re-renders all the time; only a new thread or a new ask
  // should start the clock again.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => dismiss.current(), SHOW_MS);
    return () => clearTimeout(timer);
  }, [held, session]);

  const who = agentLabel(session.engine);
  const chat = notificationContext(session);
  const ask = session.ask;
  const text = ask?.text || '';
  const more = ask?.more ? ` +${ask.more} more` : '';
  const hold = { onPointerEnter: () => setHeld(true), onPointerLeave: () => setHeld(false), onFocus: () => setHeld(true), onBlur: () => setHeld(false) };
  return <div className="toast" role="status" {...hold}>
    <button className="toast-open" onClick={onOpen} aria-label={`Open ${chat}: ${who} ${askAction(ask)}${text ? `, ${text}` : ''}`}>
      <EngineMark engine={session.engine} />
      <span className="toast-copy">
        <span className="toast-kind"><i />{who} {askAction(ask)}</span>
        {text
          ? <b className={ask?.kind === 'command' ? 'mono' : undefined}>{text}{more && <span className="toast-more">{more}</span>}</b>
          : <b>{chat}</b>}
        {(text || machine) && <span className="toast-where">{[text && chat, machine].filter(Boolean).join(' · ')}</span>}
      </span>
    </button>
    <button className="toast-dismiss" aria-label="Dismiss notification" onClick={onDismiss}><Icon name="close" size={15} /></button>
    {!held && <span className="toast-timer" style={{ animationDuration: `${SHOW_MS}ms` }} key={String(session.updatedAt) + (ask?.text ?? '')} />}
  </div>;
}
