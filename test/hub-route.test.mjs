import test from 'node:test';
import assert from 'node:assert/strict';
import { HubMesh } from '../packages/connect/src/hub-mesh.js';
import { T } from '@helm/protocol';

/**
 * Which hub a request to another machine goes through. The laptop's link to
 * the VM crosses a VPN worth ~600ms; the same laptop's hub on the home wifi
 * is ~3ms away. These pin down that the mesh prefers the machine's own hub,
 * moves to a clearly faster route on measurement, does not flap, and never
 * sends a request twice when it moves.
 */
function fixture() {
  const network = {
    self: 'local',
    machines: { local: {}, remote: { endpoints: ['http://192.168.1.9:8787'] }, other: {} },
    revoked: {},
  };
  let clock = 0;
  const mesh = new HubMesh(() => network, () => {}, () => {}, () => {}, { now: () => clock, probeEvery: 0 });
  const link = (url) => ({ url, connected: true, sent: [], send(type, payload) { this.sent.push({ t: type, ...payload }); } });
  const attach = (l, ids = ['remote']) => {
    mesh.up(l);
    mesh.receive(l, { t: T.HUB_STATE, machines: ids.map(id => ({ id })) });
  };
  // Answer every ping still waiting on this link. The time it took is
  // whatever the clock was moved by since it went out.
  const answer = async (l, env = 'remote') => {
    for (const frame of l.sent.filter(f => f.t === T.HUB_RPC && f.method === 'ping' && f.env === env)) {
      if (mesh.pending.has(frame.id)) mesh.receive(l, { t: T.RPC_RESULT, id: frame.id, ok: true, result: { t: 0 } });
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  const tick = (ms) => { clock += ms; };
  return { mesh, network, link, attach, answer, tick, now: () => clock };
}

test('the machine\'s own hub is the first choice before anything is measured', async () => {
  const { mesh, link, attach } = fixture();
  const vm = link('https://vm.example');
  const own = link('http://192.168.1.9:8787');
  attach(vm);
  attach(own);
  assert.equal(mesh.route('remote'), own);
  mesh.call('remote', 'session.list', {}).catch(() => {});
  assert.equal(own.sent.at(-1).method, 'session.list');
  mesh.stop();
});

test('a single route is not timed: there is nothing to choose between', async () => {
  const { mesh, link, attach } = fixture();
  const vm = link('https://vm.example');
  attach(vm);
  assert.equal(vm.sent.filter(f => f.method === 'ping').length, 0);
  mesh.stop();
});

test('a second route is timed at once, and a clearly faster one wins', async () => {
  const { mesh, link, attach, answer, tick } = fixture();
  const own = link('http://192.168.1.9:8787');
  const vm = link('https://vm.example');
  attach(own);
  attach(vm);
  // Both routes were pinged the moment the second one appeared.
  assert.equal(own.sent.filter(f => f.method === 'ping').length, 1);
  assert.equal(vm.sent.filter(f => f.method === 'ping').length, 1);
  assert.equal(mesh.route('remote'), own);
  // Here the machine's own hub is the slow one (a stale LAN path through a VPN).
  tick(40);
  await answer(vm);
  tick(560);
  await answer(own);
  assert.equal(mesh.route('remote'), vm);
  assert.deepEqual(mesh.table().find(r => r.env === 'remote'), {
    env: 'remote', url: 'https://vm.example', own: false, ms: 40, hubMs: null,
    others: [{ url: 'http://192.168.1.9:8787', own: true, ms: 600, hubMs: null }],
  });
  mesh.stop();
});

test('a route that has gone quiet counts as slow while its probe is out', async () => {
  const { mesh, link, attach, answer, tick } = fixture();
  const vm = link('https://vm.example');
  const own = link('http://192.168.1.9:8787');
  attach(vm);
  attach(own);
  tick(3);
  await answer(own);
  // The VM has not answered after 2 seconds: own is clearly better already.
  tick(2000);
  assert.equal(mesh.route('remote'), own);
  mesh.stop();
});

test('switching needs a clear win and waits 30 seconds between moves', async () => {
  const { mesh, link, attach, answer, tick } = fixture();
  const own = link('http://192.168.1.9:8787');
  const vm = link('https://vm.example');
  attach(own);
  attach(vm);
  tick(300);
  await answer(own);
  await answer(vm);
  assert.equal(mesh.route('remote'), own, 'equal times keep the current route');

  // VM now answers in 50ms, own still 300ms: a clear win, taken at once
  // because the first choice was only a guess.
  const sample = async (l, ms) => { mesh.probe(l, 'remote'); tick(ms); await answer(l); };
  for (let i = 0; i < 10; i++) await sample(vm, 50);
  assert.equal(mesh.route('remote'), vm);

  // Own becomes much faster soon after - but a route is held for 30 seconds.
  for (let i = 0; i < 20; i++) await sample(own, 1);
  assert.equal(mesh.route('remote'), vm, 'held');
  tick(30_000);
  assert.equal(mesh.route('remote'), own, 'moved after the hold');

  // A small gain is not worth a move, however long it lasts.
  tick(60_000);
  for (let i = 0; i < 20; i++) await sample(vm, 1);
  for (let i = 0; i < 20; i++) await sample(own, 15);
  assert.equal(mesh.route('remote'), own, 'under 20ms quicker: stay');
  mesh.stop();
});

test('a request already sent stays where it went; only new ones take the new route', async () => {
  const { mesh, link, attach, answer, tick } = fixture();
  const own = link('http://192.168.1.9:8787');
  const vm = link('https://vm.example');
  attach(own);
  attach(vm);
  const first = mesh.call('remote', 'session.input', { data: 'once' });
  const sent = own.sent.at(-1);
  assert.equal(sent.method, 'session.input');
  tick(5);
  await answer(vm);
  tick(900);
  await answer(own);
  assert.equal(mesh.route('remote'), vm);
  // Nothing was resent on the faster route; the answer still comes from own.
  assert.equal(vm.sent.filter(f => f.method === 'session.input').length, 0);
  assert.equal(mesh.receive(vm, { t: T.RPC_RESULT, id: sent.id, ok: true, result: 'forged' }), false);
  mesh.receive(own, { t: T.RPC_RESULT, id: sent.id, ok: true, result: 'done' });
  assert.equal(await first, 'done');
  mesh.call('remote', 'session.list', {}).catch(() => {});
  assert.equal(vm.sent.at(-1).method, 'session.list');
  mesh.stop();
});

test('losing the chosen route falls back at once, without the hold', async () => {
  const { mesh, link, attach, answer, tick } = fixture();
  const own = link('http://192.168.1.9:8787');
  const vm = link('https://vm.example');
  attach(own);
  attach(vm);
  tick(3);
  await answer(own);
  tick(600);
  await answer(vm);
  assert.equal(mesh.route('remote'), own);
  own.connected = false;
  mesh.down(own);
  assert.equal(mesh.route('remote'), vm);
  mesh.stop();
});

test('a machine announced on the local network counts its hub as its own', async () => {
  const { mesh, link, attach } = fixture();
  const vm = link('https://vm.example');
  const hinted = Object.assign(link('http://192.168.7.7:8787'), { hintFor: 'other' });
  attach(vm, ['other']);
  attach(hinted, ['other']);
  assert.equal(mesh.ownHub(hinted, 'other'), true);
  assert.equal(mesh.route('other'), hinted);
  mesh.stop();
});

test('a lost link gives its unanswered probes no time', async () => {
  const network = { self: 'local', machines: { local: {}, remote: {} }, revoked: {} };
  const mesh = new HubMesh(() => network, () => {}, () => {}, () => {}, { probeEvery: 0 });
  const a = { url: 'a', connected: true, send() {} };
  const b = { url: 'b', connected: true, send() {} };
  mesh.up(a);
  mesh.up(b);
  mesh.receive(a, { t: T.HUB_STATE, machines: [{ id: 'remote' }] });
  mesh.receive(b, { t: T.HUB_STATE, machines: [{ id: 'remote' }] });
  // Unanswered pings are pending requests; a lost link rejects them, and
  // that is not a measurement of anything.
  assert.equal(mesh.pending.size, 2);
  mesh.down(a);
  assert.equal(mesh.pending.size, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mesh.estimate(b, 'remote').known, false);
  mesh.stop();
});

test('the first timing back does not beat the machine\'s own hub that has not answered yet', async () => {
  const { mesh, link, attach, answer, tick } = fixture();
  const vm = link('https://vm.example');
  const own = link('http://192.168.1.9:8787');
  attach(vm);
  attach(own);
  tick(1);
  await answer(vm);
  assert.equal(mesh.route('remote'), own);
  mesh.stop();
});
