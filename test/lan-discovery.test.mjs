import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-lan-'));
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
process.env.HELM_DB = join(process.env.HELM_DIR, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';
await import('./fixtures/loopback-rtc.mjs');

const { LanDiscovery, withHeardAddresses, sealPacket, openPacket, localSignalRouter, CLOCK_WINDOW_MS } = await import('../packages/connect/src/lan-discovery.js');
const N = await import('@helm/protocol/network');
const { T } = await import('@helm/protocol');
const { DirectMesh } = await import('../packages/connect/src/direct-mesh.js');
const { PeerHub, directCaller } = await import('../packages/connect/src/peer.js');
const { allowDirectSignal } = await import('../packages/connect/src/direct-auth.js');
const { codeSigningInfo } = await import('../packages/connect/src/code-transfer.js');
const { cleanup } = await import('node-datachannel');
test.after(() => { cleanup(); rmSync(process.env.HELM_DIR, { recursive: true, force: true }); });

/**
 * Machines on one Wi-Fi find each other and carry direct-link setup by
 * datagram. Everything here talks over loopback on ports picked for the
 * test, so nothing is ever said on the real network.
 */
const key = 'k'.repeat(43);
const pair = () => {
  const p = generateKeyPairSync('ed25519');
  return { privateKey: p.privateKey, pub: p.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
};
const keys = { laptop: pair(), homepc: pair(), gone: pair() };
const roster = (self, extra = {}) => ({
  id: 'net1', key, self,
  machines: {
    laptop: { endpoints: ['https://laptop.example'], codeSignPubkey: keys.laptop.pub },
    homepc: { endpoints: [], codeSignPubkey: keys.homepc.pub },
    gone: { endpoints: [], codeSignPubkey: keys.gone.pub },
  },
  revoked: { gone: 1 },
  ...extra,
});

async function freePort() {
  const s = dgram.createSocket('udp4');
  await new Promise(resolve => s.bind(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise(resolve => s.close(resolve));
  return port;
}

const until = async (check, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('condition timed out');
};

function node(self, discoveryPort, peerPort, extra = {}) {
  const peers = [], signals = [];
  const lan = new LanDiscovery({
    network: () => roster(self), discoveryPort, bindAddress: '127.0.0.1',
    targets: () => [{ address: '127.0.0.1', port: peerPort }],
    accept: () => true, enabled: () => true, routable: async () => ({ ok: true }),
    signingKey: () => keys[self].privateKey,
    onPeer: id => peers.push(id), onSignal: s => signals.push(s), every: 60_000, ...extra,
  });
  return { lan, peers, signals };
}

/** A raw sender, to play a stranger, a replay or a machine with a bad key. */
async function raw(port) {
  const s = dgram.createSocket('udp4');
  await new Promise(resolve => s.bind(0, '127.0.0.1', resolve));
  return {
    send: buf => new Promise(resolve => s.send(buf, port, '127.0.0.1', resolve)),
    close: () => s.close(),
  };
}
const message = (fields) => ({ k: 'signal', from: 'homepc', to: 'laptop', side: 'dial', peer: 'dm-1', payload: { type: 'candidate', candidate: { candidate: 'x' } }, at: Date.now(), nonce: Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32), ...fields });

test('two machines hear each other, and the newcomer is answered at once', async () => {
  const [pa, pb] = [await freePort(), await freePort()];
  const a = node('laptop', pa, pb);
  const b = node('homepc', pb, pa);
  await a.lan.start();
  // A's first hello goes nowhere: B is not listening yet. B starting later
  // must still learn about A without waiting a full round - A answers B.
  await b.lan.start();
  await until(() => a.lan.list().length && b.lan.list().length);
  assert.deepEqual(a.lan.list().map(({ id, address, port }) => ({ id, address, port })), [{ id: 'homepc', address: '127.0.0.1', port: pb }]);
  assert.deepEqual(b.lan.list().map(({ id, address, port }) => ({ id, address, port })), [{ id: 'laptop', address: '127.0.0.1', port: pa }]);
  assert.equal(a.lan.ready('homepc'), true);
  assert.deepEqual(a.peers, ['homepc']);
  const status = a.lan.status();
  assert.equal(status.on, true);
  assert.deepEqual(status.heard.map(h => [h.id, h.address]), [['homepc', '127.0.0.1']]);
  a.lan.stop();
  b.lan.stop();
});

test('a machine that restarts hears the others at once, even ones that already knew it', async () => {
  const [pa, pb] = [await freePort(), await freePort()];
  const a = node('laptop', pa, pb);
  const b = node('homepc', pb, pa);
  await a.lan.start();
  await b.lan.start();
  await until(() => a.lan.list().length && b.lan.list().length);
  a.lan.stop();
  const again = node('laptop', pa, pb);
  await again.lan.start();
  await until(() => again.lan.list().length, 1500);
  assert.deepEqual(again.peers, ['homepc']);
  again.lan.stop();
  b.lan.stop();
});

test('setup messages reach the other machine, and only ever the one they name', async () => {
  const [pa, pb] = [await freePort(), await freePort()];
  const a = node('laptop', pa, pb);
  const b = node('homepc', pb, pa);
  assert.equal(a.lan.signal('homepc', 'dial', 'dm-1', { type: 'offer' }), null, 'not started: the hub carries it');
  await a.lan.start();
  await b.lan.start();
  await until(() => a.lan.ready('homepc') && b.lan.ready('laptop'));
  assert.equal(a.lan.signal('homepc', 'dial', 'dm-1', { type: 'offer', sdp: 'v=0', negotiation: 'n1' }), `127.0.0.1:${pb}`);
  await until(() => b.signals.length);
  assert.deepEqual(b.signals, [{ from: 'laptop', side: 'dial', peer: 'dm-1', payload: { type: 'offer', sdp: 'v=0', negotiation: 'n1' } }]);
  assert.equal(a.lan.signal('stranger', 'dial', 'dm-1', {}), null, 'never heard: not sent');
  assert.equal(a.lan.signal('homepc', 'dial', 'dm-1', { sdp: 'x'.repeat(20_000) }), null, 'too big for one datagram');
  a.lan.stop();
  b.lan.stop();
});

test('packets are sealed: no machine id, network id or setup text is readable on the Wi-Fi', () => {
  const net = roster('homepc');
  const packet = sealPacket(net, message({ payload: { type: 'offer', sdp: 'v=0 secret-sdp' } }), keys.homepc.privateKey);
  for (const word of ['homepc', 'laptop', 'net1', 'secret-sdp', 'offer']) assert.ok(!packet.includes(word), word);
  assert.equal(openPacket(net, packet).message.payload.sdp, 'v=0 secret-sdp');
  assert.equal(openPacket({ ...net, key: 'z'.repeat(43) }, packet), null, 'another network key cannot open it');
  assert.equal(openPacket({ ...net, id: 'net2' }, packet), null, 'another network cannot open it');
  const bent = Buffer.from(packet);
  bent[bent.length - 1] ^= 1;
  assert.equal(openPacket(net, bent), null, 'a changed byte fails');
});

test('a wrong key, a wrong signer, a replay, an old packet and a removed machine are all refused', async t => {
  const pa = await freePort();
  const a = node('laptop', pa, pa, { announce: false });
  await a.lan.start();
  const s = await raw(pa);
  t.after(() => { s.close(); a.lan.stop(); });
  const net = roster('homepc');
  const good = sealPacket(net, message({ peer: 'good' }), keys.homepc.privateKey);
  await s.send(Buffer.from(JSON.stringify({ helm: 'lan', v: 1, tag: 'old-format', port: 8787 })));
  await s.send(sealPacket({ ...net, key: 'z'.repeat(43) }, message({ peer: 'wrong-key' }), keys.homepc.privateKey));
  await s.send(sealPacket(net, message({ peer: 'wrong-signer' }), keys.laptop.privateKey));
  await s.send(sealPacket(net, message({ peer: 'old', at: Date.now() - CLOCK_WINDOW_MS - 5_000 }), keys.homepc.privateKey));
  await s.send(sealPacket(net, message({ peer: 'future', at: Date.now() + CLOCK_WINDOW_MS + 5_000 }), keys.homepc.privateKey));
  await s.send(sealPacket(net, message({ peer: 'revoked', from: 'gone' }), keys.gone.privateKey));
  await s.send(sealPacket(net, message({ peer: 'stranger', from: 'stranger' }), keys.homepc.privateKey));
  await s.send(sealPacket(net, message({ peer: 'not-for-us', to: 'homepc' }), keys.homepc.privateKey));
  await s.send(good);
  await s.send(good);
  // A last good one, so everything before it has certainly been read.
  await s.send(sealPacket(net, message({ peer: 'last' }), keys.homepc.privateKey));
  await until(() => a.signals.some(x => x.peer === 'last'));
  assert.deepEqual(a.signals.map(x => x.peer), ['good', 'last'], 'one copy of the replayed packet');
  assert.equal(a.lan.status().rejected, 9);
});

test('once this machine is removed, it neither sends nor accepts anything', async t => {
  const pa = await freePort();
  let net = roster('laptop');
  let heard = 0;
  const a = node('laptop', pa, pa, { announce: false, network: () => net, accept: () => { heard++; return true; } });
  await a.lan.start();
  const s = await raw(pa);
  t.after(() => { s.close(); a.lan.stop(); });
  await s.send(sealPacket(roster('homepc'), message({ peer: 'before' }), keys.homepc.privateKey));
  await until(() => a.signals.length === 1);
  net = roster('laptop', { revoked: { gone: 1, laptop: 1 } });
  await s.send(sealPacket(roster('homepc'), message({ peer: 'after' }), keys.homepc.privateKey));
  // The packet is read and dropped in one step, so once it is heard it is settled.
  await until(() => heard === 2);
  assert.deepEqual(a.signals.map(x => x.peer), ['before']);
  assert.equal(a.lan.signal('homepc', 'dial', 'dm', {}), null);
});

test('turning a VPN on or off immediately rechecks routing and clears old Wi-Fi hints', async () => {
  const pa = await freePort();
  let allowed = true, checked = 0;
  const a = node('laptop', pa, pa, { routable: async () => { checked++; return { ok: allowed }; } });
  try {
    await a.lan.start();
    a.lan.hints.set('homepc', { address: '192.168.1.9', port: 8787, seen: Date.now(), direct: true });
    allowed = false;
    await a.lan.networkChanged();
    assert.equal(a.lan.status().on, false);
    assert.equal(a.lan.list().length, 0);
    allowed = true;
    await a.lan.networkChanged();
    assert.equal(a.lan.status().on, true);
    assert.equal(checked, 3);
  } finally { a.lan.stop(); }
});

test('only private addresses count by default: loopback and the internet are not the local network', async () => {
  const pa = await freePort();
  const a = node('laptop', pa, pa, { accept: undefined, announce: false });
  const accept = a.lan.accept;
  let heard = 0;
  a.lan.accept = (address) => { heard++; return accept(address); };
  await a.lan.start();
  const s = await raw(pa);
  await s.send(sealPacket(roster('homepc'), message({ k: 'hello', to: null, direct: 1 }), keys.homepc.privateKey));
  await until(() => heard === 1);
  assert.equal(a.lan.list().length, 0);
  s.close();
  a.lan.stop();
});

test('heard machines expire, and turning it off or a VPN carrying the LAN stops it', async () => {
  const [pa, pb] = [await freePort(), await freePort()];
  let clock = Date.now();
  let on = true;
  let routed = true;
  const a = node('laptop', pa, pb, { now: () => clock, enabled: () => on, routable: async () => ({ ok: routed }) });
  const b = node('homepc', pb, pa);
  await a.lan.start();
  await b.lan.start();
  await until(() => a.lan.list().length);
  b.lan.stop();
  clock += 101_000;
  await a.lan.tick();
  assert.equal(a.lan.list().length, 0, 'expired');
  assert.equal(a.lan.ready('homepc'), false);

  on = false;
  await a.lan.tick();
  assert.deepEqual(a.lan.status(), { on: false, reason: 'turned off', heard: [], rejected: 0 });

  on = true;
  routed = false;
  clock += 5 * 60_000;
  await a.lan.tick();
  assert.equal(a.lan.status().on, false);
  assert.match(a.lan.status().reason, /VPN/);
  a.lan.stop();
});

test('multiple roster addresses keep only one live link per machine', () => {
  const net = { machines: { laptop: { endpoints: ['a', 'b'] } }, revoked: {} };
  const plan = withHeardAddresses({ urls: ['a', 'b'], net, self: 'vm', heard: [], connected: url => url === 'a' });
  assert.deepEqual(plan.urls, ['a']);
});

test('an offer heard on the local network passes the same check as a hub\'s', () => {
  const calls = [];
  const route = localSignalRouter({
    network: () => roster('laptop', { devices: { phone: {} } }),
    peers: () => ({ signal: (...args) => calls.push(args) }),
    direct: () => ({ receive: frame => calls.push(['answer', frame]) }),
    lan: () => ({ signal() {} }),
  });
  // Not signed for this machine with homepc's pinned key: refused.
  route({ from: 'homepc', side: 'dial', peer: 'dm-1', payload: { type: 'offer', sdp: 'v=0', negotiation: 'n' } });
  route({ from: 'phone', side: 'dial', peer: 'dm-1', payload: { type: 'candidate', candidate: {} } });
  assert.equal(calls.length, 0);
  // Later setup messages pass, as a hub's do, in the sender's name.
  route({ from: 'homepc', side: 'dial', peer: 'dm-1', payload: { type: 'candidate', candidate: {} } });
  assert.equal(calls[0][0], 'lan-homepc-dm-1');
  assert.equal(calls[0][3], 'homepc');
  route({ from: 'homepc', side: 'answer', peer: 'dm-9', payload: { type: 'answer' } });
  assert.deepEqual(calls[1], ['answer', { env: 'homepc', peer: 'dm-9', payload: { type: 'answer' } }]);
});

/**
 * The 2026-11-18 case: two machines on one Wi-Fi, and the only hub between
 * them is the VM over a lossy path. Each setup message through the hub took
 * 8 s or more, so the 15 s connect timed out with "no answer". Here the hub
 * holds every setup message for 10 s; the link must open over the local
 * network well before that, and the late hub copy must not make a second.
 */
test('a direct link opens in about a second when the hub path is 10 s late', { timeout: 30_000 }, async t => {
  const net = N.createNetwork({ name: 'laptop', port: 8787 });
  const self = net.self, other = 'aabbcc112233';
  net.machines[self].codeSignPubkey = codeSigningInfo().codeSignPubkey;
  // One process plays both machines, so both sign with the same key.
  net.machines[other] = { id: other, name: 'homepc', endpoints: [], codeSignPubkey: codeSigningInfo().codeSignPubkey };
  N.saveNetwork(net);
  const netA = () => N.loadNetwork();
  const netB = () => ({ ...N.loadNetwork(), self: other });
  const [pa, pb] = [await freePort(), await freePort()];
  const base = { bindAddress: '127.0.0.1', accept: () => true, enabled: () => true, routable: async () => ({ ok: true }), every: 60_000 };

  const late = [];
  const hubLink = { sent: [], send(type, frame) { this.sent.push({ type, ...frame }); } };
  const deliverLate = async () => {
    for (const { peer, payload } of late.splice(0)) {
      if (allowDirectSignal(netB(), self, payload)) await peersB.signal(`hub-${peer}`, payload, hubLink, self);
    }
  };
  const held = setTimeout(deliverLate, 10_000);
  const served = [];
  const peersB = new PeerHub((peer, payload, link) => link.send(T.SIGNAL, { peer, payload }),
    async (method, params, caller) => { served.push([method, caller]); return { t: 1 }; },
    { authorize: (device, frame, credential) => directCaller(netB(), device, frame.sub, true, credential), events: () => false });
  let lanA, lanB, mesh;
  const local = {
    signal: (env, peer, payload) => lanA.signal(env, 'dial', peer, payload),
    ready: env => lanA.ready(env),
    where: env => lanA.where(env),
  };
  // The hub has not even said yet that the other machine takes direct links.
  mesh = new DirectMesh({ network: netA, supports: () => false, local, signal: (env, peer, payload) => late.push({ peer, payload }) });
  lanB = new LanDiscovery({ ...base, network: netB, discoveryPort: pb, targets: () => [{ address: '127.0.0.1', port: pa }],
    onSignal: localSignalRouter({ network: netB, peers: () => peersB, direct: () => null, lan: () => lanB }) });
  lanA = new LanDiscovery({ ...base, network: netA, discoveryPort: pa, targets: () => [{ address: '127.0.0.1', port: pb }],
    onPeer: id => mesh.heard(id),
    onSignal: localSignalRouter({ network: netA, peers: () => null, direct: () => mesh, lan: () => lanA }) });
  t.after(() => { clearTimeout(held); mesh.stop(); peersB.stop(); lanA.stop(); lanB.stop(); });

  const started = performance.now();
  await lanB.start();
  await lanA.start();
  await until(() => mesh.isOpen(other), 9_000);
  const ms = performance.now() - started;
  assert.ok(ms < 3_000, `opened in ${Math.round(ms)}ms`);
  assert.ok(late.length > 0, 'the hub copies are still held');
  assert.deepEqual(await mesh.call(other, 'ping', {}, { sub: self }), { t: 1 });
  assert.deepEqual(served.at(-1), ['ping', self]);

  // The hub's copy of the same offer arrives late: no second connection, and
  // the answer is sent on the hub route too, in case that is the one that works.
  assert.equal(peersB.count, 1);
  clearTimeout(held);
  await deliverLate();
  assert.equal(peersB.count, 1);
  assert.ok(hubLink.sent.some(f => f.type === T.SIGNAL && f.payload.type === 'answer' && f.peer.startsWith('hub-dm-')));
  assert.equal(mesh.isOpen(other), true);
});
