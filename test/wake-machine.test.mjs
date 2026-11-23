import test from 'node:test';
import assert from 'node:assert/strict';
import { localWakeAdapters, magicPacket, routerAddresses, sendWake } from '../packages/connect/src/wake-machine.js';

const mac = 'aa:bb:cc:dd:ee:ff';
const router = '12:34:56:78:90:ab';
const target = 'aa11bb22cc33';
const local = 'bb11cc22dd33';
const link = { network: '192.168.1.0', prefix: 24, router, mac };
const routes = 'Iface Destination Gateway Flags RefCnt Use Metric Mask\n' + [
  'eth0 00000000 0101A8C0 0003 0 0 100 00000000',
  'eth0 00000000 FE01A8C0 0003 0 0 200 00000000',
  'wlan0 00000000 0101A8C0 0003 0 0 300 00000000',
].join('\n');
const arp = 'IP address HW type Flags HW address Mask Device\n' + [
  '192.168.1.1 0x1 0x2 ' + router + ' * eth0',
  '192.168.1.1 0x1 0x2 ' + router + ' * wlan0',
  '192.168.1.254 0x1 0x0 00:00:00:00:00:00 * eth0',
].join('\n');

test('finds IPv4 broadcast and wired MAC, while Wi-Fi can only send', () => {
  const ip = { family: 'IPv4', address: '192.168.1.2', cidr: '192.168.1.2/24', mac };
  const adapters = localWakeAdapters({ platform: 'linux', interfaces: {
    eth0: [ip], wlan0: [ip], docker0: [ip], eth2: [{ ...ip, cidr: '192.168.1.2/32' }],
  }, adapter: name => ({ physical: name !== 'docker0', wireless: name === 'wlan0' }),
  routers: routerAddresses(routes, arp) });
  assert.deepEqual(adapters, [
    { name: 'eth0', address: ip.address, broadcast: '192.168.1.255', link },
    { name: 'wlan0', address: ip.address, broadcast: '192.168.1.255', link: { ...link, mac: null } },
  ]);
});

test('creates the 102-byte magic packet and checks the sender network again', async () => {
  const packet = magicPacket(mac);
  assert.equal(packet.toString('hex'), 'ff'.repeat(6) + 'aabbccddeeff'.repeat(16));
  assert.throws(() => magicPacket('ff:ff:ff:ff:ff:ff'), /invalid/);
  const net = { self: local, machines: { [local]: {}, [target]: {} }, revoked: {} };
  const state = { records: () => ({ [target]: { receivers: [link], links: [] } }) };
  const device = { address: '192.168.1.2', broadcast: '192.168.1.255', link: { ...link, mac: null } };
  const calls = [];
  const deps = { net, state, adapters: () => [device], broadcast: async (...args) => calls.push(args) };
  await assert.rejects(sendWake(local, deps), /another machine/);
  await assert.rejects(sendWake(target, { ...deps, adapters: () => [{ ...device, link: { ...link, router: null } }] }), /no longer shares/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await sendWake(target, deps), { sent: true });
  assert.deepEqual(calls, [[mac, device]]);
});
