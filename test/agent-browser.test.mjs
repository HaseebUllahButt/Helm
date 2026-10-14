import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-agent-browser-'));
process.env.HELM_NO_SERVICE = '1';
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(process.env.HELM_DIR, file);
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { BrowserManager, BowserBridge } = await import('../packages/connect/src/browser.js');
const { createBrowserRoutes } = await import('../packages/connect/src/browser-routes.js');
const { runBrowserCommand } = await import('../packages/connect/src/browser-cli.js');

test('browser is lazy, actions cannot cross thread boundaries, and UI control blocks only mutations', async () => {
  let launched = 0;
  const manager = new BrowserManager({ session: sid => ['one', 'two'].includes(sid) ? { id: sid } : null, launch: () => { launched++; throw new Error('unexpected launch'); } });
  assert.deepEqual((await manager.list('one')).tabs, []); assert.equal(launched, 0);
  const tab = { id: 'tab', sessionId: 'one', engine: 'bowser', downloads: [], console: [], network: [], viewers: new Map(), control: 'owner' }; manager.tabs.set('tab', tab);
  await assert.rejects(manager.run('two', 'tab', { kind: 'look' }), /not found/);
  await assert.rejects(manager.run('one', 'tab', { kind: 'navigate', url: 'https://example.com' }), /control/);
  assert.deepEqual(await manager.run('one', 'tab', { kind: 'console' }), { entries: [] });
  await assert.rejects(manager.control('one', 'tab', 'other', true), /another viewer/);
  await manager.control('one', 'tab', 'owner', false); assert.equal(tab.control, null);
  await manager.stop();
});

test('stream keeps one frame, rejects stale cross-thread access, and stops after viewer timeout', async () => {
  let clock = 1, stops = 0;
  const cdp = new EventEmitter(); cdp.send = async command => { if (command === 'Page.stopScreencast') stops++; }; cdp.detach = async () => {};
  const page = { url: () => 'about:blank', viewportSize: () => ({ width: 1280, height: 800 }), context: () => ({ newCDPSession: async () => cdp }) };
  const manager = new BrowserManager({ session: sid => ({ id: sid }), now: () => clock });
  manager.tabs.set('tab', { id: 'tab', sessionId: 'one', engine: 'chromium', page, viewers: new Map(), downloads: [], lastUsed: clock, sequence: 0 });
  await Promise.all([manager.frame('one', 'tab', { viewer: 'phone' }), manager.frame('one', 'tab', { viewer: 'desktop' })]);
  cdp.emit('Page.screencastFrame', { data: 'first', sessionId: 1 }); cdp.emit('Page.screencastFrame', { data: 'latest', sessionId: 2 });
  const frame = await manager.frame('one', 'tab', { viewer: 'phone', since: 0 }); assert.equal(frame.image, 'data:image/jpeg;base64,latest');
  assert.equal((await manager.frame('one', 'tab', { viewer: 'phone', since: frame.sequence })).image, undefined);
  await assert.rejects(manager.frame('two', 'tab', { viewer: 'phone' }), /not found/);
  clock += 11000; await manager.sweep(); assert.equal(stops, 1); assert.equal(manager.tabs.get('tab').cdp, null);
  await manager.stop();
});

test('Bowser reuses one bridge and propagates a human pause instead of bypassing it', async () => {
  let starts = 0;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: source => { const request = JSON.parse(source); queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, result: request.params.name === 'act' ? { isError: true, content: [{ type: 'text', text: 'Automation is paused by the owner' }] } : { content: [{ type: 'text', text: 'Page controls' }] } }) + '\n'))); } };
  const bridge = new BowserBridge({ bin: '/test/bowser', spawnProcess: () => { starts++; return child; } });
  assert.equal((await bridge.call('look')).content[0].text, 'Page controls'); await bridge.call('look'); assert.equal(starts, 1);
  await assert.rejects(bridge.call('act', { actions: [] }), /paused/); bridge.stop();
});

test('unchanged Bowser frame is available after closing and reopening a viewer', async () => {
  const manager = new BrowserManager({ session: sid => ({ id: sid }) });
  manager.capture = async () => ({ image: 'data:image/jpeg;base64,same' });
  manager.tabs.set('tab', { id: 'tab', sessionId: 'one', engine: 'bowser', downloads: [], viewers: new Map(), sequence: 0 });
  const first = await manager.frame('one', 'tab', { viewer: 'phone' });
  await manager.unwatch('one', 'tab', 'phone');
  const reopened = await manager.frame('one', 'tab', { viewer: 'phone' });
  assert.equal(reopened.image, first.image); assert.ok(reopened.sequence > first.sequence); await manager.stop();
});

test('releasing control cancels queued viewer mutations while retaining the action already sent', async () => {
  const manager = new BrowserManager({ session: sid => ({ id: sid }) });
  const tab = { id: 'tab', sessionId: 'one', engine: 'bowser', downloads: [], viewers: new Map(), control: 'phone' }; manager.tabs.set('tab', tab);
  let finish, started, calls = 0; const ready = new Promise(resolve => { started = resolve; });
  manager.perform = async () => { calls++; started(); await new Promise(resolve => { finish = resolve; }); return {}; };
  const first = manager.run('one', 'tab', { kind: 'type', text: 'first' }, 'phone'); await ready;
  const second = manager.run('one', 'tab', { kind: 'type', text: 'queued' }, 'phone');
  const released = manager.control('one', 'tab', 'phone', false);
  // Bind the rejection before completing the first operation.
  const cancelled = assert.rejects(second, /Take control/);
  finish(); await first; await cancelled; await released; assert.equal(calls, 1); await manager.stop();
});

