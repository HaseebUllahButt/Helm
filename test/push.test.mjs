import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, vapidHeader } from '../packages/protocol/push.js';

/**
 * RFC 8291 section 5 is a worked example: a known receiver key, auth secret,
 * sender key and salt, and the exact body they must produce. Replaying it is
 * the only honest way to check this without a phone - "a notification turned
 * up once" would not have caught a wrong HKDF info string, which fails for
 * every subscription but looks like a delivery problem.
 */
test('RFC 8291 worked example, byte for byte', () => {
  const plaintext = 'When I grow up, I want to be a watermelon';
  const subscription = {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  };
  const body = encrypt(plaintext, subscription, {
    ephemeral: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
    salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
  });
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZ'
    + 'IIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1'
    + 'CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('a fresh salt every time, or the encryption is worth nothing', () => {
  const sub = {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  };
  const a = encrypt('hello', sub);
  const b = encrypt('hello', sub);
  assert.notEqual(a.toString('base64url'), b.toString('base64url'));
  assert.notEqual(a.subarray(0, 16).toString('hex'), b.subarray(0, 16).toString('hex'), 'salts differ');
});

test('the VAPID header is addressed to the push service that will read it', async () => {
  const { keys } = await import('../packages/protocol/push.js');
  const k = keys();
  const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc123', k);
  const [, jwt] = /t=([^,]+)/.exec(header);
  const [h, claims, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
  // The audience is the service's origin, never the full endpoint - a JWT
  // minted for the wrong audience is rejected by every push service.
  assert.equal(body.aud, 'https://fcm.googleapis.com');
  assert.ok(body.exp > Math.floor(Date.now() / 1000));
  assert.ok(body.exp <= Math.floor(Date.now() / 1000) + 24 * 60 * 60, 'within the 24h VAPID limit');
  assert.equal(Buffer.from(sig, 'base64url').length, 64, 'raw r||s, not DER');
  assert.match(header, /k=[A-Za-z0-9_-]+$/);
});
