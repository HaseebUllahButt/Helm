import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { fork } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'helm-direct-review-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_TERMINALS_SOCKET = join(root, 'term.sock');
process.env.HELM_PROCS_SOCKET = join(root, 'procs.sock');
process.env.HELM_NATIVE_SOCKET = join(root, 'native.sock');
await import('./fixtures/loopback-rtc.mjs');
const N = await import('@helm/protocol/network');
const { T, M } = await import('@helm/protocol');
const { Daemon, Link } = await import('../packages/connect/src/agent.js');
const { DirectMesh } = await import('../packages/connect/src/direct-mesh.js');
const { directPeer } = await import('../packages/connect/src/direct-rpc.js');
const { PeerHub, directCaller } = await import('../packages/connect/src/peer.js');
const { startRelay } = await import('@helm/relay');
const { cleanup } = await import('node-datachannel');
const { signDirectOffer, allowDirectSignal } = await import('../packages/connect/src/direct-auth.js');
const { codeSigningInfo } = await import('../packages/connect/src/code-transfer.js');
test.after(() => { cleanup(); rmSync(root, { recursive: true, force: true }); });

async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error('condition timed out');
}

test('a timed-out queued write cannot leave later', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const sent = [];
  let closed = false;
  const mesh = new DirectMesh({
    network: () => ({ self: 'a', machines: { a: {}, b: {} } }), supports: () => true, signal() {},
    makePeer: () => ({ ready: Promise.resolve(), close() { closed = true; },
      async send(frame, onStart) {
        await blocked;
        if (closed) throw Object.assign(new Error('closed'), { unsent: true });
        onStart(); sent.push(frame);
      },
    }),
  });
  mesh.want('b');
  await delay(1);
  const write = mesh.call('b', 'session.input', { text: 'expired' }, { timeout: 10 });
  // The request timer is unref'ed; keep the test alive until it expires.
  const rejected = assert.rejects(write, { code: 'timeout' });
  await delay(30);
  await rejected;
  release();
  await delay(5);
  assert.equal(sent.filter(frame => frame.method === 'session.input').length, 0);
  assert.equal(mesh.channels.size, 0);
  mesh.stop();
});

test('directRoutes false suppresses capability and incoming machine offers, preserving browser offers', async () => {
  const net = N.createNetwork({ name: 'target', port: 8787 });
  net.machines.source = { id: 'source', name: 'source', endpoints: [] };
  N.saveNetwork(net);
  const phone = N.issueDevice(net, 'phone');
  writeFileSync(join(process.env.HELM_DIR, 'config.json'), JSON.stringify({ directRoutes: false }));
  const daemon = new Daemon();
  daemon.sessions = { terminalBackend: async () => 'panes' };
  let introduced = [];
  daemon.peers = { signal: async (...args) => introduced.push(args) };
  assert.notEqual((await daemon.describe()).directRpc, 1);
  await daemon.onFrame({}, { t: T.SIGNAL, peer: 'machine', device: 'source', payload: { type: 'offer' } });
  assert.equal(introduced.length, 0);
  await daemon.onFrame({}, { t: T.SIGNAL, peer: 'phone', device: phone.id, payload: { type: 'offer' } });
  assert.equal(introduced.length, 1);
  writeFileSync(join(process.env.HELM_DIR, 'config.json'), '{}');
});

test('turning directRoutes off also stops sends on an already open outgoing channel', async () => {
  const net = N.createNetwork({ name: 'source', port: 8787 });
  net.machines.source = { id: 'source', name: 'source', endpoints: [] };
  N.saveNetwork(net);
  writeFileSync(join(process.env.HELM_DIR, 'config.json'), '{}');
  const daemon = new Daemon();
  daemon.attachHub({ online: new Map(), meshChanged() {}, meshEvent() {}, meshSignal() {}, attachMesh() {} });
  const mesh = daemon.mesh.direct;
  const sent = [];
  mesh.supports = () => true;
  mesh.makePeer = () => ({ ready: Promise.resolve(), close() {}, async send(frame, start) { start(); sent.push(frame); } });
  mesh.want('source');
  await new Promise(setImmediate);
  const before = sent.length;
  writeFileSync(join(process.env.HELM_DIR, 'config.json'), JSON.stringify({ directRoutes: false }));
  try {
    const rejected = assert.rejects(mesh.call('source', 'session.input', {}, { timeout: 10 }), error => error.unsent === true);
    await delay(30);
    await rejected;
    assert.equal(sent.length, before);
    mesh.tick();
    assert.equal(mesh.channels.size, 0);
  } finally { daemon.mesh.stop(); writeFileSync(join(process.env.HELM_DIR, 'config.json'), '{}'); }
});

