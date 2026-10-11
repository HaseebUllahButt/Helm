import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const moduleUrl = new URL('../packages/protocol/network.js', import.meta.url).href;

// Simulate a production home inside a temporary directory. Never point any
// regression test at the owner's home, even when testing a rejected write.
function fixture(t, body, { testContext = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'helm-production-registration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.HELM_DIR;
  delete env.NODE_TEST_CONTEXT;
  if (testContext) env.NODE_TEST_CONTEXT = 'child-v8';
  const setup = `
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs';
    import { join } from 'node:path';
    const root = ${JSON.stringify(root)};
    os.homedir = () => root;
    syncBuiltinESMExports();
    const home = join(root, '.helm');
    fs.mkdirSync(home, { mode: 0o700 });
    const file = join(home, 'network.json');
    const original = { id: 'aabb', key: 'fixture-network-key', self: 'ccdd', port: 8787,
      machines: { ccdd: { id: 'ccdd', name: 'why', endpoints: [], updatedAt: Date.now(), addedAt: Date.now() } },
      devices: {}, revoked: {} };
    const seed = () => fs.writeFileSync(file, JSON.stringify(original), { mode: 0o600 });
    const load = () => import(${JSON.stringify(moduleUrl)});
    ${body}
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', setup], { env, timeout: 15_000, stdio: 'pipe' });
}

test('a test import before HELM_DIR is set cannot overwrite the production registration', t => {
  fixture(t, `
    seed();
    const before = fs.readFileSync(file);
    const N = await load();
    process.env.HELM_DIR = join(root, 'test-scratch');
    assert.throws(() => N.createNetwork({ name: 'test' }), /Tests cannot write the production/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(process.env.HELM_DIR), false);
  `, { testContext: true });
});

test('tests cannot save, leave, join, or create browser credentials in production', t => {
  fixture(t, `
    seed();
    const before = fs.readFileSync(file);
    const N = await load();
    for (const action of [
      () => N.saveNetwork(original),
      () => N.forgetNetwork(),
      () => N.joinNetwork({ id: 'eeff', key: 'other-key', name: 'test' }),
      () => N.localKey(),
    ]) assert.throws(action, /Tests cannot write the production/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(home), ['network.json']);
  `, { testContext: true });
});

test('a symlink to the production directory is also protected from tests', t => {
  fixture(t, `
    seed();
    const before = fs.readFileSync(file);
    const alias = join(root, 'looks-like-scratch');
    fs.symlinkSync(home, alias, 'dir');
    process.env.HELM_DIR = alias;
    const N = await load();
    assert.throws(() => N.createNetwork({ name: 'test' }), /Tests cannot write the production/);
    assert.deepEqual(fs.readFileSync(file), before);
  `, { testContext: true });
});

test('changing HELM_DIR after an import cannot redirect a production writer', t => {
  fixture(t, `
    seed();
    const before = fs.readFileSync(file);
    const N = await load();
    process.env.HELM_DIR = join(root, 'scratch');
    assert.throws(() => N.saveNetwork(original), /HELM_DIR changed after Helm was imported/);
    assert.deepEqual(fs.readFileSync(file), before);
  `);
});

test('production roster updates preserve identity, permissions, and existing registration', t => {
  fixture(t, `
    seed();
    const N = await load();
    const before = fs.readFileSync(file);
    assert.throws(() => N.createNetwork({ name: 'test' }), /refusing to replace/);
    assert.throws(() => N.joinNetwork({ id: 'eeff', key: 'other-key' }), /refusing to replace/);
    for (const field of ['id', 'self', 'key']) {
      assert.throws(() => N.saveNetwork({ ...original, [field]: 'different' }), /refusing to replace/);
    }
    assert.deepEqual(fs.readFileSync(file), before);
    fs.chmodSync(home, 0o755);
    fs.chmodSync(file, 0o644);
    const changed = structuredClone(original);
    changed.machines.ccdd.name = 'renamed';
    N.saveNetwork(changed);
    assert.equal(N.loadNetwork().machines.ccdd.name, 'renamed');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(home), ['network.json']);
  `);
});

test('fresh setup, provisional joining, and explicitly forgetting still work', t => {
  fixture(t, `
    const N = await load();
    assert.equal(N.loadNetwork(), null);
    const first = N.createNetwork({ name: 'new machine' });
    first.provisional = true;
    N.saveNetwork(first);
    const joined = N.joinNetwork({ id: 'eeff', key: 'fixture-joined-key', name: 'why' });
    assert.equal(N.loadNetwork().id, 'eeff');
    assert.equal(N.loadNetwork().self, joined.self);
    N.forgetNetwork();
    assert.equal(N.loadNetwork(), null);
    assert.ok(N.createNetwork({ name: 'new machine' }).id);
  `);
});

test('an unreadable production registration is preserved instead of creating a new network', t => {
  fixture(t, `
    const N = await load();
    for (const content of ['{', 'null', '{}']) {
      fs.writeFileSync(file, content, { mode: 0o600 });
      assert.throws(() => N.loadNetwork(), /existing Helm registration cannot be read/);
      assert.throws(() => N.createNetwork({ name: 'test' }), /will not be replaced/);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    }
  `);
});

test('properly isolated tests can create and replace their own scratch networks', t => {
  fixture(t, `
    seed();
    const before = fs.readFileSync(file);
    process.env.HELM_DIR = join(root, 'scratch');
    const N = await load();
    const first = N.createNetwork({ name: 'first test' });
    const second = N.createNetwork({ name: 'second test' });
    assert.notEqual(first.id, second.id);
    assert.equal(N.loadNetwork().id, second.id);
    assert.deepEqual(fs.readFileSync(file), before);
    N.forgetNetwork();
    assert.equal(N.loadNetwork(), null);
  `, { testContext: true });
});

test('concurrent readers never see a truncated registration during roster writes', t => {
  fixture(t, `
    seed();
    const N = await load();
    const { Worker } = await import('node:worker_threads');
    const signal = new SharedArrayBuffer(4);
    const worker = new Worker(\`
      import { workerData, parentPort } from 'node:worker_threads';
      import { readFileSync } from 'node:fs';
      const stop = new Int32Array(workerData.signal);
      let reads = 0, failures = 0;
      parentPort.postMessage('ready');
      while (!Atomics.load(stop, 0)) {
        try { const n = JSON.parse(readFileSync(workerData.file, 'utf8')); if (n.id !== 'aabb' || n.self !== 'ccdd') failures++; }
        catch { failures++; }
        reads++;
      }
      parentPort.postMessage({ reads, failures });
    \`, { eval: true, workerData: { signal, file } });
    await new Promise(resolve => worker.once('message', resolve));
    const result = new Promise(resolve => worker.once('message', resolve));
    for (let i = 0; i < 80; i++) N.saveNetwork({ ...original, note: 'x'.repeat(128_000), iteration: i });
    Atomics.store(new Int32Array(signal), 0, 1);
    const observed = await result;
    assert.ok(observed.reads > 1);
    assert.equal(observed.failures, 0);
    await worker.terminate();
  `);
});
