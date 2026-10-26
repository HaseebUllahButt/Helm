import test from 'node:test';
import assert from 'node:assert/strict';
import { hubCredential } from '../packages/protocol/network.js';

for (const status of [404, 503]) test(`a failed handshake releases its unread response body after status ${status}`, async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { status }));
  await assert.rejects(hubCredential({}, 'https://hub.invalid'), status === 404 ? /older helm/ : /503/);
  assert.equal(cancelled, true);
});
