import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-relay-ws-'));
Object.assign(process.env, { HELM_DIR: root, HELM_DB: join(root, 'hub.sqlite') });
const { createWsLayer } = await import('../apps/relay/src/ws.js');
const { hasActiveTransfers } = await import('../packages/protocol/transfer-activity.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

function socket() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}

test('a repeated tunnel id closes both ends and releases its first route', t => {
  const layer = createWsLayer(); t.after(() => layer.stop());
  const source = socket(), target = socket();
  layer.online.set('target', target);
  const open = { t: 'tunnel.open', sid: 'copy', env: 'target' };
  layer.routeTunnel(source, open);
  const firstSid = target.sent[0].sid;
  assert.equal(hasActiveTransfers(), true);
  layer.routeTunnel(source, open);
  assert.deepEqual(target.sent.at(-1), { t: 'tunnel.close', sid: firstSid, reason: 'duplicate stream id' });
  assert.equal(source.sent.at(-1).t, 'tunnel.close');
  assert.equal(source.sidMap.size, 0);
  assert.equal(source.tunnelSids.size, 0);
  assert.equal(target.tunnelSids.size, 0);
  assert.equal(hasActiveTransfers(), false);

  layer.routeTunnel(source, open);
  const nextSid = target.sent.at(-1).sid;
  layer.routeTunnel(target, { t: 'tunnel.close', sid: firstSid });
  assert.equal(source.sidMap.get('copy'), nextSid, 'late close cannot remove the next stream');
  layer.routeTunnel(source, { t: 'tunnel.close', sid: 'copy' });
  assert.equal(hasActiveTransfers(), false);
});

test('a partial machine upload gets proof of receipt before its full message arrives', async t => {
  const { WebSocket, WebSocketServer } = await import('ws');
  const { once } = await import('node:events');
  let checkProgress;
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (fn, ms, ...args) => {
    if (ms === 5000) { checkProgress = fn; return { unref() {} }; }
    return interval(fn, ms, ...args);
  });
  const layer = createWsLayer(); t.after(() => layer.stop());
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const [peer] = await connected;
  await once(client, 'open');
  t.after(async () => { client.terminate(); peer.terminate(); await new Promise(resolve => server.close(resolve)); });
  peer.progressBytes = peer._socket.bytesRead;
  peer.isAlive = false;
  layer.online.set('machine', peer);
  let complete = false;
  peer.on('message', () => { complete = true; });
  const received = once(peer._socket, 'data');
  client.send('{"t":"large",', { fin: false }); await received;
  const proof = once(client, 'ping');
  checkProgress(); await proof;
  assert.equal(complete, false);
  assert.equal(peer.isAlive, true);
  peer.isAlive = false;
  checkProgress();
  assert.equal(peer.isAlive, false, 'a stopped upload does not extend liveness');
  const finished = once(peer, 'message');
  client.send('"done":true}', { fin: true }); await finished;
  assert.equal(complete, true);
});
