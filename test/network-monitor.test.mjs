import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const dir = mkdtempSync(join(tmpdir(), 'helm-net-monitor-'));
Object.assign(process.env, { HELM_DIR: dir, HELM_DB: join(dir, 'hub.sqlite'), HELM_SSH_DIR: join(dir, 'ssh'),
  HELM_PROCS_SOCKET: join(dir, 'procs.sock'), HELM_TERMINALS_SOCKET: join(dir, 'terminals.sock'),
  HELM_NATIVE_SOCKET: join(dir, 'native.sock'), HERDR_SOCKET_PATH: join(dir, 'herdr.sock'), HELM_NO_SERVICE: '1' });
const { NetworkMonitor, networkSignature } = await import('../packages/connect/src/network-monitor.js');
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('VPN routes, policy, DNS and interfaces change the signature; route-cache counters do not', () => {
  const route = { dst: 'default', gateway: '10.0.0.1', dev: 'wlan0', table: 'main', expires: 10, used: 1 };
  const original = networkSignature({ routes: [route] });
  assert.equal(networkSignature({ routes: [{ ...route, expires: 0, used: 500 }] }), original);
  assert.notEqual(networkSignature({ routes: [{ ...route, dev: 'tun0' }] }), original);
  assert.notEqual(networkSignature({ routes: [route], rules: [{ priority: 100, table: 52 }] }), original);
  assert.notEqual(networkSignature({ routes: [route], dns: 'nameserver 1.1.1.1' }), original);
  assert.notEqual(networkSignature({ routes: [route], interfaces: { tun0: [{ address: '10.9.0.1', family: 'IPv4' }] } }), original);
  assert.equal(networkSignature({ routes: [route, { dst: '10.0.0.0/24' }] }),
    networkSignature({ routes: [{ dst: '10.0.0.0/24' }, route] }));
});

test('VPN on/off and waking with unchanged addresses trigger recovery once each', async context => {
  let signature = 'wifi', now = 0;
  const changes = [];
  const monitor = new NetworkMonitor(reason => changes.push(reason), { sample: async () => signature, now: () => now, observe: () => null });
  context.after(() => monitor.stop());
  await monitor.check();
  await monitor.check();
  signature = 'vpn'; now = 5000;
  await monitor.check();
  signature = 'wifi'; now = 10_000;
  await monitor.check();
  now = 100_000;
  await monitor.check();
  await monitor.check();
  assert.deepEqual(changes, ['network changed', 'network changed', 'woke from sleep']);
});

test('kernel event bursts are coalesced and polling still works without an event watcher', async context => {
  const watcher = new EventEmitter(); watcher.stdout = new EventEmitter();
  let killed = 0; watcher.kill = () => killed++;
  let signature = 'wifi', changes = 0;
  const monitor = new NetworkMonitor(() => changes++, { sample: async () => signature, observe: () => watcher });
  context.after(() => monitor.stop());
  await monitor.start();
  signature = 'vpn';
  for (let i = 0; i < 20; i++) watcher.stdout.emit('data', 'changed');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(changes, 1);
  monitor.stop();
  assert.equal(killed, 1);
  const fallback = new NetworkMonitor(() => changes++, { sample: async () => signature, observe: () => { throw new Error('no ip'); }, every: 20 });
  context.after(() => fallback.stop());
  await fallback.start(); signature = 'wifi';
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(changes, 2);
});

test('stop discards delayed samples; concurrent checks observe the final network', async () => {
  let release;
  let signature = 'wifi', calls = 0, changes = 0;
  const monitor = new NetworkMonitor(() => changes++, { observe: () => null,
    sample: async () => { if (++calls === 2) return new Promise(resolve => { release = resolve; }); return signature; } });
  await monitor.check();
  const pending = monitor.check();
  signature = 'vpn';
  const next = monitor.check();
  release('wifi');
  await Promise.all([pending, next]);
  assert.equal(changes, 1);
  monitor.stop();
  await monitor.check();
  assert.equal(calls, 3);
  const stopped = new NetworkMonitor(() => changes++, { sample: () => new Promise(resolve => { release = resolve; }), observe: () => null });
  const delayed = stopped.start(); stopped.stop(); release('new'); await delayed;
  assert.equal(changes, 1);
});
