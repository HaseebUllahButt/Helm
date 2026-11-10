import test from 'node:test';
import assert from 'node:assert/strict';
import { HubMesh } from '../packages/connect/src/hub-mesh.js';
import { T, M } from '@helm/protocol';

function fixture() {
  const network = { self: 'local', machines: { local: {}, remote: {}, revoked: {} }, revoked: { revoked: 1 } };
  const events = [];
  let changes = 0;
  const mesh = new HubMesh(() => network, () => changes++, frame => events.push(frame));
  const link = { connected: true, sent: [], send(type, payload) { this.sent.push({ t: type, ...payload }); } };
  mesh.up(link);
  const advertise = (source = link) => mesh.receive(source, {
    t: T.HUB_STATE, machines: ['local', 'remote', 'revoked', 'unknown'].map(id => ({ id, info: { version: 'test' } })),
  });
  return { mesh, link, network, events, advertise, changes: () => changes };
}

test('mesh advertises only authenticated, live remote routes after a capability snapshot', () => {
  const { mesh, link, advertise, network } = fixture();
  assert.equal(mesh.machines().size, 0);
  assert.deepEqual(link.sent[0], { t: T.HUB_WATCH, envs: [] });
  advertise();
  assert.deepEqual([...mesh.machines().keys()], ['remote']);
  network.revoked.remote = 1;
  assert.equal(mesh.machines().size, 0);
  delete network.revoked.remote;
  link.connected = false;
  assert.equal(mesh.machines().size, 0);
});

test('mesh preserves the caller and accepts replies only from the selected link', async () => {
  const { mesh, link, advertise } = fixture();
  advertise();
  const result = mesh.call('remote', 'session.input', { data: 'hello' }, { sub: 'phone' });
  const request = link.sent.at(-1);
  assert.equal(request.sub, 'phone');
  assert.equal(request.t, T.HUB_RPC);
  const stranger = { connected: true, send() {} };
  mesh.up(stranger);
  assert.equal(mesh.receive(stranger, { t: T.RPC_RESULT, id: request.id, ok: true, result: 'forged' }), false);
  mesh.receive(link, { t: T.RPC_RESULT, id: request.id, ok: true, result: 'delivered' });
  assert.equal(await result, 'delivered');
  assert.equal(mesh.pending.size, 0);
  mesh.stop();
});

test('link loss withdraws routes, rejects uncertain writes without replay, and allows subsequent alternate routing', async () => {
  const { mesh, link, advertise } = fixture();
  const alternate = { connected: true, sent: [], send(type, payload) { this.sent.push({ t: type, ...payload }); } };
  mesh.up(alternate);
  advertise();
  advertise(alternate);
  const result = mesh.call('remote', 'session.input', {});
  const rejection = assert.rejects(result, /delivery may be uncertain/);
  mesh.down(link);
  await rejection;
  // Route timing pings may go both ways; the write itself must not.
  assert.equal(alternate.sent.filter(frame => frame.t === T.HUB_RPC && frame.method === 'session.input').length, 0);
  const next = mesh.call('remote', 'session.list', {});
  const request = alternate.sent.at(-1);
  mesh.receive(alternate, { t: T.RPC_RESULT, id: request.id, ok: true, result: [] });
  assert.deepEqual(await next, []);
  mesh.down(alternate);
  assert.equal(mesh.machines().size, 0);
  await assert.rejects(mesh.call('remote', 'session.list', {}), /not connected/);
});

test('mesh forwards subscriptions and filters events from unknown or revoked machines', () => {
  const { mesh, link, advertise, events } = fixture();
  advertise();
  mesh.watch(new Set(['remote']));
  assert.deepEqual(link.sent.at(-1), { t: T.HUB_WATCH, envs: ['remote'] });
  for (const env of ['remote', 'revoked', 'unknown']) mesh.receive(link, { t: T.HUB_EVENT, env });
  assert.deepEqual(events.map(frame => frame.env), ['remote']);
  mesh.stop();
});

test('mesh timeouts release waiters and ignore late replies', async () => {
  const { mesh, link, advertise } = fixture();
  advertise();
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(mesh.call('remote', 'session.rename', {}, { timeout: 10 }), /timed out/);
    assert.equal(mesh.pending.size, 0);
    assert.equal(mesh.receive(link, { t: T.RPC_RESULT, id: link.sent.at(-1).id, ok: true }), false);
  } finally {
    clearTimeout(keepAlive);
    mesh.stop();
  }
});

