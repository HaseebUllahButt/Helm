import type { Session } from './client';
import { EngineMark } from './EngineMark';
import { agentLabel, notificationContext } from '@helm/protocol/notifications';

export function NotificationToast({ session, onOpen, onDismiss }: {
  session: Session; onOpen: () => void; onDismiss: () => void;
}) {
  return <div className="toast" role="status">
    <button className="toast-open" onClick={onOpen} aria-label={`Open ${notificationContext(session)}, ${agentLabel(session.engine)} needs you`}>
      <EngineMark engine={session.engine} />
      <span className="toast-copy">
        <span className="toast-brand">Helm <span>{agentLabel(session.engine)} needs you</span></span>
        <b>{notificationContext(session)}</b>
      </span>
      <span className="chev">›</span>
    </button>
    <button className="toast-dismiss" aria-label="Dismiss notification" onClick={onDismiss}>×</button>
  </div>;
}