test('human takeover stops an agent batch at its next step', async () => {
  const manager = new BrowserManager({ session: sid => ({ id: sid }) });
  const tab = { id: 'tab', sessionId: 'one', engine: 'bowser', downloads: [], viewers: new Map(), control: null }; manager.tabs.set('tab', tab);
  let finish, started, calls = 0; const ready = new Promise(resolve => { started = resolve; });
  manager.look = async () => ({ text: 'Current page' });
  manager.bowserAction = async () => { calls++; started(); await new Promise(resolve => { finish = resolve; }); return {}; };
  const batch = manager.run('one', 'tab', { kind: 'batch', actions: [{ kind: 'type', text: 'first' }, { kind: 'type', text: 'never sent' }] }); await ready;
  const takeover = manager.control('one', 'tab', 'phone', true); finish(); const result = await batch; await takeover;
  assert.equal(result.failedAt, 1); assert.match(result.error, /control/); assert.equal(calls, 1); await manager.stop();
});

test('a read-only agent can inspect a tab but cannot mutate it through browser CLI', async () => {
  const manager = new BrowserManager({ session: sid => ({ id: sid, mode: 'readonly' }) });
  manager.tabs.set('tab', { id: 'tab', sessionId: 'one', engine: 'bowser', downloads: [], console: [], viewers: new Map() });
  await assert.rejects(manager.run('one', 'tab', { kind: 'type', text: 'no' }), /read-only/);
  await assert.rejects(manager.run('one', 'tab', { kind: 'batch', actions: [{ kind: 'evaluate', script: '1' }] }), /read-only/);
  assert.deepEqual(await manager.run('one', 'tab', { kind: 'console' }), { entries: [] }); await manager.stop();
});

test('CLI resolves explicitly selected remote thread and writes returned screenshot locally', async () => {
  const calls = [], out = join(process.env.HELM_DIR, 'capture.jpg');
  await runBrowserCommand(['screenshot', 'tab', '--session', 'remote', '--output', out], { findSession: async () => ({ env: 'laptop', session: { id: 'remote' } }), rpc: async (...args) => { calls.push(args); return { image: 'data:image/jpeg;base64,aGVsbG8=' }; }, print: () => {} });
  assert.equal(calls[0][0], 'laptop'); assert.equal(calls[0][2].id, 'remote'); assert.equal(readFileSync(out, 'utf8'), 'hello');
});

test('real browser isolation, batched actions, uploads, owner control and restart restore', { timeout: 60000 }, async t => {
  const { chromium } = await import('playwright');
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Browser test</title><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output><input type="file" id="upload"><script>console.log("ready")</script>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`, directory = join(process.env.HELM_DIR, 'live');
  let launches = 0, manager;
  const launch = async () => { launches++; return chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) }); };
  manager = new BrowserManager({ directory, session: sid => ({ id: sid }), launch });
  t.after(async () => { await manager.stop(); await new Promise(resolve => server.close(resolve)); });
  const first = await manager.open('one', { url }); const second = await manager.open('two', { url }); assert.equal(launches, 1);
  assert.ok(first.elements.some(e => e.name === 'Save'));
  await manager.run('one', first.tab.id, { kind: 'batch', actions: [{ kind: 'type', selector: '#name', text: 'Helm' }, { kind: 'click', name: 'Save' }, { kind: 'evaluate', script: 'localStorage.setItem("private","one")' }] });
  assert.equal((await manager.run('one', first.tab.id, { kind: 'evaluate', script: 'document.querySelector("output").textContent' })).value, 'Helm');
  assert.equal((await manager.run('two', second.tab.id, { kind: 'evaluate', script: 'localStorage.getItem("private")' })).value, null);
  await manager.run('one', first.tab.id, { kind: 'upload', selector: '#upload', uploads: [{ name: 'note.txt', data: Buffer.from('private upload').toString('base64') }] });
  assert.equal((await manager.run('one', first.tab.id, { kind: 'evaluate', script: 'document.querySelector("#upload").files[0].name' })).value, 'note.txt');
  await assert.rejects(manager.run('one', first.tab.id, { kind: 'upload', selector: '#upload', uploads: [{ name: 'bad', data: 'not base64!' }] }), /upload data/);
  await assert.rejects(manager.run('one', first.tab.id, { kind: 'upload', ref: 299, uploads: [{ name: 'stale.txt', data: 'c3RhbGU=' }] }), /reference expired/);
  assert.deepEqual(readdirSync(join(directory, 'one', 'uploads')), []);
  await manager.control('one', first.tab.id, 'phone', true); await assert.rejects(manager.run('one', first.tab.id, { kind: 'type', text: 'oops' }), /control/); await manager.control('one', first.tab.id, 'phone', false);
  await assert.rejects(manager.run('one', second.tab.id, { kind: 'look' }), /not found/);
  const savedId = first.tab.id; await manager.stop();
  assert.ok(existsSync(join(directory, 'one', 'storage.json')));
  manager = new BrowserManager({ directory, session: sid => ({ id: sid }), launch });
  assert.equal((await manager.list('one')).tabs[0].id, savedId);
  assert.equal((await manager.run('one', savedId, { kind: 'evaluate', script: 'localStorage.getItem("private")' })).value, 'one');
  await manager.close('one', savedId); assert.equal((await manager.list('one')).tabs.length, 0); assert.equal(manager.browser, null);
});
