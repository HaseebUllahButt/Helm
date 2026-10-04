import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const root = mkdtempSync(join(tmpdir(), 'helm-task-transport-'));
process.env.HELM_DIR = root;
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';
const { createNetwork, saveNetwork } = await import('@helm/protocol/network');
const { mintToken, ROLE } = await import('@helm/protocol/identity');
const { T, M } = await import('@helm/protocol');
const { startRelay } = await import('@helm/relay');
const { PeerHub } = await import('../packages/connect/src/peer.js');
const { hubRpc, hubBroadcastRpc } = await import('../packages/connect/src/hub-client.js');
const net = createNetwork({ name: 'source', port: 18739 });
const targetId = 'bb22cc33dd44';
net.machines[targetId] = { id: targetId, name: 'target', endpoints: [], addedAt: Date.now(), updatedAt: Date.now() };
saveNetwork(net);
const hub = await startRelay({ port: net.port, host: '127.0.0.1', dbFile: process.env.HELM_DB });
const socket = new WebSocket(`ws://127.0.0.1:${net.port}/helm/ws?name=target`, {
  headers: { authorization: `Bearer ${mintToken(net.key, { net: net.id, sub: targetId, role: ROLE.MACHINE })}` },
});
let signalling = true;
let relayed = 0;
const receiver = new PeerHub(
  (peer, payload) => socket.send(JSON.stringify({ t: T.SIGNAL, peer, payload })),
  async (_method, params, caller) => ({ length: params.data.length, caller }),
);
await new Promise((resolve, reject) => {
  socket.on('error', reject);
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.t === T.WELCOME) resolve();
    if (message.t === T.SIGNAL && signalling) void receiver.signal(message.peer, message.payload, null, message.device);
    if (message.t === T.RPC) {
      relayed++;
      socket.send(JSON.stringify({ t: T.RPC_RESULT, id: message.id, ok: true,
        result: { length: message.params.data.length, caller: message.sub } }));
    }
  });
});
test.after(() => { receiver.stop(); socket.close(); hub.stop(); rmSync(root, { recursive: true, force: true }); });

test('hub signalling introduces machines but the project payload takes WebRTC', async () => {
  let route;
  const result = await hubRpc(net, targetId, M.HANDOFF_ACCEPT, { data: 'x'.repeat(800_000) }, {
    timeout: 20_000, direct: true, onRoute: (value) => { route = value; },
  });
  assert.equal(route, 'direct');
  assert.equal(relayed, 0);
  assert.deepEqual(result, { length: 800_000, caller: net.self });
});

test('blocked WebRTC falls back to the hub with the same request', async () => {
  signalling = false;
  let route;
  const result = await hubRpc(net, targetId, M.TRANSFER_ACCEPT, { data: 'fallback' }, {
    timeout: 15_000, direct: true, onRoute: (value) => { route = value; },
  });
  assert.equal(route, 'relay');
  assert.equal(relayed, 1);
  assert.deepEqual(result, { length: 8, caller: net.self });
});

test('queueing that must outlive the laptop refuses its local-only hub', async () => {
  await assert.rejects(() => hubBroadcastRpc(net, targetId, M.DISPATCH_SUBMIT, {}, { remoteOnly: true }), /independent hub/);
});
