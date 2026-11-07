/** Shared-key token envelopes. Network authentication also requires a machine signature. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = 'helm1';
const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** A fresh network secret. Keep this secret and each machine signing key private. */
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

/**
 * A MAC over a labelled value, for the hub handshake. The label keeps these
 * apart from tokens: a token signs a base64url payload, and a label carries a
 * ':' base64url never contains, so no proof can be passed off as a token's
 * signature or the other way round.
 */
export const proofOf = (key, label, value) => sign(key, `${label}:${value}`);

export function checkProof(key, label, value, mac) {
  if (typeof mac !== 'string') return false;
  const expected = Buffer.from(proofOf(key, label, value));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Roles a token can carry. Machines run agents; devices only drive them. */
export const ROLE = { MACHINE: 'machine', DEVICE: 'device' };
