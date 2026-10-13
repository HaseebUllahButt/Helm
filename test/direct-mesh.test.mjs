import test from 'node:test';
import assert from 'node:assert/strict';
import { HubMesh, routeLines } from '../packages/connect/src/hub-mesh.js';
import { directCaller } from '../packages/connect/src/peer.js';
import { T } from '@helm/protocol';

/**
 * Direct channels between machines, with the hub as the backup. These pin
 * down when a request takes the channel (only once it is open, timed and
 * clearly faster than the hub), that a write whose fate is unknown is never
 * sent again over the hub, that reads and never-sent requests do move, and
 * that an older machine or a revoked one never gets a channel at all.
 */
function fakePeers() {
  const made = [];
  const makePeer = ({ signal, onMessage, onClose }) => {
    let opened, failed;
    const ready = new Promise((resolve, reject) => { opened = resolve; failed = reject; });
    ready.catch(() => {});
    const peer = {
      signal, sent: [], received: [], closed: false, ready, refuse: null,
      open() { opened(); },
      send(frame, onStart) {
        if (this.closed || this.refuse === 'unsent') return Promise.reject(Object.assign(new Error('closed'), { unsent: true }));
        onStart?.();
        this.sent.push(frame);
        return Promise.resolve();
      },
      answer(id, result = {}) { onMessage({ t: 'rpcResult', id, ok: true, result }); },
      die() {
        if (this.closed) return;
        this.closed = true;
        failed(new Error('direct channel closed'));
        onClose();
      },
      close() { this.die(); },
      async receive(payload) { this.received.push(payload); },
    };
    made.push(peer);
    return peer;
  };
  return { made, makePeer };
}

function fixture({ info = { directRpc: 1 } } = {}) {
  const network = {
    self: 'local',
    machines: { local: {}, remote: { endpoints: ['http://192.168.1.9:8787'] }, third: {} },
    devices: { phone: {} },
    revoked: {},
  };
  let clock = 0;
  const peers = fakePeers();
  const signals = [];
  const mesh = new HubMesh(() => network, () => {}, () => {}, (frame) => signals.push(frame),
    { now: () => clock, probeEvery: 0, direct: { makePeer: peers.makePeer } });
  const link = (url) => ({ url, connected: true, sent: [], send(type, payload) { this.sent.push({ t: type, ...payload }); } });
  const hub = link('http://192.168.1.9:8787');
  mesh.up(hub);
  mesh.receive(hub, { t: T.HUB_STATE, machines: [{ id: 'remote', info }] });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const answerHub = async (method = 'ping', result = { t: 0 }) => {
    for (const frame of hub.sent.filter(f => f.t === T.HUB_RPC && f.method === method)) {
      if (mesh.pending.has(frame.id)) mesh.receive(hub, { t: T.RPC_RESULT, id: frame.id, ok: true, result });
    }
    await settle();
  };
  const answerDirect = async (peer, method = 'ping', result = { t: 0 }) => {
    for (const frame of peer.sent.filter(f => f.method === method)) peer.answer(frame.id, result);
    await settle();
  };
  const tick = (ms) => { clock += ms; };
  /** A channel up and timed: direct `directMs`, the hub `hubMs`. */
  const timed = async (directMs, hubMs) => {
    mesh.call('remote', 'session.list', {}).catch(() => {});
    await answerHub('session.list', { sessions: [] });
    const peer = peers.made.at(-1);
    peer.open();
    await settle();
    const [first, second] = directMs < hubMs ? [directMs, hubMs] : [hubMs, directMs];
    tick(first);
    if (directMs < hubMs) await answerDirect(peer); else await answerHub();
    tick(second - first);
    if (directMs < hubMs) await answerHub(); else await answerDirect(peer);
    return peer;
  };
  return { mesh, network, hub, peers, signals, settle, answerHub, answerDirect, tick, timed, now: () => clock };
}

test('a machine on an older Helm never gets a channel and keeps the hub', async () => {
  const { mesh, hub, peers, answerHub } = fixture({ info: { version: 'old' } });
  const result = mesh.call('remote', 'session.list', {});
  await answerHub('session.list', { sessions: ['a'] });
  assert.deepEqual(await result, { sessions: ['a'] });
  assert.equal(peers.made.length, 0);
  assert.equal(mesh.supportsDirect('remote'), false);
  const [row] = mesh.table();
  assert.deepEqual(row.direct, { state: 'unsupported', ms: null, used: false });
  assert.match(routeLines({ machines: [{ ...row, name: 'vm' }] })[0], /\n\s+direct: not offered there \(older Helm, or switched off\), hub only/);
  assert.equal(hub.sent.filter(f => f.t === T.HUB_SIGNAL).length, 0);
  mesh.stop();
});