test('a repeated read waits for the reply already on its way instead of asking again', async () => {
  const { mesh, link, advertise } = fixture();
  advertise();
  const keepAlive = setTimeout(() => {}, 1000);
  const asks = () => link.sent.filter(frame => frame.t === T.HUB_RPC && frame.method === 'session.list');
  try {
    // The device stops waiting, but the big reply is still on its way.
    await assert.rejects(mesh.call('remote', 'session.list', { have: 'a' }, { sub: 'phone', timeout: 10 }), /timed out/);
    const again = mesh.call('remote', 'session.list', { have: 'a' }, { sub: 'phone' });
    const hedge = mesh.call('remote', 'session.list', { have: 'a' }, { sub: 'phone' });
    // Another device, or other words, are other questions.
    const other = mesh.call('remote', 'session.list', { have: 'a' }, { sub: 'laptop' });
    const changed = mesh.call('remote', 'session.list', { have: 'b' }, { sub: 'phone' });
    assert.equal(asks().length, 3);
    mesh.receive(link, { t: T.RPC_RESULT, id: asks()[0].id, ok: true, result: 'list' });
    assert.deepEqual(await Promise.all([again, hedge]), ['list', 'list']);
    for (const frame of asks().slice(1)) mesh.receive(link, { t: T.RPC_RESULT, id: frame.id, ok: true, result: 'other' });
    assert.deepEqual(await Promise.all([other, changed]), ['other', 'other']);
    // With the reply in, the next read asks the machine again.
    void mesh.call('remote', 'session.list', { have: 'a' }, { sub: 'phone' }).catch(() => {});
    assert.equal(asks().length, 4);
  } finally {
    clearTimeout(keepAlive);
    mesh.stop();
  }
});

test('a change to a machine makes its next read ask again', async () => {
  const { mesh, link, advertise } = fixture();
  advertise();
  const asks = () => link.sent.filter(frame => frame.t === T.HUB_RPC && frame.method === 'session.list');
  const before = mesh.call('remote', 'session.list', {}, { sub: 'phone' });
  void mesh.call('remote', M.PING, {}, { sub: 'phone' }).catch(() => {});
  const joined = mesh.call('remote', 'session.list', {}, { sub: 'phone' });
  assert.equal(asks().length, 1, 'a ping changes nothing');
  void mesh.call('remote', 'session.rename', { id: 'a', title: 'new' }, { sub: 'phone' }).catch(() => {});
  const after = mesh.call('remote', 'session.list', {}, { sub: 'phone' });
  assert.equal(asks().length, 2);
  mesh.receive(link, { t: T.RPC_RESULT, id: asks()[0].id, ok: true, result: 'old' });
  mesh.receive(link, { t: T.RPC_RESULT, id: asks()[1].id, ok: true, result: 'new' });
  assert.deepEqual(await Promise.all([before, joined, after]), ['old', 'old', 'new']);
  mesh.stop();
});

test('mesh forwards direct negotiation only along its chosen route and releases browser state', () => {
  const { mesh, link, advertise } = fixture();
  const signals = [];
  mesh.signalEvent = frame => signals.push(frame);
  advertise();
  mesh.signal('remote', 'browser', { type: 'offer' }, 'phone');
  assert.deepEqual(link.sent.at(-1), {
    t: T.HUB_SIGNAL, env: 'remote', peer: 'browser', payload: { type: 'offer' }, device: 'phone',
  });
  const other = { connected: true, send() {} };
  mesh.up(other);
  const answer = { t: T.HUB_SIGNAL, kind: T.SIGNAL, env: 'remote', peer: 'browser', payload: { type: 'answer' } };
  mesh.receive(other, answer);
  assert.equal(signals.length, 0);
  mesh.receive(link, answer);
  assert.equal(signals.length, 1);
  mesh.forgetPeer('browser');
  assert.equal(mesh.signals.size, 0);
  assert.deepEqual(link.sent.at(-1), { t: T.HUB_SIGNAL_CLOSE, peer: 'browser' });
  mesh.receive(link, answer);
  assert.equal(signals.length, 1);
  mesh.stop();
});


test('network checks keep the chosen hub and its measurements while probes run', () => {
  const { mesh, link, advertise } = fixture();
  const other = { connected: true, sent: [], send(t, p) { this.sent.push({ t, ...p }); } };
  mesh.up(other); advertise(); advertise(other);
  mesh.routes.set('remote', { link: other, since: 0 });
  mesh.timing.get(other).set('remote', { ms: 10, probing: null });
  mesh.timing.get(link).set('remote', { ms: 100, probing: null });
  mesh.networkChanged();
  assert.equal(mesh.route('remote'), other);
  assert.equal(mesh.timing.get(other).get('remote').ms, 10);
  assert.equal(mesh.timing.get(link).get('remote').ms, 100);
  mesh.stop();
});
