import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { createServer as tcpServer } from 'node:net';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TunnelSender, TunnelReceiver, TUNNEL_WINDOW, TUNNEL_CHUNK } from '../packages/connect/src/tunnel-flow.js';
import { T } from '@helm/protocol';

const root = mkdtempSync(join(tmpdir(), 'helm-flow-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_DB = join(root, 'db');
process.env.HELM_SSH_DIR = join(root, 'ssh');
const { bridge } = await import('../packages/connect/src/proxy.js');
const N = await import('@helm/protocol/network');
N.createNetwork({ name: 'test' });
const { Daemon } = await import('../packages/connect/src/agent.js');
const { createWsLayer } = await import('../apps/relay/src/ws.js');
test.after(() => rmSync(root, { force: true, recursive: true }));
const tick = () => new Promise(r => setImmediate(r));

test('sender stops at its window and resumes only on validated receiver credit', async () => {
  const input = new PassThrough(); const chunks = []; const errors = [];
  const sender = new TunnelSender(input, c => chunks.push(c), e => errors.push(e));
  input.write(Buffer.alloc(TUNNEL_WINDOW * 2, 7));
  await tick();
  assert.equal(sender.sent, TUNNEL_WINDOW);
  assert.ok(chunks.every(c => c.length <= TUNNEL_CHUNK));
  sender.ack(TUNNEL_CHUNK);
  assert.equal(sender.sent, TUNNEL_WINDOW + TUNNEL_CHUNK);
  sender.ack(sender.sent + 1);
  sender.ack(-1);
  assert.equal(errors.length, 2);
  sender.stop();
  assert.equal(input.listenerCount('data'), 0);
});

test('a closing sender flushes a tail that is waiting for credit before closing the tunnel', async () => {
  const input = new PassThrough(); let closed = false;
  const sender = new TunnelSender(input, () => {}, assert.fail);
  input.write(Buffer.alloc(TUNNEL_WINDOW + 123));
  await tick();
  sender.finish(() => { closed = true; });
  assert.equal(closed, false);
  sender.ack(TUNNEL_WINDOW);
  assert.equal(sender.sent, TUNNEL_WINDOW + 123);
  assert.equal(closed, false);
  sender.ack(TUNNEL_WINDOW + 123);
  assert.equal(closed, true);
});

test('receiver grants credit only after the slow destination writes, and bounds hostile input', async () => {
  const callbacks = []; const acks = []; const errors = [];
  const receiver = new TunnelReceiver({ write: (_c, done) => callbacks.push(done) }, n => acks.push(n), e => errors.push(e));
  const data = Buffer.alloc(TUNNEL_CHUNK).toString('base64');
  for (let n = 0; n < TUNNEL_WINDOW / TUNNEL_CHUNK; n++) receiver.write(data);
  assert.equal(acks.length, 0);
  receiver.write(data);
  assert.equal(errors.length, 1);
  callbacks.shift()();
  assert.deepEqual(acks, [TUNNEL_CHUNK]);
  receiver.write(data);
  assert.equal(errors.length, 1);
  receiver.write('!invalid!');
  assert.equal(errors.length, 2);
  receiver.stop();
  callbacks.shift()();
  assert.equal(acks.length, 1);
});

test('large binary transfer through proxy, hub routing and daemon survives a slow receiver', { timeout: 20000 }, async t => {
  const data = randomBytes(8 * 1024 * 1024);
  const expected = createHash('sha256').update(data).digest('hex');
  const sockets = new Set();
  const echo = tcpServer(sock => {
    sockets.add(sock); sock.on('close', () => sockets.delete(sock));
    let bytes = 0;
    sock.on('data', chunk => {
      bytes += chunk.length;
      if (bytes === data.length) sock.end(chunk); else sock.write(chunk);
    });
  });
  await new Promise(r => echo.listen(0, '127.0.0.1', r));
  process.env.HELM_SSH_PORT = String(echo.address().port);
  const daemon = new Daemon({ port: 18787 });
  const layer = createWsLayer();
  const target = { readyState: 1, send: raw => daemon.onFrame(link, JSON.parse(raw)) };
  const link = { id: 'test', send: (type, extra) => layer.routeTunnel(target, { t: type, ...extra }) };
  layer.online.set('target', target);
  const http = createServer(); const wss = new WebSocketServer({ server: http });
  wss.on('connection', ws => ws.on('message', raw => layer.routeTunnel(ws, JSON.parse(raw))));
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const ws of wss.clients) ws.terminate();
    for (const sock of sockets) sock.destroy();
    daemon.stop(); layer.online.clear(); layer.stop(); wss.close(); http.close(); echo.close();
    delete process.env.HELM_SSH_PORT;
  });
  const input = new PassThrough();
  const hash = createHash('sha256'); let bytes = 0;
  let complete; const written = new Promise(r => { complete = r; });
  const output = new Writable({ highWaterMark: 1024, write(chunk, _enc, done) {
    setTimeout(() => { hash.update(chunk); bytes += chunk.length; done(); if (bytes === data.length) complete(); }, 2);
  } });
  t.after(() => { if (bytes !== data.length) console.error('Flow test received', bytes, 'expected', data.length); });
  input.write(data);
  await Promise.all([bridge(`http://127.0.0.1:${http.address().port}`, 'test', 'target', echo.address().port, { input, output }), written]);
  assert.equal(hash.digest('hex'), expected);
  assert.equal(input.listenerCount('data'), 0);
});

test('hub preserves flow negotiation and ignores tunnel frames from a third socket', () => {
  const layer = createWsLayer();
  const received = [], replies = [];
  const target = { readyState: 1, send: raw => received.push(JSON.parse(raw)) };
  const client = { readyState: 1, send: raw => replies.push(JSON.parse(raw)) };
  layer.online.set('target', target);
  try {
    layer.routeTunnel(client, { t: T.TUNNEL_OPEN, sid: 's', env: 'target', flow: 1 });
    assert.equal(received[0].flow, 1);
    const sid = received[0].sid;
    layer.routeTunnel({}, { t: T.TUNNEL_ACK, sid, bytes: 100 });
    assert.equal(received.length, 1);
    layer.routeTunnel(target, { t: T.TUNNEL_READY, sid, flow: 1 });
    assert.equal(replies[0].flow, 1);
    layer.routeTunnel(client, { t: T.TUNNEL_ACK, sid: 's', bytes: 100 });
    assert.equal(received[1].bytes, 100);
  } finally { layer.online.clear(); layer.stop(); }
});
