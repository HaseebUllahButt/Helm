import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { FrameLanes, FramePieces, laneKey } from '../packages/protocol/frame-lanes.js';
import { randomBytes } from 'node:crypto';
import { encodeTunnelFrame, TunnelFrames } from '../packages/protocol/tunnel-frame.js';

/**
 * A socket on a slow link: one buffer for everything not yet at the far
 * end, emptied at `rate` bytes per second. A message counts as arrived, and
 * its write callback runs, when its last byte is out.
 */
class SlowSocket extends EventEmitter {
  readyState = 1;
  arrived = [];
  #queue = [];
  #timer = null;
  constructor(rate) { super(); this.rate = rate; }
  get bufferedAmount() { return this.#queue.reduce((sum, item) => sum + item.left, 0); }
  send(data, cb) {
    this.#queue.push({ data, left: data.length, cb });
    if (!this.#timer) { this.#last = performance.now(); this.#timer = setInterval(() => this.#tick(), 10); }
  }
  #last = 0;
  #tick() {
    // By elapsed time, so a busy test machine slows the clock, not the link.
    const now = performance.now();
    let budget = this.rate * (now - this.#last) / 1000;
    this.#last = now;
    while (budget > 0 && this.#queue.length) {
      const head = this.#queue[0];
      const take = Math.min(budget, head.left);
      head.left -= take; budget -= take;
      if (head.left > 0) break;
      this.#queue.shift();
      this.arrived.push({ data: head.data, at: performance.now() });
      this.emit('arrive', head.data);
      head.cb?.();
    }
    if (!this.#queue.length) { clearInterval(this.#timer); this.#timer = null; }
  }
  close() {
    this.readyState = 3;
    clearInterval(this.#timer); this.#timer = null;
    for (const item of this.#queue.splice(0)) item.cb?.(new Error('closed'));
    this.emit('close');
  }
}

const arrival = (sock, match) => new Promise(resolve => {
  const look = data => { if (match(data)) { sock.off('arrive', look); resolve(performance.now()); } };
  sock.on('arrive', look);
});
/** A socket that holds each write until the test lets it leave. */
function heldSocket() {
  const sock = { readyState: 1, written: [], held: [],
    get bufferedAmount() { return this.held.reduce((sum, item) => sum + item.size, 0); },
    send(data, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = undefined; }
      this.written.push(data); this.options.push(opts); this.held.push({ size: data.length, cb });
    },
    options: [],
    leave() { while (this.held.length) this.held.shift().cb?.(); } };
  return sock;
}

const parse = data => (typeof data === 'string' ? JSON.parse(data) : null);

test('a small frame sent during a 2 MB frame on a 50 KB/s link arrives within a second', { timeout: 10_000 }, async t => {
  const sock = new SlowSocket(50 * 1024);
  t.after(() => sock.close());
  const lanes = new FrameLanes(sock, { text: () => true });
  const list = JSON.stringify({ t: 'rpcResult', id: 'list', ok: true, result: 'x'.repeat(2 * 1024 * 1024) });
  lanes.send(list, { rid: 'list' });
  // A chat list on its way, then the owner sends a message.
  await arrival(sock, data => parse(data)?.t === 'dc-chunk');
  const sentAt = performance.now();
  const message = JSON.stringify({ t: 'rpc', id: 'send', method: 'session.deliver', params: { text: 'hi' } });
  const arrived = arrival(sock, data => data === message);
  lanes.send(message, { key: 'rpc' });
  const ms = (await arrived) - sentAt;
  assert.ok(ms < 1000, `the message took ${Math.round(ms)} ms`);
  const pieces = sock.arrived.map(item => parse(item.data)).filter(frame => frame?.t === 'dc-chunk');
  assert.ok(pieces.length < pieces[0].n, 'the chat list is still on its way');
  assert.ok(lanes.queued > 1024 * 1024, 'the rest of the list waits in this process, not in the socket');
  assert.ok(sock.bufferedAmount <= 16_500 + 4096, 'the socket holds at most about one piece');
});

test('pieces join back into the same frame, mixed with other frames', () => {
  const sock = { readyState: 1, sent: [], send(data, cb) { this.sent.push(data); cb?.(); } };
  const lanes = new FrameLanes(sock, { text: () => true });
  const big = JSON.stringify({ t: 'rpcResult', id: 'a', ok: true, result: 'é'.repeat(50_000) });
  const other = JSON.stringify({ t: 'event', kind: 'x', payload: 'y'.repeat(40_000) });
  lanes.send(big, { rid: 'a' });
  lanes.send(other, { key: 'event' });
  lanes.send('{"t":"pong"}');
  const pieces = new FramePieces();
  const whole = [];
  // Shuffle the groups as a hub joining two routes might.
  const frames = sock.sent.map(raw => JSON.parse(raw));
  const order = [...frames.filter((_, i) => i % 2), ...frames.filter((_, i) => !(i % 2))];
  for (const frame of order) {
    const joined = pieces.take(frame);
    if (joined === undefined) whole.push(frame);
    else if (joined !== null) whole.push(JSON.parse(joined));
  }
  assert.equal(whole.find(frame => frame.t === 'rpcResult').result, 'é'.repeat(50_000));
  assert.equal(whole.find(frame => frame.t === 'event').payload.length, 40_000);
  assert.ok(whole.some(frame => frame.t === 'pong'));
  assert.ok(frames.filter(frame => frame.t === 'dc-chunk' && frame.rid === 'a').length === 4, 'a reply names its request on each piece');
});

test('frames with one key keep their order; frames with no key may pass', () => {
  const sock = heldSocket();
  const lanes = new FrameLanes(sock, { text: () => true });
  const data = { t: 'tunnel.data', sid: 's1', data: 'a'.repeat(30_000) };
  lanes.send(JSON.stringify(data), { key: laneKey(data) });
  const tail = { t: 'tunnel.data', sid: 's1', data: 'tail' };
  lanes.send(JSON.stringify(tail), { key: laneKey(tail) });
  const close = { t: 'tunnel.close', sid: 's1' };
  lanes.send(JSON.stringify(close), { key: laneKey(close) });
  const pong = { t: 'pong' };
  lanes.send(JSON.stringify(pong), { key: laneKey(pong) });
  sock.leave();
  const kinds = sock.written.map(raw => { const f = JSON.parse(raw); return f.t === 'dc-chunk' ? `piece${f.i}` : f.data === 'tail' ? 'tail' : f.t; });
  assert.deepEqual(kinds, ['piece0', 'pong', 'piece1', 'tail', 'tunnel.close']);
  assert.equal(laneKey({ t: 'rpcResult', id: 'x' }), null, 'replies answer their own request');
  assert.equal(laneKey({ t: 'rpc', method: 'session.deliver' }), 'rpc');
  assert.equal(laneKey({ t: 'hubRpc', method: 'handoff.accept' }), null, 'a workspace does not hold other requests');
  assert.equal(laneKey({ t: 'hubSignal' }), 'signal');
});

test('an older peer gets large frames whole, and small frames still go first', () => {
  const sock = heldSocket();
  const { written } = sock;
  const lanes = new FrameLanes(sock);
  const one = JSON.stringify({ t: 'rpcResult', id: '1', result: 'a'.repeat(40_000) });
  const two = JSON.stringify({ t: 'rpcResult', id: '2', result: 'b'.repeat(40_000) });
  lanes.send(one); lanes.send(two);
  lanes.send('{"t":"rpc","id":"3"}', { key: 'rpc' });
  assert.deepEqual(written, [one, '{"t":"rpc","id":"3"}'], 'the second list waits until the first is out');
  sock.leave();
  assert.deepEqual(written, [one, '{"t":"rpc","id":"3"}', two]);
  assert.ok(written.every(raw => JSON.parse(raw).t !== 'dc-chunk'));
});

test('binary copy frames go as parts only to a peer that joins them', () => {
  const frame = encodeTunnelFrame({ t: 'tunnel.data', sid: 'copy', data: Buffer.alloc(100_000, 7) }, true);
  const send = binary => {
    const sock = { readyState: 1, sent: [], send(data, cb) { this.sent.push(data); cb?.(); } };
    new FrameLanes(sock, { text: () => true, binary: () => binary }).send(frame, { key: 'sid:copy' });
    return sock.sent;
  };
  const parts = send(true);
  assert.ok(parts.length > 1 && parts.every(part => part.length <= 16_000));
  const joiner = new TunnelFrames();
  const out = parts.map(part => joiner.decode(part)).filter(Boolean);
  assert.equal(out.length, 1);
  assert.equal(out[0].sid, 'copy');
  assert.ok(out[0].data.equals(Buffer.alloc(100_000, 7)));
  assert.deepEqual(send(false), [frame], 'an older peer gets the frame whole');
});

test('a closed socket drops what waits and tells each sender', async () => {
  const sock = new SlowSocket(1024);
  const lanes = new FrameLanes(sock, { text: () => true });
  const failed = new Promise(resolve => lanes.send('x'.repeat(100_000), { done: resolve }));
  sock.close();
  assert.ok((await failed) instanceof Error);
  assert.equal(lanes.queued, 0);
  const late = new Promise(resolve => lanes.send('{"t":"ping"}', { done: resolve }));
  assert.ok((await late) instanceof Error, 'a send after close fails at once');
});

test('the joiner refuses a frame larger than one WebSocket message may be', () => {
  const pieces = new FramePieces({ limit: 20 });
  assert.equal(pieces.take({ t: 'dc-chunk', gid: 'g', i: 0, n: 3, data: 'a'.repeat(10) }), null);
  assert.equal(pieces.take({ t: 'dc-chunk', gid: 'g', i: 1, n: 3, data: 'b'.repeat(15) }), null);
  assert.equal(pieces.take({ t: 'dc-chunk', gid: 'g', i: 2, n: 3, data: 'c' }), null, 'the refused frame never completes');
  assert.equal(pieces.take({ t: 'dc-chunk', gid: 'h', i: 0, n: 2, data: 'a'.repeat(10) }), null);
  assert.equal(pieces.take({ t: 'dc-chunk', gid: 'h', i: 1, n: 2, data: 'b' }), 'a'.repeat(10) + 'b', 'its room is free again');
  assert.equal(pieces.take({ t: 'event' }), undefined);
});

test('a full socket buffer from another writer does not stop the large lane', async () => {
  const sock = new EventEmitter();
  Object.assign(sock, { readyState: 1, bufferedAmount: 1_000_000, sent: [], send(data, cb) { this.sent.push(data); setImmediate(() => cb?.()); } });
  const lanes = new FrameLanes(sock, { text: () => true });
  const done = new Promise(resolve => lanes.send('x'.repeat(40_000), { done: resolve }));
  assert.equal(sock.sent.length, 0);
  sock.bufferedAmount = 0;
  assert.equal(await done, undefined);
  assert.equal(sock.sent.length, 3);
});

test('stream bytes take turns with a large chat list, keep their order, and part one frame at a time', () => {
  const sock = heldSocket();
  const lanes = new FrameLanes(sock, { text: () => true, binary: () => true });
  const list = JSON.stringify({ t: 'rpcResult', id: 'list', result: 'c'.repeat(200_000) });
  lanes.send(list, { rid: 'list' });
  const sent = { a: [], b: [] };
  const video = sid => {
    const data = randomBytes(64 * 1024);
    sent[sid].push(data);
    lanes.send(encodeTunnelFrame({ t: 'tunnel.data', sid, data }, true), { key: `sid:${sid}`, compress: false });
  };
  video('a'); video('a'); video('b'); video('a'); video('b');
  assert.ok(lanes.queuedFor('sid:a') > 3 * 64 * 1024 && lanes.queuedFor('sid:b') > 2 * 64 * 1024);
  assert.equal(lanes.queuedFor('rpc'), 0);
  // One write leaves at a time, as on a slow link.
  while (sock.held.length) sock.held.shift().cb?.();
  const frames = new TunnelFrames(), pieces = new FramePieces();
  const got = [], open = new Set();
  let listDoneAt = -1, firstStreamAt = -1, mostOpen = 0;
  sock.written.forEach((raw, index) => {
    if (typeof raw === 'string') {
      const whole = pieces.take(JSON.parse(raw));
      if (whole) { assert.equal(whole, list); listDoneAt = index; }
      assert.equal(sock.options[index], undefined, 'text keeps the socket rule');
      return;
    }
    assert.equal(sock.options[index]?.compress, false, 'video is never deflated');
    if (firstStreamAt < 0) firstStreamAt = index;
    open.add(raw.readUInt32BE(4));
    mostOpen = Math.max(mostOpen, open.size);
    const frame = frames.decode(raw);
    if (frame) { open.delete(raw.readUInt32BE(4)); got.push(frame); }
  });
  assert.ok(listDoneAt > 0, 'the list arrives whole');
  assert.ok(firstStreamAt < listDoneAt / 2, 'stream bytes do not wait for the list');
  assert.equal(mostOpen, 1, 'one part frame at a time');
  assert.deepEqual(got.map(f => f.sid), ['a', 'b', 'a', 'b', 'a'], 'streams take turns frame by frame');
  for (const sid of ['a', 'b']) {
    assert.deepEqual(got.filter(f => f.sid === sid).map(f => f.data), sent[sid], 'each stream keeps its order');
  }
  assert.equal(lanes.queued, 0);
  assert.equal(lanes.queuedFor('sid:a'), 0);
});

test('short stream frames also take turns while a large frame waits', () => {
  const sock = heldSocket();
  const lanes = new FrameLanes(sock, { text: () => true, binary: () => true });
  const list = JSON.stringify({ t: 'rpcResult', id: 'list', result: 'c'.repeat(200_000) });
  lanes.send(list, { rid: 'list' });
  for (let i = 0; i < 40; i++) {
    lanes.send(encodeTunnelFrame({ t: 'tunnel.data', sid: 'a', data: randomBytes(1024) }, true), { key: 'sid:a', compress: false });
  }
  assert.ok(lanes.queuedStreams > 0, 'short stream frames wait in their line');
  while (sock.held.length) sock.held.shift().cb?.();
  const pieces = new FramePieces();
  let listDoneAt = -1;
  sock.written.forEach((raw, index) => { if (typeof raw === 'string' && pieces.take(JSON.parse(raw))) listDoneAt = index; });
  // Before, 40 short frames went straight to the socket ahead of every list piece.
  assert.ok(listDoneAt < sock.written.length - 1, 'the list finishes before the last stream frame');
  assert.equal(lanes.queuedStreams, 0);
});

test('a stream of short frames does not hold back another stream', () => {
  const sock = heldSocket();
  const lanes = new FrameLanes(sock, { text: () => true, binary: () => true });
  lanes.send(encodeTunnelFrame({ t: 'tunnel.data', sid: 'b', data: randomBytes(64 * 1024) }, true), { key: 'sid:b', compress: false });
  for (let i = 0; i < 40; i++) {
    lanes.send(encodeTunnelFrame({ t: 'tunnel.data', sid: 'a', data: randomBytes(1024) }, true), { key: 'sid:a', compress: false });
  }
  while (sock.held.length) sock.held.shift().cb?.();
  const frames = new TunnelFrames();
  const order = [];
  for (const raw of sock.written) { const f = frames.decode(raw); if (f) order.push(f.sid); }
  assert.ok(order.indexOf('b') < order.length - 1, 'stream b is not last behind every short frame of a');
});
