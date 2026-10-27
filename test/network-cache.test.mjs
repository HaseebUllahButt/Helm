import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fs.mkdtempSync(join(tmpdir(), 'helm-network-cache-'));
process.env.HELM_DIR = root;
const N = await import('../packages/protocol/network.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('unchanged network reads reuse parsed data without sharing mutable objects', t => {
  N.createNetwork({ name: 'test' });
  let reads = 0, paths = 0;
  const read = fs.readFileSync, realpath = fs.realpathSync;
  t.mock.method(fs, 'readFileSync', (...args) => { if (args[0] === N.NETWORK_FILE) reads++; return read(...args); });
  t.mock.method(fs, 'realpathSync', (...args) => { paths++; return realpath(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const first = N.loadNetwork(), initialPaths = paths;
  first.machines[first.self].name = 'unsaved';
  for (let i = 0; i < 20; i++) assert.equal(N.loadNetwork().machines[first.self].name, 'test');
  assert.equal(reads, 1);
  assert.equal(paths, initialPaths);
});

test('network reads immediately see external writes, replacements, corruption and removal', () => {
  const net = N.createNetwork({ name: 'before' });
  assert.equal(N.loadNetwork().machines[net.self].name, 'before');
  const info = fs.statSync(N.NETWORK_FILE);
  net.machines[net.self].name = 'after!';
  fs.writeFileSync(N.NETWORK_FILE, JSON.stringify(net, null, 2));
  fs.utimesSync(N.NETWORK_FILE, info.atime, info.mtime);
  assert.equal(N.loadNetwork().machines[net.self].name, 'after!');
  net.revoked.remote = Date.now();
  const next = join(root, 'next.json');
  fs.writeFileSync(next, JSON.stringify(net)); fs.renameSync(next, N.NETWORK_FILE);
  assert.ok(N.loadNetwork().revoked.remote);
  fs.writeFileSync(N.NETWORK_FILE, '{'); assert.equal(N.loadNetwork(), null);
  N.saveNetwork(net); assert.equal(N.loadNetwork().self, net.self);
  fs.unlinkSync(N.NETWORK_FILE); assert.equal(N.loadNetwork(), null);
});
