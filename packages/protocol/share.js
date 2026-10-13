import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { proofOf, checkProof } from './identity.js';

/**
 * Public links to something running on one of your machines - helm's own
 * ngrok. A machine says what it shares (a name, a local port, maybe a
 * password); the hub with a public address answers https://<name>.<its host>
 * and carries each request to that port over the socket the machine already
 * holds. These are the rules both ends have to agree on.
 */

/** Names become the first label of a hostname: short, lowercase, no dots. */
export const SHARE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const NAME_RULE = '1-40 letters, digits or dashes (not at either end)';
/** Labels that would read as helm itself, or as something the host owns. */
const RESERVED = new Set(['www', 'api', 'helm', 'hub', 'admin', 'mail', 'ws']);

export function shareName(value) {
  const name = String(value ?? '').trim().toLowerCase();
  return SHARE_NAME.test(name) && !RESERVED.has(name) ? name : null;
}

/** A short random name, for when none is given. */
export function randomShareName() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(randomBytes(6), (b) => abc[b % abc.length]).join('');
}

/**
 * Passwords are kept as scrypt hashes on the sharing machine; the hub gets
 * the hash to check against and never the password.
 */
export function hashSharePassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(String(password), salt, 32).toString('base64url');
  return { salt, hash };
}

export function checkSharePassword(password, lock) {
  if (!lock?.salt || !lock?.hash) return false;
  const want = Buffer.from(lock.hash, 'base64url');
  const got = scryptSync(String(password ?? ''), lock.salt, want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The "you already typed it" cookie. Keyed by the password's own hash, so
 * changing the password signs everyone out, and a hub restart does not.
 */
export function shareCookie(name, lock, expiresAt) {
  const mac = createHmac('sha256', Buffer.from(lock.hash, 'base64url'))
    .update(`${name}|${expiresAt}`).digest('base64url');
  return `${expiresAt}.${mac}`;
}

export function checkShareCookie(value, name, lock, now = Date.now()) {
  const [at, mac] = String(value ?? '').split('.');
  const expiresAt = Number(at);
  if (!lock?.hash || !mac || !Number.isFinite(expiresAt) || expiresAt < now) return false;
  const want = Buffer.from(shareCookie(name, lock, expiresAt).split('.')[1]);
  const got = Buffer.from(mac);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The https hosts a network's public homes answer on, from the roster. */
export function publicHosts(net) {
  const hosts = [];
  for (const m of Object.values(net?.machines ?? {})) {
    if (net.revoked?.[m.id]) continue;
    for (const url of m.endpoints ?? []) {
      try {
        const u = new URL(url);
        if (u.protocol === 'https:' && !hosts.includes(u.hostname)) hosts.push(u.hostname);
      } catch { /* not a url */ }
    }
  }
  return hosts;
}

// ------------------------------------------------------------- private links
//
// A private link answers only browsers of the network's own members. The link
// is a different origin from the Helm app, so the app's sign-in cannot simply
// be read there. Instead the app, signed in, asks a hub for a grant: a one-use
// pass for one link, good for a minute, signed with the network key so any
// hub can mint it and the link's hub can check it. The link swaps it for a
// cookie of its own, which names the member, so every request can check that
// the member is still one. A password is never membership.

const GRANT = 'share-grant';
const PASS = 'share-member';
export const GRANT_TTL_MS = 60_000;
/** How long a member's cookie lasts before another trip through the app. */
export const MEMBER_TTL_MS = 12 * 60 * 60 * 1000;

const pack = (claims) => Buffer.from(JSON.stringify(claims)).toString('base64url');
function unpack(value, net, label) {
  const [payload, mac, extra] = String(value ?? '').split('.');
  if (!payload || !mac || extra !== undefined || !net?.key) return null;
  if (!checkProof(net.key, label, `${net.id}:${payload}`, mac)) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}
const sign = (net, label, claims) => {
  const payload = pack(claims);
  return `${payload}.${proofOf(net.key, label, `${net.id}:${payload}`)}`;
};

/** Is this id a machine or device of the network right now? */
export const isMember = (net, sub) => typeof sub === 'string' && !net?.revoked?.[sub]
  && (Object.hasOwn(net?.devices ?? {}, sub) || Object.hasOwn(net?.machines ?? {}, sub));

/** A one-use pass for member `sub` into link `name` on `host`. */
export function mintShareGrant(net, { name, host, sub, now = Date.now() }) {
  return sign(net, GRANT, { n: name, h: host, s: sub, e: now + GRANT_TTL_MS, j: randomBytes(12).toString('base64url') });
}

/**
 * The grant's claims if it is for this link, unexpired and from a member,
 * else null. Spending it once is the caller's job: it alone knows which
 * passes it has already taken.
 */
export function checkShareGrant(net, value, { name, host, now = Date.now() }) {
  const c = unpack(value, net, GRANT);
  if (!c || c.n !== name || c.h !== host || !(c.e > now) || c.e > now + GRANT_TTL_MS
    || typeof c.j !== 'string' || !isMember(net, c.s)) return null;
  return c;
}

/** The member's cookie for one link host. */
export const memberCookie = (net, { name, host, sub, expiresAt }) =>
  sign(net, PASS, { n: name, h: host, s: sub, e: expiresAt });

/** The member it names, if it is for this link, unexpired, and they still are one. */
export function checkMemberCookie(net, value, { name, host, now = Date.now() }) {
  const c = unpack(value, net, PASS);
  if (!c || c.n !== name || c.h !== host || !(c.e > now) || !isMember(net, c.s)) return null;
  return c.s;
}

/** A path on the link to land on afterwards; anything else is the front page. */
export const safeSharePath = (next) => {
  const v = String(next ?? '');
  // No control characters: a Location header cannot carry them.
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && !/[\x00-\x1f\x7f]/.test(v) && v.length < 2048 ? v : '/';
};