test('the channel opens in the background and wins only once it is measured faster', async () => {
  const { mesh, hub, peers, signals, timed, answerDirect } = fixture();
  const peer = await timed(5, 600);
  // The first request took the hub; it is what asked for the channel.
  assert.equal(hub.sent.filter(f => f.method === 'session.list').length, 1);
  // Signalling went out through the hub, in this machine's own name.
  peer.signal({ type: 'offer', sdp: 'x' });
  const offer = hub.sent.find(f => f.t === T.HUB_SIGNAL);
  assert.equal(offer.device, 'local');
  assert.equal(offer.env, 'remote');
  // The answer comes back for the channel, not for a phone on our hub.
  mesh.receive(hub, { t: T.HUB_SIGNAL, peer: offer.peer, env: 'remote', kind: T.SIGNAL, payload: { type: 'answer' } });
  assert.deepEqual(peer.received, [{ type: 'answer' }]);
  assert.equal(signals.length, 0);

  const next = mesh.call('remote', 'session.list', {});
  assert.equal(peer.sent.at(-1).method, 'session.list');
  assert.equal(peer.sent.at(-1).sub, 'local');
  await answerDirect(peer, 'session.list', { sessions: ['direct'] });
  assert.deepEqual(await next, { sessions: ['direct'] });
  assert.equal(hub.sent.filter(f => f.method === 'session.list').length, 1, 'the hub did not see it');

  const [row] = mesh.table();
  assert.deepEqual(row.direct, { state: 'open', ms: 5, used: true });
  const lines = routeLines({ machines: [{ ...row, name: 'vm' }] });
  assert.match(lines[0], /^ {2}vm\s+direct {2}5ms\n\s+backup: via its own hub http:\/\/192\.168\.1\.9:8787 {2}600ms$/);
  mesh.stop();
});

test('a direct path that is not faster - one crossing the same VPN - is not used', async () => {
  const { mesh, hub, peers, timed } = fixture();
  await timed(600, 40);
  mesh.call('remote', 'git.status', {}).catch(() => {});
  assert.equal(hub.sent.at(-1).method, 'git.status');
  assert.equal(peers.made[0].sent.filter(f => f.method === 'git.status').length, 0);
  const [row] = mesh.table();
  assert.equal(row.direct.used, false);
  assert.match(routeLines({ machines: [{ ...row, name: 'vm' }] })[0], /direct 600ms, not faster so not used/);
  mesh.stop();
});

test('a write in flight when the channel dies fails as uncertain and is never sent over the hub', async () => {
  const { mesh, hub, peers, timed, tick } = fixture();
  const peer = await timed(5, 600);
  const write = mesh.call('remote', 'session.input', { text: 'once' });
  assert.equal(peer.sent.at(-1).method, 'session.input');
  peer.die();
  await assert.rejects(write, (error) => error.uncertain === true && /uncertain/.test(error.message));
  assert.equal(hub.sent.filter(f => f.method === 'session.input').length, 0);
  // New requests take the hub; the channel is tried again after a wait.
  mesh.call('remote', 'session.input', { text: 'next' }).catch(() => {});
  assert.equal(hub.sent.at(-1).params.text, 'next');
  assert.equal(peers.made.length, 1, 'not straight away');
  tick(60_000);
  mesh.call('remote', 'session.list', {}).catch(() => {});
  assert.equal(peers.made.length, 2);
  mesh.stop();
});

test('a read in flight when the channel dies is asked again over the hub', async () => {
  const { mesh, hub, peers, timed, answerHub } = fixture();
  const peer = await timed(5, 600);
  const read = mesh.call('remote', 'session.events', { id: 's' });
  peer.die();
  await new Promise(resolve => setImmediate(resolve));
  await answerHub('session.events', { events: ['from the hub'] });
  assert.deepEqual(await read, { events: ['from the hub'] });
  assert.equal(peers.made.length, 1);
  mesh.stop();
});

