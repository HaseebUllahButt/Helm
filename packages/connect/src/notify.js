/**
 * Telling the owner's phone that something is waiting on them.
 *
 * This is the whole point of helm stated in one file: an agent that asks a
 * question four minutes in and then sits idle is the problem, and a
 * notification is the only thing that reaches someone who has walked away
 * from the desk with the app closed.
 *
 * Only `permission.request` fires one. Not turn.done - a finished turn is
 * not waiting on anybody, and a phone that buzzes for every completed task
 * gets its notifications turned off within a day, which costs you the one
 * message that mattered.
 */

const firstLine = (s, n = 120) => {
  const line = String(s ?? '').split('\n').find((x) => x.trim()) ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** What the notification should say, from the event the driver produced. */
export function describe(session, event) {
  const where = session?.title || session?.cwd?.split('/').pop() || 'a session';
  const engine = session?.engine ?? 'the agent';
  const ask = firstLine(
    event.question
    ?? event.title
    ?? (event.command ? `run ${event.command}` : null)
    ?? (event.tool ? `use ${event.tool}` : null)
    ?? event.message
    ?? 'needs your decision',
  );
  return {
    title: `${where} · ${engine} needs you`,
    body: ask,
    tag: `helm-${session?.id ?? 'session'}-${event.requestId ?? event.seq ?? ''}`,
    envId: session?.envId ?? null,
    sessionId: session?.id ?? null,
  };
}
