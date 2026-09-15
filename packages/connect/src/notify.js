import { send as pushSend } from '@helm/protocol/push';

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

/** A request already announced is not news, even after a daemon restart. */
const announced = new Set();
const ANNOUNCED_CAP = 500;

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

/**
 * Fan one notification out to every device that asked for them.
 *
 * `rows` and `drop` are passed in rather than imported so this does not have
 * to reach into the hub's database itself - and so the tests can run it
 * without one.
 */
export async function fanOut(rows, payload, { drop = () => {}, log = () => {}, timeoutMs } = {}) {
  let sent = 0;
  await Promise.all((rows ?? []).map(async (row) => {
    try {
      const res = await pushSend(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload,
        timeoutMs ? { timeoutMs } : undefined,
      );
      if (res.gone) {
        // The browser has retired this subscription - a reinstall, cleared
        // site data, a permission revoked. It will never work again.
        drop(row.endpoint);
        log(`push: ${row.label || 'a device'} is gone (${res.status}); forgotten`);
      } else if (!res.ok) {
        log(`push: ${row.label || 'a device'} refused it (${res.status})`);
      } else {
        sent += 1;
      }
    } catch (err) {
      log(`push: could not reach ${row.label || 'a device'}: ${err.message}`);
    }
  }));
  return sent;
}

/** Has this exact request already been announced? Remembers, then says. */
export function isNew(key) {
  if (!key || announced.has(key)) return false;
  announced.add(key);
  // A bounded set: a long-running daemon should not grow a memory of every
  // prompt it has ever seen.
  if (announced.size > ANNOUNCED_CAP) {
    for (const k of announced) { announced.delete(k); if (announced.size <= ANNOUNCED_CAP / 2) break; }
  }
  return true;
}

/** For tests. */
export const forget = () => announced.clear();
