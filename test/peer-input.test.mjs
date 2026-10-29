import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import zlib from 'node:zlib';

const bundle = await build({ entryPoints: [new URL('../packages/connect/src/peer.js', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['node-datachannel/polyfill', './direct-config.js'] });

async function harness({ result = 'ok' } = {}) {
  const maps = [], calls = [], sent = [];
  let parses = 0;
  let pc;
  class Connection {
    constructor() { pc = this; }
    async setRemoteDescription() {}
    async createAnswer() { return { type: 'answer', sdp: 'test' }; }
    async setLocalDescription(answer) { this.localDescription = answer; }
    close() {}
  }
  const context = { module: { exports: {} }, exports: {}, setTimeout, clearTimeout, Buffer, Date,
    JSON: { stringify: JSON.stringify, parse: (...args) => { parses++; return JSON.parse(...args); } },
    Map: class extends Map { constructor(...args) { super(...args); maps.push(this); } },
    require: specifier => specifier === './direct-config.js'
      ? { nativeDirectConfig: () => ({ iceServers: [] }) }
      : specifier === 'node:zlib' ? zlib : { RTCPeerConnection: Connection } };
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  const hub = new context.module.exports.PeerHub(() => {}, async (...args) => { calls.push(args); return result; });
  await hub.signal('browser', { type: 'offer', sdp: 'test' }, null, 'device');
  const channel = Object.assign(new EventTarget(), { readyState: 'open', bufferedAmount: 0, close() {}, send: raw => sent.push(typeof raw === 'string' ? JSON.parse(raw) : raw) });
  pc.ondatachannel({ channel });
  return { hub, calls, sent, channel, pc, fragments: maps.at(-1), parses: () => parses,
    send: frame => channel.onmessage({ data: JSON.stringify(frame) }) };
}

test('an ordinary daemon RPC frame is parsed once', async t => {
  const h = await harness(); t.after(() => h.hub.stop());
  h.send({ t: 'rpc', id: 'one', method: 'ping' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sent[0].result, 'ok');
  assert.equal(h.parses(), 1);
});

test('invalid fragment indexes cannot allocate unbounded daemon buffers', async t => {
  const h = await harness(); t.after(() => h.hub.stop());
  for (const i of [-1, 2, 0.5, null, '0']) {
    for (let n = 0; n < 20; n++) h.send({ t: 'dc-chunk', gid: `${i}-${n}`, n: 2, i, data: 'x' });
  }
  assert.equal(h.fragments.size, 0);
});

test('abandoned frames remain bounded and a valid fragmented RPC still completes', async t => {
  const h = await harness(); t.after(() => h.hub.stop());
  for (let n = 0; n < 20; n++) h.send({ t: 'dc-chunk', gid: String(n), n: 2, i: 0, data: 'x' });
  assert.equal(h.fragments.size, 8);
  const raw = JSON.stringify({ t: 'rpc', id: 'valid', method: 'ping', params: { text: 'hello' } });
  h.send({ t: 'dc-chunk', gid: 'valid', n: 2, i: 0, data: raw.slice(0, 20) });
  h.send({ t: 'dc-chunk', gid: 'valid', n: 3, i: 2, data: 'wrong count' });
  h.send({ t: 'dc-chunk', gid: 'valid', n: 2, i: 0, data: 'duplicate' });
  assert.equal(h.calls.length, 0);
  h.send({ t: 'dc-chunk', gid: 'valid', n: 2, i: 1, data: raw.slice(20) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'ping');
  assert.equal(h.sent[0].result, 'ok');
});

test('a direct stream reaches its open device without sending chat bodies to other devices', async t => {
  const h = await harness(); t.after(() => h.hub.stop());
  h.hub.broadcast('session.event', { id: 'chat', events: [] }, 'one', ['other-device']);
  assert.equal(h.sent.length, 0);
  h.hub.broadcast('session.event', { id: 'chat', events: [] }, 'two', ['device']);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].eid, 'two');
  h.hub.broadcast('session.update', { session: { id: 'chat' } }, 'three');
  assert.equal(h.sent.length, 2, 'sidebar updates still reach devices without an open chat');
});

test('a browser that says hello gets every later frame in one compressed stream', async t => {
  const h = await harness(); t.after(() => h.hub.stop());
  h.send({ t: 'hello', zip: 'deflate-raw' });
  h.hub.broadcast('session.update', { session: { id: 'c' } }, 'b:1');
  h.send({ t: 'rpc', id: 'one', method: 'ping' });
  h.send({ t: 'tunnel.open', sid: 's' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const text = h.sent.filter(item => !Buffer.isBuffer(item));
  assert.ok(text.every(item => item.t === 'dc-progress' && item.rid === 'one'), 'only reply marks go as plain text after the hello');
  const pieces = h.sent.filter(Buffer.isBuffer);
  assert.ok(pieces.length >= 2);
  const frames = zlib.inflateRawSync(Buffer.concat(pieces), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    .toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(frames.map(f => f.t), ['event', 'rpcResult'], 'a tunnel cannot write into the stream');
  assert.equal(frames[1].result, 'ok');
});

test('a direct event that cannot be sent drops the link', async t => {
  const h = await harness(); t.after(() => h.hub.stop());
  let dropped = false;
  h.channel.send = () => { throw new Error('Message size exceeds limit'); };
  h.channel.close = () => { dropped = true; };
  h.hub.broadcast('session.update', { session: { id: 'c' } }, 'b:1');
  assert.equal(dropped, true);
});


test('a blocked direct reply resumes on its drain event without a polling tick', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await harness(); t.after(() => h.hub.stop());
  h.channel.bufferedAmount = 1024 * 1024;
  h.send({ t: 'rpc', id: 'slow', method: 'ping' });
  await new Promise(setImmediate);
  assert.equal(h.sent.length, 0);
  assert.equal(h.channel.bufferedAmountLowThreshold, 256 * 1024);
  h.channel.bufferedAmount = 0;
  h.channel.dispatchEvent(new Event('bufferedamountlow'));
  await new Promise(setImmediate);
  assert.equal(h.sent[0].id, 'slow');
});

test('each piece of a large direct reply names its request', async t => {
  const h = await harness({ result: 'x'.repeat(40_000) }); t.after(() => h.hub.stop());
  h.send({ t: 'rpc', id: 'big', method: 'session.events' });
  await new Promise(setImmediate);
  assert.ok(h.sent.length >= 3);
  assert.ok(h.sent.every(piece => piece.t === 'dc-chunk' && piece.rid === 'big'));
  assert.equal(JSON.parse(h.sent.map(piece => piece.data).join('')).result.length, 40_000);
  h.hub.broadcast('session.update', { session: { id: 'c', title: 'y'.repeat(40_000) } }, 'b:1');
  assert.ok(h.sent.slice(3).every(piece => piece.t === 'dc-chunk' && !('rid' in piece)), 'events name no request');
});

test('a compressed reply announces its request before each piece, and events do not', async t => {
  const h = await harness({ result: Array.from({ length: 6000 }, (_, i) => `line ${i} ${Math.random()}`) });
  t.after(() => h.hub.stop());
  h.send({ t: 'hello', zip: 'deflate-raw' });
  h.hub.broadcast('session.update', { session: { id: 'c' } }, 'b:1');
  h.send({ t: 'rpc', id: 'big', method: 'session.events' });
  const inflated = () => zlib.inflateRawSync(Buffer.concat(h.sent.filter(Buffer.isBuffer)), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    .toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
  while (inflated().length < 2) await new Promise(setImmediate);
  const pieces = h.sent.filter(Buffer.isBuffer);
  assert.ok(pieces.length >= 3, 'the reply needs several pieces');
  const marks = h.sent.filter(item => !Buffer.isBuffer(item));
  assert.ok(marks.every(mark => mark.t === 'dc-progress' && mark.rid === 'big'));
  assert.equal(marks.length, pieces.length - 1, 'the event piece has no mark; each reply piece has one');
  for (let i = 1; i < h.sent.length; i++) {
    if (Buffer.isBuffer(h.sent[i]) && i > 1) assert.equal(h.sent[i - 1].t, 'dc-progress');
  }
  assert.deepEqual(inflated().map(f => f.t), ['event', 'rpcResult']);
});

test('a link reported as disconnected stays while the app still sends, then drops when silent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = await harness(); t.after(() => h.hub.stop());
  let closed = false;
  h.channel.close = () => { closed = true; };
  h.pc.connectionState = 'disconnected';
  h.pc.onconnectionstatechange();
  for (let n = 0; n < 6; n++) {
    t.mock.timers.tick(4000);
    h.send({ t: 'pong' });
    t.mock.timers.tick(1000);
    assert.equal(closed, false, 'frames from the app prove the link');
  }
  t.mock.timers.tick(5000);
  assert.equal(closed, true, 'five quiet seconds after the check end it');
});

test('a link reported as disconnected stays while its full queue drains', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = await harness(); t.after(() => h.hub.stop());
  let closed = false;
  h.channel.close = () => { closed = true; };
  h.hub.broadcast('session.update', { session: { id: 'c' } }, 'b:1');
  h.channel.bufferedAmount = Buffer.byteLength(JSON.stringify(h.sent[0]));
  h.pc.connectionState = 'disconnected';
  h.pc.onconnectionstatechange();
  h.channel.bufferedAmount = 0;
  t.mock.timers.tick(5000);
  assert.equal(closed, false, 'queued bytes left while the queue was full');
  t.mock.timers.tick(5000);
  assert.equal(closed, true, 'an empty, quiet link is not proven');
});

test('a failed link still drops at once', async t => {
  const h = await harness(); t.after(() => h.hub.stop());
  let closed = false;
  h.channel.close = () => { closed = true; };
  h.pc.connectionState = 'failed';
  h.pc.onconnectionstatechange();
  assert.equal(closed, true);
});
