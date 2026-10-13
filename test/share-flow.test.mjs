import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { setup, download, cleanupState, sleep, until, hasActiveTransfers, T } from './share-flow-fixture.mjs';
const { TUNNEL_WINDOW, TUNNEL_CHUNK, TUNNEL_SOCKET_LIMIT, TunnelSender } = await import('../packages/connect/src/tunnel-flow.js');
const { PassThrough } = await import('node:stream');
const { createServer: tcpServer } = await import('node:net');
test.after(cleanupState);

test('large share response stays bounded while the visitor reads slowly, and chat still answers', { timeout: 15000 }, async t => {
  const f = await setup(); t.after(() => f.close());
  const result = download(f, { hold: 350, delay: 3 });
  await until(() => f.metrics.sent > 0);
  await sleep(200);
  assert.ok(f.metrics.produced < f.bytes, 'local app must be backpressured');
  const start = Date.now();
  assert.equal(await f.layer.callEnv('sharer', 'test.chat'), 'chat still answers');
  assert.ok(Date.now() - start < 1000, 'chat cannot wait for the download');
  await result;
  assert.equal(f.metrics.readyFlow, 1);
  assert.ok(f.metrics.peakDownloadCredit <= TUNNEL_WINDOW);
  assert.ok(f.metrics.peakReadable <= 2 * TUNNEL_CHUNK);
  assert.ok(f.metrics.peakBuffered < 2 * 1024 * 1024, JSON.stringify(f.metrics));
});

test('slow local upload reader backpressures the visitor in the other direction', { timeout: 15000 }, async t => {
  const f = await setup({ uploadDelay: 350 }); t.after(() => f.close());
  const req = f.request({ method: 'POST', headers: { host: 'flow.links.test', 'content-length': f.bytes } });
  const response = once(req, 'response');
  const chunk = Buffer.alloc(TUNNEL_CHUNK, 120);
  for (let sent = 0; sent < f.bytes; sent += chunk.length) {
    if (!req.write(chunk)) await once(req, 'drain');
  }
  req.end();
  const [res] = await response;
  let reply = ''; for await (const part of res) reply += part;
  assert.equal(Number(reply), f.bytes);
  assert.ok(f.metrics.peakUploadCredit <= TUNNEL_WINDOW, JSON.stringify(f.metrics));
  assert.ok(f.metrics.peakBuffered < 2 * 1024 * 1024, JSON.stringify(f.metrics));
});

test('aborting a share mid-transfer frees the stream and daemon socket', { timeout: 5000 }, async t => {
  const f = await setup(); t.after(() => f.close());
  const req = f.request(); req.end();
  const [res] = await once(req, 'response');
  res.pause(); await sleep(80);
  req.destroy(); res.destroy();
  await until(() => f.streams.size === 0 && f.appSockets.size === 0 && !hasActiveTransfers());
  assert.ok(f.metrics.hubCloses >= 1);
});

test('losing the machine during a response closes both ends', { timeout: 5000 }, async t => {
  const f = await setup(); t.after(() => f.close());
  const req = f.request(); req.end();
  const [res] = await once(req, 'response');
  res.on('error', () => {}); res.resume();
  f.machine.terminate();
  await until(() => f.streams.size === 0 && f.appSockets.size === 0 && !hasActiveTransfers());
});

test('stopping the hub during a response closes both ends', { timeout: 5000 }, async t => {
  const f = await setup(); t.after(() => f.close());
  const req = f.request(); req.end();
  const [res] = await once(req, 'response');
  res.on('error', () => {}); res.pause();
  f.layer.stop();
  await until(() => f.streams.size === 0 && f.appSockets.size === 0 && !hasActiveTransfers());
});

test('an older daemon that omits ready.flow still serves a whole response', { timeout: 10000 }, async t => {
  const f = await setup({ legacy: true, bytes: 2 * 1024 * 1024 }); t.after(() => f.close());
  await download(f);
  assert.equal(f.metrics.readyFlow, undefined);
});

