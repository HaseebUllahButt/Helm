import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'helm-browser-queue-'));
process.env.HELM_DIR = root;
const { BrowserManager } = await import('../packages/connect/src/browser.js');
test.after(() => rmSync(root, { recursive: true, force: true }));
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const manager = new BrowserManager({ directory: root, session: id => ({ id }), canWindow: false, actionTimeoutMs: 100 });
  manager.recover = async () => {};
  const tab = { id: 'tab', sessionId: 'chat', engine: 'chromium' };
  manager.tabs.set(tab.id, tab);
  return { manager, tab };
}

test('a timed out browser operation holds its place until it stops running', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = fixture(), started = deferred(), finished = deferred();
  const calls = [];
  manager.perform = async () => {
    calls.push('start');
    if (calls.length === 1) { started.resolve(); await finished.promise; }
    calls.push('end'); return {};
  };
  const first = manager.run('chat', 'tab', { kind: 'look' });
  const rejected = assert.rejects(first, /timed out/);
  await started.promise;
  t.mock.timers.tick(100); await rejected;
  const second = manager.run('chat', 'tab', { kind: 'look' });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['start']);
  finished.resolve(); await second;
  assert.deepEqual(calls, ['start', 'end', 'start', 'end']);
  assert.equal(manager.serial.size, 0);
});

test('an action that expires while its page loads never reaches the page', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager, tab } = fixture(), ready = deferred();
  tab.ready = ready.promise;
  let performed = false;
  manager.perform = async () => { performed = true; };
  const action = manager.run('chat', 'tab', { kind: 'look' });
  const rejected = assert.rejects(action, /timed out/);
  await new Promise(setImmediate);
  t.mock.timers.tick(100); await rejected;
  ready.resolve(); await new Promise(setImmediate);
  assert.equal(performed, false);
  assert.equal(manager.serial.size, 0);
});


test('a browser operation that never settles cannot block recovery forever', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { manager } = fixture(), started = deferred();
  manager.perform = () => { started.resolve(); return new Promise(() => {}); };
  const first = manager.run('chat', 'tab', { kind: 'look' });
  const rejected = assert.rejects(first, /timed out/);
  await started.promise;
  t.mock.timers.tick(100); await rejected;
  assert.equal(manager.serial.size, 1);
  t.mock.timers.tick(100); await new Promise(setImmediate);
  assert.equal(manager.serial.size, 0);
  manager.perform = async () => ({ recovered: true });
  assert.deepEqual(await manager.run('chat', 'tab', { kind: 'look' }), { recovered: true });
});
