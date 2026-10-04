import test from 'node:test';
import assert from 'node:assert/strict';
import { directRpc } from '../packages/connect/src/direct-rpc.js';
import { PeerHub } from '../packages/connect/src/peer.js';

test('machine WebRTC RPC transfers a fragmented payload and authenticates the caller', { timeout: 20_000 }, async () => {
  const payload = 'project-data-'.repeat(200_000);
  let request;
  const receiver = new PeerHub(
    (_peer, signal) => { void request.receive(signal); },
    async (method, params, caller) => {
      assert.equal(method, 'handoff.accept');
      assert.equal(caller, 'source-machine');
      assert.equal(params.data, payload);
      return { sessionId: 'destination', bytes: params.data.length };
    },
  );
  try {
    request = directRpc({
      signal: (signal) => { void receiver.signal('source', signal, null, 'source-machine'); },
      frame: { t: 'rpc', id: 'one', method: 'handoff.accept', params: { data: payload } },
      connectTimeout: 10_000, timeout: 15_000,
    });
    assert.deepEqual(await request.result, { sessionId: 'destination', bytes: payload.length });
  } finally { request?.close(); receiver.stop(); }
});

test('a failed direct negotiation terminates so the caller can use the hub', async () => {
  const request = directRpc({ signal: () => {}, frame: { id: 'two' }, connectTimeout: 20 });
  await assert.rejects(request.result, /timed out/);
  request.close();
});
