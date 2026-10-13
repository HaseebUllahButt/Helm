import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-lan-'));
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
process.env.HELM_DB = join(process.env.HELM_DIR, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

const { LanDiscovery, announceTag, lanDiscoveryEnabled, withHeardAddresses } = await import('../packages/connect/src/lan-discovery.js');
const { broadcastAddresses } = await import('../packages/connect/src/net-addr.js');

/**
 * Machines on one network find each other by a datagram, not the roster.
 * Everything here talks over loopback on ports picked for the test, so
 * nothing is ever said on the real network.
 */
const key = 'k'.repeat(43);
const roster = (self) => ({
  id: 'net1', key, self,
  machines: { laptop: { endpoints: ['http://192.168.10.35:8787'] }, homepc: { endpoints: [] }, gone: { endpoints: [] } },
  revoked: { gone: 1 },
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

function node(self, port, discoveryPort, peerPort, extra = {}) {
  const changes = [];
  const lan = new LanDiscovery({
    network: () => roster(self), port, discoveryPort, bindAddress: '127.0.0.1',
    targets: () => [{ address: '127.0.0.1', port: peerPort }],
    accept: () => true, enabled: () => true, routable: async () => ({ ok: true }),
    onChange: () => changes.push(lan.list()), every: 60_000, ...extra,
  });
  return { lan, changes };
}

test('two machines hear each other, and the newcomer is answered at once', async () => {
  const [pa, pb] = [await freePort(), await freePort()];
  const a = node('laptop', 18787, pa, pb);
  const b = node('homepc', 28787, pb, pa);
  await a.lan.start();
  // A's first announcement goes nowhere: B is not listening yet. B starting
  // later must still learn about A without waiting a full round - A answers
  // B's announcement directly.
  await b.lan.start();
  await until(() => a.lan.list().length && b.lan.list().length);
  assert.deepEqual(a.lan.list().map(({ url, id }) => ({ url, id })), [{ url: 'http://127.0.0.1:28787', id: 'homepc' }]);
  assert.deepEqual(b.lan.list().map(({ url, id }) => ({ url, id })), [{ url: 'http://127.0.0.1:18787', id: 'laptop' }]);
  assert.equal(a.lan.status().on, true);
  a.lan.stop();
  b.lan.stop();
});

test('announcements that are forged, from a stranger network, or from a removed machine are ignored', async () => {
  const [pa, pb] = [await freePort(), await freePort()];
  const a = node('laptop', 18787, pa, pb);
  await a.lan.start();
  const s = dgram.createSocket('udp4');
  const period = Math.floor(Date.now() / 600_000);
  const send = (msg) => new Promise(resolve => s.send(Buffer.from(JSON.stringify(msg)), pa, '127.0.0.1', resolve));
  await send({ helm: 'lan', v: 1, tag: 'not-a-real-tag', port: 1 });
  await send({ helm: 'lan', v: 1, tag: announceTag({ ...roster('homepc'), key: 'x'.repeat(43) }, 'homepc', period), port: 2 });
  await send({ helm: 'lan', v: 1, tag: announceTag(roster('gone'), 'gone', period), port: 3 });
  await send({ helm: 'lan', v: 1, tag: announceTag(roster('laptop'), 'laptop', period), port: 4 });
  await send({ helm: 'lan', v: 1, tag: announceTag(roster('homepc'), 'homepc', period), port: 70000 });
  // A real one last, so the ones before it have certainly been read - and
  // from the previous ten minutes, as a machine with a slow clock sends.
  await send({ helm: 'lan', v: 1, tag: announceTag(roster('homepc'), 'homepc', period - 1), port: 5 });
  await until(() => a.lan.list().length);
  assert.deepEqual(a.lan.list().map(h => h.url), ['http://127.0.0.1:5']);
  s.close();
  a.lan.stop();
});

test('only private addresses count by default: loopback and the internet are not the local network', async () => {
  const [pa] = [await freePort()];
  const a = node('laptop', 18787, pa, pa, { accept: undefined });
  await a.lan.start();
  const s = dgram.createSocket('udp4');
  const tag = announceTag(roster('homepc'), 'homepc', Math.floor(Date.now() / 600_000));
  await new Promise(resolve => s.send(Buffer.from(JSON.stringify({ helm: 'lan', v: 1, tag, port: 5 })), pa, '127.0.0.1', resolve));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(a.lan.list().length, 0);
  s.close();
  a.lan.stop();
});

test('the tag changes every ten minutes and between networks, and does not name the machine', () => {
  const net = roster('homepc');
  assert.notEqual(announceTag(net, 'homepc', 1), announceTag(net, 'homepc', 2));
  assert.notEqual(announceTag(net, 'homepc', 1), announceTag({ ...net, key: 'z'.repeat(43) }, 'homepc', 1));
  assert.notEqual(announceTag(net, 'homepc', 1), announceTag(net, 'laptop', 1));
  assert.ok(!announceTag(net, 'homepc', 1).includes('homepc'));
});

test('heard addresses expire, and turning it off or a VPN carrying the LAN stops it', async () => {
  const [pa, pb] = [await freePort(), await freePort()];
  let clock = Date.now();
  let on = true;
  let routed = true;
  const a = node('laptop', 18787, pa, pb, { now: () => clock, enabled: () => on, routable: async () => ({ ok: routed }) });
  const b = node('homepc', 28787, pb, pa);
  await a.lan.start();
  await b.lan.start();
  await until(() => a.lan.list().length);
  b.lan.stop();
  clock += 101_000;
  await a.lan.tick();
  assert.equal(a.lan.list().length, 0, 'expired');

  on = false;
  await a.lan.tick();
  assert.deepEqual(a.lan.status(), { on: false, reason: 'turned off', heard: [] });

  on = true;
  routed = false;
  clock += 5 * 60_000;
  await a.lan.tick();
  assert.equal(a.lan.status().on, false);
  assert.match(a.lan.status().reason, /VPN/);
  a.lan.stop();
});

test('on unless config says no; test runs stay quiet unless asked', () => {
  assert.equal(lanDiscoveryEnabled({}, {}), true);
  assert.equal(lanDiscoveryEnabled({ lanDiscovery: false }, {}), false);
  assert.equal(lanDiscoveryEnabled({}, { HELM_NO_SERVICE: '1' }), false);
  assert.equal(lanDiscoveryEnabled({}, { HELM_NO_SERVICE: '1', HELM_LAN_DISCOVERY: '1' }), true);
  assert.equal(lanDiscoveryEnabled({ lanDiscovery: false }, { HELM_LAN_DISCOVERY: '1' }), false);
});

test('broadcast goes to each private subnet, never a VPN /32', () => {
  assert.deepEqual(broadcastAddresses([
    { address: '192.168.1.9', netmask: '255.255.255.0' },
    { address: '100.80.16.79', netmask: '255.255.255.255' },
    { address: '10.0.3.4', netmask: '255.255.0.0' },
    { address: '130.210.33.163', netmask: '255.255.255.0' },
  ]), ['192.168.1.255', '10.0.255.255']);
});

test('a heard address is dialled only while the roster\'s way into that machine is not working', () => {
  const net = {
    self: 'vm',
    machines: { vm: {}, laptop: { endpoints: ['http://192.168.10.35:8787'] }, homepc: { endpoints: ['http://192.168.1.20:8787'] }, gone: { endpoints: [] } },
    revoked: { gone: 1 },
  };
  const base = ['http://127.0.0.1:8787', 'http://192.168.10.35:8787', 'http://192.168.1.20:8787'];
  const heard = [
    { url: 'http://192.168.1.9:8787', id: 'laptop' },
    { url: 'http://192.168.1.20:8787', id: 'homepc' },
    { url: 'http://192.168.1.50:8787', id: 'gone' },
    { url: 'http://192.168.1.60:8787', id: 'stranger' },
    { url: 'http://192.168.1.70:8787', id: 'vm' },
  ];
  // Nothing up yet: try the roster's address and the heard one.
  let plan = withHeardAddresses({ urls: base, net, self: 'vm', heard, connected: () => false });
  assert.deepEqual(plan.urls, [...base, 'http://192.168.1.9:8787']);
  assert.deepEqual([...plan.owners], [['http://192.168.1.9:8787', 'laptop']]);

  // The roster's address works: the heard one is not needed.
  plan = withHeardAddresses({ urls: base, net, self: 'vm', heard, connected: url => url === 'http://192.168.10.35:8787' });
  assert.deepEqual(plan.urls, base);

  // The heard one works: the roster's stale address stops being dialled.
  plan = withHeardAddresses({ urls: base, net, self: 'vm', heard, connected: url => url === 'http://192.168.1.9:8787' });
  assert.deepEqual(plan.urls, ['http://127.0.0.1:8787', 'http://192.168.1.20:8787', 'http://192.168.1.9:8787']);

  // Two heard addresses for one machine: once one is up, not the other.
  plan = withHeardAddresses({
    urls: base, net, self: 'vm', connected: url => url === 'http://192.168.1.9:8787',
    heard: [{ url: 'http://192.168.1.9:8787', id: 'laptop' }, { url: 'http://10.0.0.9:8787', id: 'laptop' }],
  });
  assert.ok(!plan.urls.includes('http://10.0.0.9:8787'));
});