test('a paced sender yields between bursts and waits for shared websocket capacity', async () => {
  const input = new PassThrough();
  let queued = TUNNEL_SOCKET_LIMIT, frames = 0;
  const sender = new TunnelSender(input, chunk => { queued += Math.ceil(chunk.length / 3) * 4; frames++; }, assert.fail,
    { canSend: () => queued < TUNNEL_SOCKET_LIMIT });
  try {
    input.write(Buffer.alloc(TUNNEL_WINDOW * 2));
    await sleep(20);
    assert.equal(frames, 0);
    queued = 0;
    await until(() => frames >= 2);
    assert.ok(queued <= TUNNEL_SOCKET_LIMIT + Math.ceil(TUNNEL_CHUNK / 3) * 4);
    const before = frames; await sleep(20); assert.equal(frames, before);
    queued = 0; sender.ack(sender.sent);
    await until(() => frames > before);
    sender.stop(); queued = 0;
    const stopped = frames; await sleep(20); assert.equal(frames, stopped);
  } finally { sender.stop(); input.destroy(); }
});

test('closing openTcp flushes the last write before releasing its tunnel', { timeout: 5000 }, async t => {
  const f = await setup(); t.after(() => f.close());
  let received = 0;
  const server = tcpServer(sock => {
    sock.on('data', chunk => { received += chunk.length; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.HELM_SSH_PORT = String(server.address().port);
  const stream = await f.layer.openTcp('sharer', server.address().port);
  stream.resume();
  stream.end(Buffer.alloc(TUNNEL_WINDOW + 123, 120));
  await once(stream, 'close');
  await until(() => f.appSockets.size === 0 && !hasActiveTransfers());
  assert.equal(f.metrics.peakUploadCredit <= TUNNEL_WINDOW, true);
  assert.ok(f.metrics.hubCloses >= 1);
  assert.equal(received, TUNNEL_WINDOW + 123);
});

test('ending openTcp keeps a small write that landed while the sender was paused', { timeout: 5000 }, async t => {
  const f = await setup(); t.after(() => f.close());
  let received = 0;
  const server = tcpServer(sock => {
    sock.on('data', chunk => { received += chunk.length; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  process.env.HELM_SSH_PORT = String(server.address().port);
  for (const size of [TUNNEL_WINDOW + 5, 3 * TUNNEL_CHUNK]) {
    const stream = await f.layer.openTcp('sharer', server.address().port);
    stream.resume();
    received = 0;
    // The first write fills the credit window (or trips the two-frame yield),
    // so the second one waits inside the stream when end() arrives.
    stream.write(Buffer.alloc(size, 120));
    stream.write(Buffer.alloc(7, 121));
    stream.end();
    await once(stream, 'close');
    await until(() => f.appSockets.size === 0 && !hasActiveTransfers());
    await until(() => received === size + 7);
  }
});

test('aborting an upload with a blocked write releases its pending callbacks', { timeout: 5000 }, async t => {
  const f = await setup({ uploadDelay: 500 }); t.after(() => f.close());
  const stream = await f.layer.openTcp('sharer', process.env.HELM_SSH_PORT);
  stream.on('error', () => {});
  stream.write('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 52428800\r\n\r\n');
  stream.write(Buffer.alloc(8 * 1024 * 1024, 120));
  let callback = false;
  stream.write(Buffer.alloc(TUNNEL_CHUNK, 120), () => { callback = true; });
  await sleep(100);
  assert.equal(callback, false, 'the upload write must still be blocked before abort');
  stream.destroy();
  await until(() => callback && f.appSockets.size === 0 && !hasActiveTransfers());
});

test('a refused or timed out openTcp leaves no relay stream behind', { timeout: 5000 }, async t => {
  const f = await setup(); t.after(() => f.close());
  await assert.rejects(f.layer.openTcp('missing', 80), /not connected/);
  // Keep the target transport full before READY can be delivered.
  const target = { readyState: 1, send() {} };
  f.layer.online.set('silent', target);
  await assert.rejects(f.layer.openTcp('silent', 80, { timeout: 20 }), /timed out/);
  assert.equal(target.tunnelSids.size, 0);
  assert.equal(hasActiveTransfers(), false);
  f.layer.online.delete('silent');
});

test('a large binary websocket message survives a paused visitor and abort frees its tunnel', { timeout: 10000 }, async t => {
  const f = await setup(); t.after(() => f.close());
  const visitor = new WebSocket(f.url, { headers: { host: 'flow.links.test' } });
  t.after(() => visitor.terminate());
  await once(visitor, 'open');
  visitor.pause();
  const message = once(visitor, 'message');
  visitor.send(Buffer.alloc(4 * 1024 * 1024, 120));
  await sleep(150);
  visitor.resume();
  const [data, binary] = await message;
  assert.equal(binary, true);
  assert.equal(data.length, 4 * 1024 * 1024);
  assert.ok(data.every(byte => byte === 120));
  assert.ok(f.metrics.peakDownloadCredit <= TUNNEL_WINDOW);
  assert.ok(f.metrics.peakUploadCredit <= TUNNEL_WINDOW);
  visitor.terminate();
  await until(() => f.streams.size === 0 && f.appSockets.size === 0 && !hasActiveTransfers());
});

test('a sender with empty websocket queues still yields after two frames', async () => {
  const input = new PassThrough();
  let frames = 0;
  const sender = new TunnelSender(input, () => { frames++; }, assert.fail, { canSend: () => true });
  try {
    input.emit('data', Buffer.alloc(TUNNEL_CHUNK));
    input.emit('data', Buffer.alloc(TUNNEL_CHUNK));
    input.emit('data', Buffer.alloc(TUNNEL_WINDOW - 2 * TUNNEL_CHUNK));
    assert.equal(frames, 2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames, 4, 'other work runs before the whole credit window is sent');
    await until(() => frames === TUNNEL_WINDOW / TUNNEL_CHUNK);
  } finally { sender.stop(); input.destroy(); }
});

test('a websocket visitor leaving before the port opens destroys the late stream', async () => {
  const { createShareRoute } = await import('../apps/relay/src/share.js');
  let opened, requested;
  const opening = new Promise(resolve => { opened = resolve; });
  const request = new Promise(resolve => { requested = resolve; });
  const stream = new PassThrough();
  const route = createShareRoute({ online: new Map([['target', {}]]),
    callEnv: async () => ({ shares: [{ name: 'late', port: 1234 }] }),
    openTcp: () => { requested(); return opening; } });
  const socket = { destroyed: false, write() { assert.fail('visitor already left'); },
    destroy() { this.destroyed = true; } };
  const upgrade = route.upgrade({ headers: { host: 'late.links.test' }, method: 'GET', url: '/live' }, socket, Buffer.alloc(0));
  await request;
  socket.destroy(); opened(stream);
  assert.equal(await upgrade, true);
  assert.equal(stream.destroyed, true);
});

test('destroying openTcp while its final bytes wait for credit releases end callbacks', { timeout: 5000 }, async t => {
  const f = await setup(); t.after(() => f.close());
  const target = { readyState: 1, send(raw) {
    const msg = JSON.parse(raw);
    if (msg.t === T.TUNNEL_OPEN) f.layer.routeTunnel(target, { t: T.TUNNEL_READY, sid: msg.sid, flow: 1 });
  } };
  f.layer.online.set('unread', target);
  const stream = await f.layer.openTcp('unread', 80);
  stream.on('error', () => {});
  let finished;
  stream.end('tail without credit', err => { finished = err; });
  await sleep(20);
  assert.equal(finished, undefined);
  stream.destroy();
  await until(() => finished instanceof Error);
  assert.equal(target.tunnelSids.size, 0);
  assert.equal(hasActiveTransfers(), false);
  f.layer.online.delete('unread');
});