test('a write that never left the channel goes over the hub instead', async () => {
  const { mesh, hub, timed, answerHub } = fixture();
  const peer = await timed(5, 600);
  peer.refuse = 'unsent';
  const write = mesh.call('remote', 'session.input', { text: 'once' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peer.sent.filter(f => f.method === 'session.input').length, 0);
  await answerHub('session.input', { ok: true });
  assert.deepEqual(await write, { ok: true });
  assert.equal(hub.sent.filter(f => f.method === 'session.input').length, 1);
  mesh.stop();
});

test('a phone\'s request goes direct in its name; one passed on for another machine stays on the hub', async () => {
  const { mesh, hub, timed } = fixture();
  const peer = await timed(5, 600);
  mesh.call('remote', 'session.list', {}, { sub: 'phone' }).catch(() => {});
  assert.equal(peer.sent.at(-1).sub, 'phone');
  mesh.call('remote', 'session.list', {}, { sub: 'third' }).catch(() => {});
  assert.equal(hub.sent.at(-1).sub, 'third');
  assert.equal(peer.sent.filter(f => f.sub === 'third').length, 0);
  mesh.stop();
});

test('a revoked machine loses its channel and never gets another', async () => {
  const { mesh, network, peers, timed, tick } = fixture();
  const peer = await timed(5, 600);
  network.revoked.remote = true;
  mesh.dropRevoked(network.revoked);
  assert.equal(peer.closed, true);
  assert.equal(mesh.direct.channels.size, 0);
  await assert.rejects(mesh.call('remote', 'session.list', {}), /unknown machine/);
  tick(10 * 60_000);
  mesh.direct.want('remote');
  mesh.direct.tick();
  assert.equal(peers.made.length, 1);
  mesh.stop();
});

test('an idle channel is closed, and one that will not connect backs off', async () => {
  const { mesh, peers, timed, tick, now } = fixture();
  const peer = await timed(5, 600);
  tick(16 * 60_000);
  mesh.direct.tick();
  assert.equal(peer.closed, true);
  assert.equal(mesh.direct.waits.has('remote'), false, 'closing an idle channel is no failure');
  // Asked again: a fresh channel that never connects is retried later and later.
  mesh.call('remote', 'session.list', {}).catch(() => {});
  assert.equal(peers.made.length, 2);
  peers.made.at(-1).die();
  const waits = [];
  for (let round = 0; round < 3; round++) {
    const { retryAt } = mesh.direct.waits.get('remote');
    waits.push(retryAt - now());
    mesh.direct.tick();
    assert.equal(peers.made.length, 2 + round, 'nothing before the wait is over');
    tick(retryAt - now() + 1);
    mesh.direct.tick();
    assert.equal(peers.made.length, 3 + round);
    peers.made.at(-1).die();
  }
  assert.ok(waits[2] > waits[0] * 2, `waits grow: ${waits.map(Math.round)}`);
  assert.equal(mesh.table()[0].direct.state, 'retrying');
  mesh.stop();
});

test('a direct request is checked against who the hub introduced, not what it says', () => {
  const net = { self: 'b', machines: { a: {}, b: {}, c: {} }, devices: { phone: {}, gone: {} }, revoked: { gone: true, old: true } };
  assert.equal(directCaller(net, 'a', undefined), 'a');
  assert.equal(directCaller(net, 'a', 'a'), 'a');
  // A machine passes on a phone's request, as it may through a hub.
  assert.equal(directCaller(net, 'a', 'phone'), 'phone');
  // It may not speak for another machine, a revoked device, or a stranger.
  assert.throws(() => directCaller(net, 'a', 'c'), { code: 'forbidden' });
  assert.throws(() => directCaller({ ...net, devices: { ...net.devices, c: {} } }, 'a', 'c'), { code: 'forbidden' });
  assert.throws(() => directCaller(net, 'a', 'gone'), { code: 'forbidden' });
  assert.throws(() => directCaller(net, 'a', 'nobody'), { code: 'forbidden' });
  // A phone's own channel cannot claim to be anyone else.
  assert.throws(() => directCaller(net, 'phone', 'a'), { code: 'forbidden' });
  assert.equal(directCaller(net, 'phone', undefined), 'phone');
  // A revoked caller is refused on the very next request.
  assert.throws(() => directCaller(net, 'old', undefined), { code: 'forbidden' });
  assert.throws(() => directCaller({ ...net, revoked: { b: true } }, 'a', undefined), { code: 'forbidden' });
  assert.throws(() => directCaller(net, 'stranger', undefined), { code: 'forbidden' });
  assert.throws(() => directCaller(net, 'a', undefined, false), { code: 'forbidden' });
  assert.equal(directCaller(net, 'phone', undefined, false), 'phone');
});

test('losing every hub presence fails offline even with an open direct channel', async () => {
  const { mesh, hub, timed } = fixture();
  const peer = await timed(5, 600);
  mesh.receive(hub, { t: T.HUB_STATE, machines: [] });
  const before = peer.sent.length;
  assert.equal(mesh.direct.isOpen('remote'), true);
  await assert.rejects(mesh.call('remote', 'session.input', {}), { code: 'offline' });
  assert.equal(peer.sent.length, before);
  mesh.stop();
});

test('revocation clears failed-channel backoff bookkeeping', async () => {
  const { mesh, network, peers, timed } = fixture();
  const peer = await timed(5, 600);
  peer.die();
  assert.equal(mesh.direct.waits.size, 1);
  network.revoked.remote = true;
  mesh.dropRevoked(network.revoked);
  assert.equal(mesh.direct.waits.size, 0);
  assert.equal(mesh.direct.used.size, 0);
  assert.equal(peers.made.length, 1);
  mesh.stop();
});
