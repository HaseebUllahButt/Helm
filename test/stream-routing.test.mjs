import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const root = mkdtempSync(join(tmpdir(), 'helm-stream-routing-'));
process.env.HELM_DIR = join(root, 'home'); process.env.HELM_DB = join(root, 'hub.sqlite');
const N = await import('@helm/protocol/network');
const { startRelay } = await import('@helm/relay');

async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(10); }
  assert.fail('the expected frame did not arrive');
}

test('local and forwarded chat bodies reach only their open devices; sidebar updates still reach both', async t => {
  const net = N.createNetwork({ name: 'stream-routing', port: 8787 });
  const reader = N.issueDevice(N.loadNetwork(), 'reader');
  const closed = N.issueDevice(N.loadNetwork(), 'closed');
  const hub = await startRelay({ port: 0, host: '127.0.0.1', openLogin: false });
  const url = `ws://127.0.0.1:${hub.server.address().port}/ws`;
  const sockets = [];
  t.after(() => { for (const socket of sockets) socket.terminate(); hub.stop(); rmSync(root, { recursive: true, force: true }); });
  async function connect(token, role) {
    const frames = [];
    const socket = new WebSocket(url + '?role=' + role, { headers: { authorization: `Bearer ${token}` } });
    sockets.push(socket); socket.on('message', raw => frames.push(JSON.parse(raw)));
    await until(() => frames.some(f => f.t === 'welcome'));
    return { socket, frames };
  }
  const machine = await connect(N.machineToken(N.loadNetwork()), 'self');
  const a = await connect(reader.token, 'client'), b = await connect(closed.token, 'client');
  hub.attachMesh({ watch() {}, machines: () => new Map([['remote', { info: {} }]]) });
  for (const device of [a, b]) for (const env of [net.self, 'remote']) device.socket.send(JSON.stringify({ t: 'subscribe', env }));
  // A response on each socket proves that its earlier subscription was read.
  for (const device of [a, b]) {
    device.socket.send(JSON.stringify({ t: 'rpc', id: 'barrier', env: 'unknown', method: 'env.info', params: {} }));
    await until(() => device.frames.some(f => f.id === 'barrier'));
  }
  const body = { t: 'event', kind: 'session.event', payload: { id: 'chat', events: [{ seq: 1, text: 'current answer' }] }, to: [reader.id] };
  machine.socket.send(JSON.stringify({ ...body, eid: 'local-body' }));
  await until(() => a.frames.some(f => f.eid === 'local-body'));
  hub.meshEvent({ ...body, env: 'remote', eid: 'forwarded-body' });
  await until(() => a.frames.some(f => f.eid === 'forwarded-body'));
  machine.socket.send(JSON.stringify({ t: 'event', kind: 'session.update', payload: { session: { id: 'chat', status: 'idle' } }, eid: 'sidebar' }));
  await until(() => b.frames.some(f => f.eid === 'sidebar'));
  assert.equal(b.frames.filter(f => f.kind === 'session.event').length, 0);
  assert.equal(a.frames.filter(f => f.kind === 'session.event').length, 2);
});
