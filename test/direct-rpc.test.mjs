import test from 'node:test';
import assert from 'node:assert/strict';
import { directRpc } from '../packages/connect/src/direct-rpc.js';
import { PeerHub } from '../packages/connect/src/peer.js';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { cleanup } from 'node-datachannel';

test.after(() => cleanup());

test('fresh offers on one hub socket recover an abandoned ICE negotiation', { timeout: 20_000 }, async () => {
  const abandoned = new RTCPeerConnection({ iceServers: [] });
  abandoned.createDataChannel('helm');
  let request;
  let accepting = false;
  const errors = [];
  const receiver = new PeerHub(
    (_peer, signal) => { if (accepting) void request.receive(signal); },
    async (_method, _params, caller) => ({ caller, recovered: true }),
  );
  try {
    await abandoned.setLocalDescription(await abandoned.createOffer());
    await receiver.signal('browser', { type: 'offer', sdp: abandoned.localDescription.sdp, negotiation: 'abandoned' }, null, 'device');
    assert.equal(receiver.count, 1);
    accepting = true;
    request = directRpc({
      signal: signal => { void receiver.signal('browser', signal, null, 'device').catch(error => errors.push(error)); },
      frame: { t: 'rpc', id: 'retry', method: 'ping' },
      connectTimeout: 5000,
    });
    assert.deepEqual(await request.result, { caller: 'device', recovered: true });
    assert.deepEqual(errors, []);
  } finally { request?.close(); abandoned.close(); receiver.stop(); }
});

test('invalid offers release their peer and cannot block a subsequent negotiation', async () => {
  const receiver = new PeerHub(() => {}, async () => ({}));
  const caller = new RTCPeerConnection({ iceServers: [] });
  caller.createDataChannel('helm');
  try {
    await assert.rejects(receiver.signal('browser', { type: 'offer', sdp: 'invalid' }, null, 'device'));
    assert.equal(receiver.count, 0);
    await caller.setLocalDescription(await caller.createOffer());
    await receiver.signal('browser', { type: 'offer', sdp: caller.localDescription.sdp }, null, 'device');
    assert.equal(receiver.count, 1);
    await receiver.signal('browser', { type: 'offer', sdp: 'invalid' });
    assert.equal(receiver.count, 1);
    receiver.dropRevoked({ device: true });
    assert.equal(receiver.count, 0);
  } finally { caller.close(); receiver.stop(); }
});

test('machine WebRTC RPC transfers a fragmented payload and authenticates the caller', { timeout: 20_000 }, async () => {
  const payload = 'project-data-'.repeat(200_000);
  let request;
  const receiver = new PeerHub(
    (_peer, signal) => { void request.receive(signal); },
    async (method, params, caller) => {
      assert.equal(method, 'handoff.accept');
      assert.equal(caller, 'source-machine');
      assert.equal(params.data, payload);
      return { sessionId: 'destination', bytes: params.data.length, data: payload };
    },
  );
  try {
    request = directRpc({
      signal: (signal) => { void receiver.signal('source', signal, null, 'source-machine'); },
      frame: { t: 'rpc', id: 'one', method: 'handoff.accept', params: { data: payload } },
      connectTimeout: 10_000, timeout: 15_000,
    });
    assert.deepEqual(await request.result, { sessionId: 'destination', bytes: payload.length, data: payload });
  } finally { request?.close(); receiver.stop(); }
});

test('a failed direct negotiation terminates so the caller can use the hub', async () => {
  const request = directRpc({ signal: () => {}, frame: { id: 'two' }, connectTimeout: 20 });
  await assert.rejects(request.result, /timed out/);
  request.close();
});
