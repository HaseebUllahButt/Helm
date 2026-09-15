import {
  createHmac, createECDH, randomBytes, createCipheriv,
  generateKeyPairSync, createPrivateKey, createPublicKey, sign as signRaw,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_DIR } from './network.js';

/**
 * Web push, by hand.
 *
 * A phone is only useful for "the agent is stuck" if it can say so while the
 * app is closed, and the only thing that can wake a closed PWA is a push
 * from the browser vendor's own service. That means two specs and no way
 * around either: RFC 8291 for encrypting the payload so Apple and Google
 * relay bytes they cannot read, and RFC 8292 (VAPID) for proving to that
 * service which application server is sending.
 *
 * Both are done here rather than with the `web-push` package, for the same
 * reason the HMAC tokens are: it is about a hundred lines of documented
 * cryptography, and the alternative is a dependency on every machine for
 * something node's own crypto already does. What makes that safe is that
 * RFC 8291 ships a worked example - `push.test.mjs` replays it and checks
 * this file produces the byte-identical body, which is a much better check
 * than "a notification appeared on my phone once".
 *
 * The keys live in ~/.helm/push.json and belong to the machine. Losing them
 * means every device has to re-subscribe, which is a button press.
 */

const KEY_FILE = join(HELM_DIR, 'push.json');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');

/** HKDF, spelled out: the two steps are named in the RFC and easier to follow. */
const extract = (salt, ikm) => createHmac('sha256', salt).update(ikm).digest();
const expand = (prk, info, length) =>
  createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);

/** A raw P-256 point (0x04||X||Y) as a node key. */
function publicKeyFrom(raw) {
  const b = Buffer.from(raw);
  if (b.length !== 65 || b[0] !== 0x04) throw new Error('not an uncompressed P-256 point');
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(b.subarray(1, 33)), y: b64url(b.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** A raw P-256 scalar as a node private key; the point is derived from it. */
function privateKeyFrom(rawPrivate) {
  const d = Buffer.from(rawPrivate);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  return createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d: b64url(d),
    },
    format: 'jwk',
  });
}

/**
 * Encrypt one message for one subscription (RFC 8291).
 *
 * `ephemeral` and `salt` are arguments only so the RFC's worked example can
 * be replayed exactly; in use they are fresh random values, and reusing a
 * salt with a key would be a real break.
 */
export function encrypt(payload, { p256dh, auth }, { ephemeral, salt } = {}) {
  const uaPublic = unb64(p256dh);
  const authSecret = unb64(auth);
  const plaintext = Buffer.from(payload, 'utf8');

  const ecdh = createECDH('prime256v1');
  if (ephemeral) ecdh.setPrivateKey(Buffer.from(ephemeral)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const useSalt = salt ? Buffer.from(salt) : randomBytes(16);

  // The key derivation is bound to *both* public keys, which is what stops a
  // payload encrypted for one subscription being replayed at another.
  const prkKey = extract(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = expand(prkKey, keyInfo, 32);

  const prk = extract(useSalt, ikm);
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  // 0x02 is the last-record delimiter. There is only ever one record here:
  // the messages are a line of text, nowhere near the 4096-byte record size.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final()]);
  const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);

  const header = Buffer.alloc(5);
  header.writeUInt32BE(4096, 0);
  header.writeUInt8(asPublic.length, 4);
  return Buffer.concat([useSalt, header, asPublic, ciphertext]);
}

/** The `Authorization: vapid` header for one push service (RFC 8292). */
export function vapidHeader(endpoint, keys, subject = 'mailto:helm@localhost') {
  const { origin } = new URL(endpoint);
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  }));
  const signed = `${header}.${claims}`;
  // ES256 wants the raw r||s pair, not the DER sequence node produces by default.
  const sig = signRaw('sha256', Buffer.from(signed), {
    key: privateKeyFrom(unb64(keys.privateKey)),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signed}.${b64url(sig)}, k=${keys.publicKey}`;
}

/** This machine's VAPID keys, minted once and kept. */
export function keys() {
  if (existsSync(KEY_FILE)) {
    try { return JSON.parse(readFileSync(KEY_FILE, 'utf8')); } catch { /* rewrite below */ }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = publicKey.export({ format: 'jwk' });
  const value = {
    publicKey: b64url(Buffer.concat([
      Buffer.from([4]), unb64(pub.x), unb64(pub.y),
    ])),
    privateKey: b64url(unb64(jwk.d)),
  };
  mkdirSync(HELM_DIR, { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify(value, null, 2), { mode: 0o600 });
  return value;
}

/**
 * Deliver one notification. Resolves to what the push service said, so the
 * caller can drop a subscription the browser has retired: 404 and 410 mean
 * that endpoint is gone for good and should never be tried again.
 */
export async function send(subscription, payload, { timeoutMs = 10_000, subject } = {}) {
  const body = encrypt(JSON.stringify(payload), subscription.keys ?? subscription);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidHeader(subscription.endpoint, keys(), subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '600',
      urgency: 'high',
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
