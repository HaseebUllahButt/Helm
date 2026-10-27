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

import { agentLabel, notificationContext, notificationLine } from '@helm/protocol/notifications';

/** "Claude Code has a question · laptop": who, what happened, and where. */
const whoWhere = (session, action) => [`${agentLabel(session?.engine)} ${action}`, session?.machine].filter(Boolean).join(' · ');

/**
 * What the notification should say, from the event the driver produced. The
 * title is the chat, which is what the owner knows it by. A question is the
 * agent's own words and goes under it; a command or a file stays in the chat.
 */
export function describe(session, event) {
  const question = event.kind === 'question' || !!event.question || !!event.questions?.length;
  const action = question ? 'has a question'
    : event.kind === 'plan' ? 'has a plan for you to check'
      : event.kind === 'command' ? 'wants to run a command'
        : event.kind === 'edit' ? 'wants to change a file' : 'needs your approval';
  const asked = question ? notificationLine(event.questions?.[0]?.question ?? event.question) : '';
  return {
    title: notificationContext(session),
    body: [whoWhere(session, action), asked].filter(Boolean).join('\n'),
    tag: `helm-${session?.id ?? 'session'}-${event.requestId ?? event.seq ?? ''}`,
    envId: session?.envId ?? null,
    sessionId: session?.id ?? null,
  };
}

/**
 * What a waiting prompt is about, for the owner's own screens: the in-app
 * notice and the "Needs you" card. Those are the app, behind its sign-in, so
 * unlike a lock-screen push they can carry the question itself - the first
 * line of it, never the whole tool input.
 */
export function askPreview(event) {
  if (event?.type !== 'permission.request') return null;
  const line = (v) => {
    const t = String(v ?? '').split('\n').find((l) => l.trim())?.replace(/\s+/g, ' ').trim() ?? '';
    return t.length > 120 ? `${t.slice(0, 119)}…` : t;
  };
  const question = event.kind === 'question' || !!event.questions?.length;
  const kind = question ? 'question' : ['command', 'edit', 'plan'].includes(event.kind) ? event.kind : 'tool';
  const text = question ? line(event.questions?.[0]?.question)
    : kind === 'command' ? line(event.detail)
    : kind === 'edit' ? line(event.title)
    : kind === 'plan' ? ''
    : line(event.title || event.tool);
  // A command shown whole can be allowed from the notice; a cut one is read in the chat.
  const whole = kind === 'command' && !!text && text === String(event.detail ?? '').trim();
  return { kind, text, more: question ? Math.max(0, (event.questions?.length ?? 1) - 1) : 0, ...(whole ? { whole } : {}) };
}

/** A finished chat: its name, then the first line of what the agent said last. */
export function describeDone(session, at = Date.now(), reply = '') {
  return {
    title: notificationContext(session), body: [whoWhere(session, 'finished'), notificationLine(reply)].filter(Boolean).join('\n'),
    tag: `helm-done-${session.id}-${at}`, envId: session.envId ?? null, sessionId: session.id,
  };
}