test('a machine cannot use a hub introduction to impersonate another machine', { timeout: 10_000 }, async context => {
  N.createNetwork({ name: 'target', port: 8787 });
  writeFileSync(join(process.env.HELM_DIR, 'config.json'), '{}');
  const net = N.loadNetwork();
  const attacker = 'aabbcc112233', victim = 'ddeeff445566';
  for (const id of [attacker, victim]) net.machines[id] = { id, name: id, endpoints: [] };
  N.saveNetwork(net);
  const hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB, openLogin: false });
  const url = `http://127.0.0.1:${hub.server.address().port}`;
  const calls = [];
  let target, sender;
  const peers = new PeerHub((peer, payload) => target.send(T.SIGNAL, { peer, payload }),
    async (method, params, caller) => { calls.push(caller); return caller; },
    { authorize: (device, frame) => directCaller(N.loadNetwork(), device, frame.sub) });
  const daemon = new Daemon();
  daemon.port = hub.server.address().port;
  daemon.peers = peers;
  daemon.describe = async () => ({ directRpc: 1 });
  daemon.onLinkUp = () => {};
  daemon.linkDown = () => {};
  target = new Link(daemon, url).start();
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws', {
    headers: { authorization: `Bearer ${N.machineToken({ ...net, self: attacker })}` },
  });
  socket.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.t === T.HUB_SIGNAL) void sender?.receive(frame.payload);
  });
  context.after(() => { sender?.close(); socket.terminate(); target.stop(); peers.stop(); hub.stop(); });
  await until(() => hub.online.has(net.self) && hub.online.has(attacker));
  sender = directPeer({
    signal: payload => socket.send(JSON.stringify({ t: T.HUB_SIGNAL, env: net.self, peer: 'spoof', device: victim, payload })),
    onMessage() {}, connectTimeout: 500,
  });
  if (await sender.ready.then(() => true, () => false)) {
    await sender.send({ t: T.RPC, id: 'spoofed-call', method: 'session.list', sub: victim });
    await until(() => calls.length > 0);
  }
  assert.deepEqual(calls, []);
  await assert.rejects(sender.ready);
  assert.equal(peers.count, 0);
});

test('machine offer signatures bind the source, network, target, negotiation and DTLS fingerprint', () => {
  const net = N.createNetwork({ name: 'source', port: 8787 });
  net.machines[net.self].codeSignPubkey = codeSigningInfo().codeSignPubkey;
  const target = 'aabbcc112233';
  const receiver = { ...net, self: target };
  const offer = signDirectOffer(net, target, { type: 'offer', sdp: 'a=fingerprint:sha-256 original', negotiation: 'fresh' });
  assert.equal(allowDirectSignal(receiver, net.self, offer), true);
  assert.equal(allowDirectSignal(receiver, net.self, { ...offer, sdp: 'a=fingerprint:sha-256 attacker' }), false);
  assert.equal(allowDirectSignal(receiver, net.self, { ...offer, negotiation: 'replay-elsewhere' }), false);
  assert.equal(allowDirectSignal({ ...receiver, id: 'other-network' }, net.self, offer), false);
  assert.equal(allowDirectSignal({ ...receiver, self: 'other-target' }, net.self, offer), false);
  assert.equal(allowDirectSignal(receiver, target, offer), false);
  assert.equal(allowDirectSignal(receiver, net.self, offer, false), false);
  assert.equal(allowDirectSignal({ ...receiver, revoked: { [net.self]: true } }, net.self, offer), false);
  assert.equal(allowDirectSignal(receiver, net.self, { type: 'offer', sdp: offer.sdp }), false, 'unsigned older callers keep the hub');
  const attackerKey = generateKeyPairSync('ed25519');
  const signature = sign(null, Buffer.from('not this offer'), attackerKey.privateKey).toString('base64url');
  assert.equal(allowDirectSignal(receiver, net.self, { ...offer, machineAuth: { ...offer.machineAuth, signature } }), false);
});

