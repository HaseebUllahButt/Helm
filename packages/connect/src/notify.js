/**
 * Telling the owner's phone that something is waiting on them.
 *
 * This is the whole point of helm stated in one file: an agent that asks a
 * question four minutes in and then sits idle is the problem, and a
 * notification is the only thing that reaches someone who has walked away
 * from the desk with the app closed.
 *
 * Notification previews carry a short human label, never raw tool input.
 * Full questions, commands and paths belong in the conversation they open.
 */

import { agentLabel, notificationContext } from '@helm/protocol/notifications';

/** What the notification should say, from the event the driver produced. */
export function describe(session, event) {
  const question = event.kind === 'question' || !!event.question || !!event.questions?.length;
  const action = question ? 'has a question' : event.kind === 'plan' ? 'has a plan to review' : 'needs approval';
  return {
    title: `Helm · ${agentLabel(session?.engine)} ${action}`,
    body: notificationContext(session),
    tag: `helm-${session?.id ?? 'session'}-${event.requestId ?? event.seq ?? ''}`,
    envId: session?.envId ?? null,
    sessionId: session?.id ?? null,
  };
}

export function describeDone(session, at = Date.now()) {
  return {
    title: `Helm · ${agentLabel(session?.engine)} finished`, body: notificationContext(session),
    tag: `helm-done-${session.id}-${at}`, envId: session.envId ?? null, sessionId: session.id,
  };
}
