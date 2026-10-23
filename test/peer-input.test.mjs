import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: [new URL('../packages/connect/src/peer.js', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['node-datachannel/polyfill', './direct-config.js'] });

async function harness() {
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
  const context = { module: { exports: {} }, exports: {}, setTimeout, clearTimeout, Buffer,
    JSON: { stringify: JSON.stringify, parse: (...args) => { parses++; return JSON.parse(...args); } },
    Map: class extends Map { constructor(...args) { super(...args); maps.push(this); } },
    require: specifier => specifier === './direct-config.js'
      ? { nativeDirectConfig: () => ({ iceServers: [] }) }
      : { RTCPeerConnection: Connection } };
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  const hub = new context.module.exports.PeerHub(() => {}, async (...args) => { calls.push(args); return 'ok'; });
  await hub.signal('browser', { type: 'offer', sdp: 'test' }, null, 'device');
  const channel = { readyState: 'open', bufferedAmount: 0, close() {}, send: raw => sent.push(JSON.parse(raw)) };
  pc.ondatachannel({ channel });
  return { hub, calls, sent, fragments: maps.at(-1), parses: () => parses,
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
