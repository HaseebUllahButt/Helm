import { send as pushSend } from '@con/protocol/push';

/** A request already announced by this hub is not news. */
const announced = new Set();
const ANNOUNCED_CAP = 500;

/**
 * Fan one notification out to the subscriptions stored on this hub.
 *
 * Delivery belongs here rather than on the machine running the agent: a
 * phone normally subscribes on the public VM hub, while the session that
 * needs it normally runs on a laptop with a different, empty local database.
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
  if (announced.size > ANNOUNCED_CAP) {
    for (const value of announced) {
      announced.delete(value);
      if (announced.size <= ANNOUNCED_CAP / 2) break;
    }
  }
  return true;
}

/** For tests. */
export const forget = () => announced.clear();
