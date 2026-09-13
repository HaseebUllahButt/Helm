/**
 * Who is allowed in, decided without a central authority.
 *
 * The old model stored each device token as a random string in one relay's
 * SQLite file. That works, but it forces a centre: only the machine holding
 * that row can tell whether your phone is allowed in, so every connection has
 * to go through it, and losing it loses the network.
 *
 * Here a network has a shared secret instead. A token is a signed claim, so
 * any machine holding the network key can verify a device it has never seen,
 * offline, in microseconds. That is the whole reason any machine can act as
 * the meeting point.
 *
 * Tokens do not expire. A device stays in the network until it is explicitly
 * removed, which is the behaviour you want from something you carry around.
 * Removal works by id through a revocation list, which is small and only ever
 * grows when you actually revoke something.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'helm1';
const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** A fresh network secret. This is the only thing that must stay private. */
export const newNetworkKey = () => randomBytes(32).toString('base64url');

/** A stable public name for a network, safe to log and to show in a UI. */
export const newNetworkId = () => randomBytes(6).toString('hex');

export const newDeviceId = () => randomBytes(6).toString('hex');

const sign = (key, payload) =>
  b64(createHmac('sha256', Buffer.from(key, 'base64url')).update(payload).digest());

/**
 * Issue a token.
 *
 * @param {string} key     the network secret
 * @param {object} claims  at minimum { net, sub, role }
 */
export function mintToken(key, claims) {
  const payload = b64(JSON.stringify({ ...claims, iat: Date.now() }));
  return `${PREFIX}.${payload}.${sign(key, payload)}`;
}

/**
 * Check a token and return its claims, or null.
 *
 * Returns null rather than throwing for every failure mode, because callers
 * treat "malformed", "wrong network" and "bad signature" identically: not
 * allowed in. Distinguishing them in an error message would only tell an
 * attacker which half of the token to keep working on.
 */
export function verifyToken(key, token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;

  const [, payload, mac] = parts;
  const expected = Buffer.from(sign(key, payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(expected, given)) return null;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Roles a token can carry. Machines run agents; devices only drive them. */
export const ROLE = { MACHINE: 'machine', DEVICE: 'device' };
