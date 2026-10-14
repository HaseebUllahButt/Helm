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
const { resolveTarget, scoreTargets, normalizeAction, readOnlyAction } = await import('../packages/connect/src/browser-targets.js');
const { BrowserFlows, fillParams } = await import('../packages/connect/src/browser-flows.js');
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { createBrowserRoutes } = await import('../packages/connect/src/browser-routes.js');
const { runBrowserCommand } = await import('../packages/connect/src/browser-cli.js');
const elements = [ { ref: 1, role: 'button', name: 'Send message' }, { ref: 2, role: 'button', name: 'Send' }, { ref: 3, role: 'link', name: 'Send' }, { ref: 4, role: 'textbox', name: 'Search messages' } ];

test('targets normalise articles, case and punctuation; exact beats all words, and kind hints choose', () => {
  assert.equal(resolveTarget('THE Send! button', elements).ref, 2);
  assert.equal(resolveTarget('the button: Send', elements).ref, 2);
  assert.equal(resolveTarget('the Send link', elements).ref, 3);
  assert.equal(resolveTarget('the Search messages box', elements).ref, 4);
  assert.equal(resolveTarget('Search messages', elements, 'type').ref, 4);
  assert.equal(scoreTargets('Send', elements)[0].ref, 2);
  assert.equal(resolveTarget('Search the recent messages', elements).ref, 4);
});
test('ambiguous and missing targets return ranked candidates instead of choosing', () => {
  assert.throws(() => resolveTarget('Send', elements), error => error.candidates.length === 4 && /ambiguous/.test(error.message));
  assert.throws(() => resolveTarget('Unknown button', elements), error => /no matching/.test(error.message) && error.candidates.every(e => e.role === 'button'));
  assert.equal(resolveTarget('Send button', [...elements, { ref: 5, role: 'button', name: 'Send', disabled: true }]).ref, 2);
  assert.equal(resolveTarget('Send button', [{ ref: 1, role: 'button', name: 'Send', inViewport: false }, { ref: 2, role: 'button', name: 'Send' }]).ref, 2);
});
test('Bowser steps map without changing existing kind actions', () => {
  const old = { kind: 'type', ref: 2, text: 'Ada' }; assert.equal(normalizeAction(old), old);
  assert.equal(normalizeAction({ goto: 'example.com' }).kind, 'navigate');
  assert.equal(normalizeAction({ click: 'Send' }).target, 'Send');
  assert.equal(normalizeAction({ click: '3' }).ref, 3);
  assert.equal(normalizeAction({ hover: 'Name' }).kind, 'hover');
  assert.deepEqual(normalizeAction({ type: 'Ada', into: 'Name', clear: true, enter: true }), { type: 'Ada', into: 'Name', clear: true, enter: true, kind: 'type', text: 'Ada', target: 'Name', append: false });
  assert.equal(normalizeAction({ select: 'Country', option: 'Canada' }).kind, 'select');
  assert.equal(normalizeAction({ key: 'Enter' }).kind, 'key');
  assert.equal(normalizeAction({ scroll: 'up', pages: 2 }).direction, 'up');
  assert.equal(normalizeAction({ wait_for: 'Done' }).text, 'Done');
  assert.equal(normalizeAction({ back: true }).kind, 'back');
  assert.equal(normalizeAction({ check: 'Done', expect: false }).expect, false);
  assert.equal(normalizeAction({ actions: [] }).kind, 'batch');
  assert.throws(() => normalizeAction({ scroll: 'sideways' }));
  assert.throws(() => normalizeAction({ check: 'Done', expect: 'false' }));
});
test('read-only classification checks every step and keeps all mutation kinds blocked', () => {
  for (const step of [{ goto: 'example.com' }, { back: true }, { check: 'Done' }, { wait_for: 'Done' }, { kind: 'look' }, { kind: 'screenshot' }]) assert.ok(readOnlyAction({ actions: [step] }));
  for (const step of [{ click: 'Send' }, { type: 'Ada', into: 'Name' }, { hover: 'Name' }, { select: 'Country', option: 'Canada' }, { key: 'Enter' }, { scroll: 'down' }, { kind: 'evaluate', script: '1' }, { kind: 'reload' }, { kind: 'dialog' }]) assert.equal(readOnlyAction({ actions: [{ check: 'Done' }, step] }), false);
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
  const tab = { id: 'tab', sessionId: 'one', engine: 'bowser', downloads: [], viewers: new Map() };
  manager.tabs.set(tab.id, tab); let calls = 0; manager.perform = async () => { calls++; return {}; };
  await assert.rejects(manager.run('one', tab.id, { actions: [{ goto: 'example.com' }, { click: 'Send' }] }), /read-only/);
  await manager.run('one', tab.id, { actions: [{ check: 'Done' }, { wait_for: 'Done' }] }); assert.equal(calls, 1);
  await manager.flows.save('send', [{ click: 'Send' }], '', {});
  await assert.rejects(manager.runFlow('one', tab.id, 'send'), /read-only/);
  assert.equal(calls, 1); await manager.stop();
});
test('batch failure stops delivery and cannot save a failed flow', async () => {
  const manager = new BrowserManager({ directory: join(directory, 'batch'), session: id => ({ id }) });
  const tab = { id: 'tab', sessionId: 'one', engine: 'bowser', downloads: [], viewers: new Map() };
  manager.tabs.set(tab.id, tab); manager.look = async () => ({ text: 'Page' }); let calls = 0;
  manager.bowserAction = async () => { if (++calls === 2) throw new Error('failed'); return {}; };
  const result = await manager.run('one', tab.id, { actions: [{ click: '{{target}}' }, { click: 'Missing' }, { click: 'Never' }], with: { target: 'Send' }, save_as: 'failed' });
  assert.equal(result.failedAt, 1); assert.equal(calls, 2); assert.deepEqual((await manager.listFlows('one')).flows, []);
  await assert.rejects(manager.run('one', tab.id, { actions: [{ actions: [] }] }), /nonnested/);
  await manager.stop();
});
test('flow CLI and RPC pass parameters and selected remote thread correctly', async () => {
  const calls = [], options = { self: () => 'local', env: { HELM_SESSION_ID: 'one' }, print() {}, rpc: async (...args) => { calls.push(args); return {}; } };
  await runBrowserCommand(['flows'], options);
  await runBrowserCommand(['run', 'tab', 'login', 'name=Ada', 'query=a=b'], options);
  assert.equal(calls[0][1], 'browser.flows'); assert.deepEqual(calls[1][2], { id: 'one', tabId: 'tab', name: 'login', with: { name: 'Ada', query: 'a=b' } });
  const manager = { listFlows: id => id, runFlow: (...args) => args }, routes = createBrowserRoutes({ manager });
  assert.equal(await routes.dispatch('browser.flows', { id: 'one' }), 'one');
  assert.deepEqual(await routes.dispatch('browser.run', { id: 'one', tabId: 'tab', name: 'login', with: { name: 'Ada' } }), ['one', 'tab', 'login', { name: 'Ada' }]);
});
