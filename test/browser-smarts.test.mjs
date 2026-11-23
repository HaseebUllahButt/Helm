import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'helm-browser-smarts-'));
process.env.HELM_DIR = directory; process.env.HELM_NO_SERVICE = '1';
// No real windows on the screen of the machine running the tests.
delete process.env.WAYLAND_DISPLAY; delete process.env.DISPLAY;
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(directory, file);
test.after(() => rm(directory, { recursive: true, force: true }));
const { readOnlyAction } = await import('../packages/connect/src/browser-targets.js');
const { BrowserFlows, fillParams } = await import('../packages/connect/src/browser-flows.js');
const { BrowserManager } = await import('../packages/connect/src/browser.js');
test('read-only classification checks every step and keeps all mutation kinds blocked', () => {
  for (const step of [{ goto: 'example.com' }, { back: true }, { check: 'Done' }, { wait_for: 'Done' }, { kind: 'look' }, { kind: 'screenshot' }]) assert.ok(readOnlyAction({ actions: [step] }));
  for (const step of [{ click: 'Send' }, { type: 'Ada', into: 'Name' }, { hover: 'Name' }, { select: 'Country', option: 'Canada' }, { key: 'Enter' }, { scroll: 'down' }, { kind: 'evaluate', script: '1' }, { evaluate: '1' }, { reload: true }, { dialog: 'accept' }, { kind: 'reload' }, { kind: 'dialog' }]) assert.equal(readOnlyAction({ actions: [{ check: 'Done' }, step] }), false);
  assert.equal(readOnlyAction({ kind: 'wait', selector: 'input' }), false, 'existing kind permissions stay unchanged');
});
test('flows fill nested values, require every parameter, and save only successful templates privately', async () => {
  const flows = new BrowserFlows(directory), actions = [{ type: '{{name}}', into: 'Name' }, { click: { selector: '[title="{{name}}"]' } }];
  assert.equal(fillParams(actions, { name: 'Ada' })[0].type, 'Ada');
  assert.equal(fillParams(actions, { name: '$&{{other}}' })[0].type, '$&{{other}}');
  assert.throws(() => fillParams(actions), /missing/);
  assert.throws(() => fillParams('{{toString}}'), /missing/);
  assert.equal(await flows.save('login', actions, 'Sign in', { failedAt: 1 }), false);
  assert.deepEqual((await flows.list()).flows, []);
  await flows.save('login', actions, 'Sign in', { results: [{}, {}] });
  assert.deepEqual(await flows.load('login'), { actions, note: 'Sign in', params: ['name'] });
  assert.equal((await stat(join(directory, 'flows/login.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await flows.list()).flows, [{ name: 'login', note: 'Sign in', params: ['name'] }]);
  await assert.rejects(flows.save('../bad', actions, '', {}), /flow names/);
  assert.deepEqual(await readdir(join(directory, 'flows')), ['login.json']);
});
test('read-only gates alias batches and flow replays before any step', async () => {
  const manager = new BrowserManager({ directory: join(directory, 'gates'), session: id => ({ id, mode: 'readonly' }) });
  const tab = { id: 'tab', sessionId: 'one', engine: 'chromium', downloads: [] };
  manager.tabs.set(tab.id, tab); let calls = 0; manager.perform = async () => { calls++; return {}; };
  await assert.rejects(manager.run('one', tab.id, { actions: [{ goto: 'example.com' }, { click: 'Send' }] }), /read-only/);
  await manager.run('one', tab.id, { actions: [{ check: 'Done' }, { wait_for: 'Done' }] }); assert.equal(calls, 1);
  await manager.flows.save('send', [{ click: 'Send' }], '', {});
  await assert.rejects(manager.runFlow('one', tab.id, 'send'), /read-only/);
  assert.equal(calls, 1); await manager.stop();
});
test('batch failure stops delivery and cannot save a failed flow', async () => {
  const manager = new BrowserManager({ directory: join(directory, 'batch'), session: id => ({ id }) });
  const tab = { id: 'tab', sessionId: 'one', engine: 'chromium', downloads: [] };
  manager.tabs.set(tab.id, tab); manager.look = async () => ({ text: 'Page' }); let calls = 0;
  // Run the batch itself; stand in for each step.
  const batch = manager.perform.bind(manager);
  manager.perform = async (tab, action, inBatch) => { if (action.kind === 'batch') return batch(tab, action, inBatch); if (++calls === 2) throw new Error('failed'); return {}; };
  const result = await manager.run('one', tab.id, { actions: [{ click: '{{target}}' }, { click: 'Missing' }, { click: 'Never' }], with: { target: 'Send' }, save_as: 'failed' });
  assert.equal(result.failedAt, 1); assert.equal(calls, 2); assert.deepEqual((await manager.listFlows('one')).flows, []);
  await assert.rejects(manager.run('one', tab.id, { actions: [{ actions: [] }] }), /nonnested/);
  await manager.stop();
});
