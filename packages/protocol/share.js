import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

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