test('half-dead direct channels time out their keepalive and release outstanding writes', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const mesh = new DirectMesh({ network: () => ({ self: 'a', machines: { a: {}, b: {} } }),
    supports: () => true, signal() {}, makePeer: () => ({ ready: Promise.resolve(), close() {},
      async send(frame, onStart) { onStart(); },
    }),
  });
  mesh.want('b');
  await new Promise(setImmediate);
  const pending = mesh.call('b', 'session.input', {});
  const rejected = assert.rejects(pending, error => error.uncertain === true && error.code === 'disconnected');
  // Exercise the actual ping timeout without waiting ten seconds.
  context.mock.timers.tick(10_001);
  await rejected;
  assert.equal(mesh.channels.size, 0);
  assert.equal(mesh.waits.size, 1);
  mesh.stop();
});

test('malformed direct frames cannot crash the receiving daemon', async () => {
  const child = fork(new URL('./fixtures/direct-malformed.mjs', import.meta.url), [], {
    env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, stderr);
});

test('concurrent large replies on a persistent channel all arrive', { timeout: 10_000 }, async context => {
  let sender;
  const responses = [];
  const payload = 'x'.repeat(4 * 1024 * 1024);
  const receiver = new PeerHub((_id, blob) => void sender.receive(blob), async () => payload);
  context.after(() => { sender?.close(); receiver.stop(); });
  sender = directPeer({ signal: blob => void receiver.signal('large', blob, null, 'device'),
    onMessage: frame => responses.push(frame) });
  await sender.ready;
  await Promise.all(Array.from({ length: 12 }, (_, id) => sender.send({ t: T.RPC, id, method: 'session.events' })));
  await until(() => responses.length === 12);
  assert.equal(new Set(responses.map(frame => frame.id)).size, 12);
  assert.equal(responses.every(frame => frame.ok && frame.result === payload), true);
});

test('unsigned browser channels still work and cannot request hub-only share secrets or another identity', async context => {
  const net = N.createNetwork({ name: 'target', port: 8787 });
  const phone = N.issueDevice(net, 'browser');
  writeFileSync(join(process.env.HELM_DIR, 'config.json'), '{}');
  const daemon = new Daemon();
  // Stored fixture: this test checks access to its password hash, not a
  // running app or the port check performed when publishing a new spin.
  const { addShare } = await import('../packages/connect/src/shares.js');
  addShare({ name: 'review-share', port: 12345, password: 'fixture-password' });
  let sender;
  const frames = [];
  daemon.peers = new PeerHub((_id, payload) => void sender.receive(payload),
    (method, params, caller) => daemon.dispatch(method, params, caller), {
      authorize: (device, frame) => directCaller(N.loadNetwork(), device, frame.sub),
      events: device => !Object.hasOwn(N.loadNetwork().machines, device),
    });
  const link = {};
  context.after(() => { sender?.close(); daemon.peers.stop(); });
  sender = directPeer({ signal: payload => void daemon.onFrame(link, { t: T.SIGNAL, peer: 'browser', device: phone.id, payload }),
    onMessage: frame => frames.push(frame) });
  await sender.ready;
  await sender.send({ t: T.RPC, id: 'list', method: M.SHARE_LIST, params: { forHub: true } });
  await until(() => frames.some(frame => frame.id === 'list'));
  const share = frames.find(frame => frame.id === 'list').result.shares[0];
  assert.equal(share.password, true);
  assert.equal(share.lock, undefined);
  await sender.send({ t: T.RPC, id: 'spoof', method: M.SHARE_LIST, sub: net.self });
  await until(() => frames.some(frame => frame.id === 'spoof'));
  assert.equal(frames.find(frame => frame.id === 'spoof').error.code, 'forbidden');
  daemon.peers.broadcast('fixture', { visible: true }, 'event-id');
  await until(() => frames.some(frame => frame.t === 'event'));
});
