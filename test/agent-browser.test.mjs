import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-agent-browser-'));
process.env.HELM_NO_SERVICE = '1';
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(process.env.HELM_DIR, file);
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { BrowserManager, BowserBridge, BROWSER_PREVIEWS } = await import('../packages/connect/src/browser.js');
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

test('preview profiles reduce capture work, text keeps control without images, and leases restore full quality', async () => {
  let clock = 1; const streams = [], commands = [];
  const page = { url: () => 'about:blank', viewportSize: () => ({ width: 1280, height: 800 }), context: () => ({ newCDPSession: async () => {
    const cdp = new EventEmitter(); streams.push(cdp); cdp.detach = async () => {};
    cdp.send = async (method, params) => { commands.push({ method, params }); }; return cdp;
  } }) };
  const manager = new BrowserManager({ session: sid => ({ id: sid }), now: () => clock });
  const tab = { id: 'preview', sessionId: 'one', engine: 'chromium', page, viewers: new Map(), downloads: [], sequence: 0 }; manager.tabs.set(tab.id, tab);
  await manager.frame('one', tab.id, { viewer: 'phone', preview: 'text' }); assert.equal(streams.length, 0);
  await manager.control('one', tab.id, 'phone', true); clock += 5000;
  const text = await manager.frame('one', tab.id, { viewer: 'phone', preview: 'text' });
  assert.equal(text.tab.control, 'phone'); assert.equal(text.image, undefined); assert.equal(streams.length, 0);
  await Promise.all([manager.frame('one', tab.id, { viewer: 'desktop', preview: 'full' }), manager.frame('one', tab.id, { viewer: 'desktop', preview: 'full' })]);
  assert.equal(streams.length, 1);
  const full = commands.find(c => c.method === 'Page.startScreencast').params;
  await manager.frame('one', tab.id, { viewer: 'slow', preview: 'low' });
  const low = commands.filter(c => c.method === 'Page.startScreencast').at(-1).params;
  assert.ok(low.maxWidth < full.maxWidth); assert.ok(low.quality < full.quality);
  streams.at(-1).emit('Page.screencastFrame', { data: 'smaller', sessionId: 1 });
  assert.equal((await manager.frame('one', tab.id, { viewer: 'phone', preview: 'text' })).image, undefined);
  assert.equal((await manager.frame('one', tab.id, { viewer: 'desktop', preview: 'full' })).preview, 'low');
  await manager.unwatch('one', tab.id, 'desktop'); await manager.unwatch('one', tab.id, 'slow');
  assert.equal(tab.cdp, null, 'remaining text viewers do not keep screenshot capture alive');
  await manager.frame('one', tab.id, { viewer: 'slow', preview: 'low' });
  clock += 11000;
  assert.equal((await manager.frame('one', tab.id, { viewer: 'desktop', preview: 'full' })).preview, 'full');
  assert.equal(tab.control, null); assert.equal(tab.viewerProfiles.has('slow'), false);
  await manager.unwatch('one', tab.id, 'desktop'); assert.equal(tab.cdp, null);
  await assert.rejects(manager.frame('one', tab.id, { viewer: 'phone', preview: 'unbounded' }), /preview mode/);
  await assert.rejects(manager.frame('one', tab.id, { viewer: 'phone', leaseMs: 999999 }), /expected integer/);
  await manager.frame('one', tab.id, { viewer: 'slow-phone', preview: 'text', leaseMs: 30000 });
  await manager.control('one', tab.id, 'slow-phone', true); clock += 18000; await manager.sweep();
  assert.equal(tab.control, 'slow-phone', 'a slow controller keeps its bounded lease');
  clock += 13000; await manager.sweep(); assert.equal(tab.control, null);
  await manager.stop();
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

test('Bowser owner is reserved before startup and survives Chromium shutdown', async () => {
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  const browser = new EventEmitter(); browser.isConnected = () => true; browser.close = async () => browser.emit('disconnected');
  const bowser = { call: async () => { started(); await new Promise(resolve => { release = resolve; }); return { content: [] }; }, stop() {} };
  const manager = new BrowserManager({ session: sid => ({ id: sid }), launch: async () => browser, bowser });
  const first = manager.open('ownerone', { engine: 'bowser' }); await ready;
  await assert.rejects(manager.open('ownertwo', { engine: 'bowser' }), /shared/); release(); const result = await first;
  await manager.start(); await manager.shutdownBrowser(); assert.equal(manager.tabs.get(result.tab.id).engine, 'bowser'); await manager.stop();
});

test('Bowser EPIPE rejects its requests without an unhandled stream error', async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.write = () => {}; child.kill = () => {};
  const bridge = new BowserBridge({ bin: '/test/bowser', spawnProcess: () => child });
  const pending = bridge.call('look'), rejected = assert.rejects(pending, /EPIPE/);
  child.stdin.emit('error', new Error('EPIPE')); await rejected; assert.equal(bridge.child, null);
});

test('finishing an old stream teardown cannot erase a newer stream frame', async () => {
  let stopped, release; const stopping = new Promise(resolve => { stopped = resolve; });
  const old = new EventEmitter(); old.send = async method => { if (method === 'Page.stopScreencast') { stopped(); await new Promise(resolve => { release = resolve; }); } }; old.detach = async () => {};
  const fresh = new EventEmitter(); fresh.send = async () => {}; fresh.detach = async () => {};
  const page = { url: () => 'about:blank', viewportSize: () => ({ width: 1280, height: 800 }), context: () => ({ newCDPSession: async () => fresh }) };
  const manager = new BrowserManager({ session: sid => ({ id: sid }) });
  const tab = { id: 'tab', sessionId: 'stream', engine: 'chromium', page, cdp: old, frame: 'old', viewers: new Map(), downloads: [], sequence: 0 }; manager.tabs.set('tab', tab);
  const cleanup = manager.clearStream(tab); await stopping;
  await manager.frame('stream', 'tab', { viewer: 'new-viewer' }); fresh.emit('Page.screencastFrame', { data: 'new', sessionId: 1 }); release(); await cleanup;
  assert.equal(tab.frame, 'data:image/jpeg;base64,new'); assert.equal(tab.cdp, fresh); await manager.stop();
});

test('download retention evicts old files and rejects oversized completed downloads', async () => {
  const manager = new BrowserManager({ session: sid => ({ id: sid }) });
  const tab = { id: 'download-tab', sessionId: 'downloads', engine: 'bowser', downloads: [], viewers: new Map() }; manager.tabs.set(tab.id, tab);
  const folder = join(process.env.HELM_DIR, 'download-fixture'); mkdirSync(folder);
  for (let i = 0; i < 3; i++) { const path = join(folder, String(i)); writeFileSync(path, ''); truncateSync(path, 128 * 1024 * 1024); tab.downloads.push({ id: String(i), name: String(i), path, at: i, status: i < 2 ? 'ready' : 'pending' }); }
  await manager.finishDownload(tab, tab.downloads[2]); assert.equal(tab.downloads[0].status, 'expired'); assert.equal(existsSync(tab.downloads[0].path), false);
  const huge = { id: 'huge', name: 'huge', path: join(folder, 'huge'), status: 'pending' }; writeFileSync(huge.path, ''); truncateSync(huge.path, 129 * 1024 * 1024); tab.downloads.push(huge);
  await manager.finishDownload(tab, huge); assert.match(huge.status, /too large/); assert.equal(existsSync(huge.path), false); await manager.stop();
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
  const cancelled = assert.rejects(second, /control/i);
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
  await assert.rejects(manager.run('one', 'tab', { kind: 'dialog', accept: true }), /read-only/);
  await assert.rejects(manager.run('one', 'tab', { kind: 'batch', actions: [{ kind: 'evaluate', script: '1' }] }), /read-only/);
  assert.deepEqual(await manager.run('one', 'tab', { kind: 'console' }), { entries: [] }); await manager.stop();
});

test('CLI resolves explicitly selected remote thread and writes returned screenshot locally', async () => {
  const calls = [], out = join(process.env.HELM_DIR, 'capture.jpg');
  await runBrowserCommand(['screenshot', 'tab', '--session', 'remote', '--output', out], { findSession: async () => ({ env: 'laptop', session: { id: 'remote' } }), rpc: async (...args) => { calls.push(args); return { image: 'data:image/jpeg;base64,aGVsbG8=' }; }, print: () => {} });
  assert.equal(calls[0][0], 'laptop'); assert.equal(calls[0][2].id, 'remote'); assert.equal(readFileSync(out, 'utf8'), 'hello');
});

const streamPage = (acks = []) => {
  const cdp = new EventEmitter(); cdp.detach = async () => {}; cdp.send = async (method, params) => { if (method === 'Page.screencastFrameAck') acks.push(params.sessionId); };
  const page = { u: 'http://x/1', url() { return this.u; }, viewportSize: () => ({ width: 1280, height: 800 }), title: async () => 'Title', mouse: { click: async () => {}, move: async () => {} }, goto: async function (u) { this.u = u; }, evaluate: async function () { return { title: 'Title', url: this.u, text: '', elements: [] }; }, context: () => ({ newCDPSession: async () => cdp }) };
  return { cdp, page };
};
const paint = (cdp, data, sessionId) => cdp.emit('Page.screencastFrame', { data, sessionId });
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const fakeTab = (page, extra = {}) => ({ id: 'tab', sessionId: 'one', engine: 'chromium', page, viewers: new Map(), downloads: [], lastUsed: Date.now(), sequence: 0, console: [], network: [], ...extra });

test('frame long poll answers at once when a newer frame exists, waits for a paint, and gives up at its cap', async () => {
  const { cdp, page } = streamPage(), manager = new BrowserManager({ session: sid => ({ id: sid }) }), tab = fakeTab(page); manager.tabs.set('tab', tab);
  // Nothing painted yet: the request is held until the cap, then answers without an image.
  let started = Date.now(); const idle = await manager.frame('one', 'tab', { viewer: 'a', waitMs: 80 });
  assert.equal(idle.image, undefined); assert.ok(Date.now() - started >= 70); assert.ok(idle.waited >= 70);
  // A paint during the wait releases the request with that frame.
  started = Date.now(); const held = manager.frame('one', 'tab', { viewer: 'a', since: idle.sequence, waitMs: 1500 });
  await tick(30); assert.equal(tab.waiters.size, 1); paint(cdp, 'first', 1);
  const woke = await held; assert.equal(woke.image, 'data:image/jpeg;base64,first'); assert.ok(Date.now() - started < 600); assert.equal(tab.waiters.size, 0);
  // A frame the viewer has not seen yet comes back immediately, without a wait.
  paint(cdp, 'second', 2); started = Date.now();
  const now = await manager.frame('one', 'tab', { viewer: 'a', since: woke.sequence, waitMs: 1500 });
  assert.equal(now.image, 'data:image/jpeg;base64,second'); assert.equal(now.waited, undefined); assert.ok(Date.now() - started < 300);
  // Several viewers waiting on one tab all wake on the same paint.
  const both = Promise.all([manager.frame('one', 'tab', { viewer: 'a', since: now.sequence, waitMs: 1500 }), manager.frame('one', 'tab', { viewer: 'b', since: now.sequence, waitMs: 1500 })]);
  await tick(30); assert.equal(tab.waiters.size, 2); paint(cdp, 'third', 3);
  assert.deepEqual((await both).map(r => r.image), ['data:image/jpeg;base64,third', 'data:image/jpeg;base64,third']);
  // Text viewers never wait, and the cap is bounded.
  started = Date.now(); assert.equal((await manager.frame('one', 'tab', { viewer: 't', preview: 'text', waitMs: 1500 })).waited, undefined); assert.ok(Date.now() - started < 300);
  await assert.rejects(manager.frame('one', 'tab', { viewer: 'a', waitMs: 60000 }), /expected integer/);
  await manager.stop();
});

test('a waiting frame request is released by unwatch, by stream teardown and by stopping', async () => {
  const { cdp, page } = streamPage(), manager = new BrowserManager({ session: sid => ({ id: sid }) }), tab = fakeTab(page); manager.tabs.set('tab', tab);
  await manager.frame('one', 'tab', { viewer: 'a', waitMs: 10 }); paint(cdp, 'x', 1);
  const seen = (await manager.frame('one', 'tab', { viewer: 'a' })).sequence;
  const hold = async () => { const started = Date.now(), held = manager.frame('one', 'tab', { viewer: 'a', since: seen, waitMs: 1500 }); await tick(30); assert.equal(tab.waiters.size, 1); return async () => { await held; assert.ok(Date.now() - started < 600, 'released well before the 1.5s cap'); assert.equal(tab.waiters.size, 0); }; };
  let done = await hold(); await manager.unwatch('one', 'tab', 'a'); await done();
  done = await hold(); await manager.clearStream(tab); await done();
  done = await hold(); await manager.stop(); await done();
});

test('the owner’s input lets the next paints through without waiting for the pacing delay', async () => {
  const acks = [], { cdp, page } = streamPage(acks), manager = new BrowserManager({ session: sid => ({ id: sid }) }), tab = fakeTab(page); manager.tabs.set('tab', tab);
  await manager.frame('one', 'tab', { viewer: 'owner', preview: 'low' }); await manager.control('one', 'tab', 'owner', true);
  paint(cdp, 'a', 11); assert.deepEqual(acks, [], 'low-data pacing holds the acknowledgement for a second');
  await manager.run('one', 'tab', { kind: 'click', x: 5, y: 5 }, 'owner');
  assert.deepEqual(acks, [11], 'the waiting acknowledgement was sent by the input');
  paint(cdp, 'b', 12); assert.deepEqual(acks, [11, 12], 'a paint right after the input is acknowledged at once');
  await tick(450); paint(cdp, 'c', 13); assert.deepEqual(acks, [11, 12], 'pacing returns after the short window');
  await manager.stop();
});

test('smooth preview is the fastest tier and a slower viewer still sets the stream', async () => {
  const { page } = streamPage(), manager = new BrowserManager({ session: sid => ({ id: sid }) }), tab = fakeTab(page); manager.tabs.set('tab', tab);
  assert.equal((await manager.frame('one', 'tab', { viewer: 'lan', preview: 'smooth' })).preview, 'smooth');
  assert.ok(BROWSER_PREVIEWS.smooth.interval < BROWSER_PREVIEWS.full.interval && BROWSER_PREVIEWS.smooth.interval <= 40);
  assert.equal((await manager.frame('one', 'tab', { viewer: 'far', preview: 'full' })).preview, 'full');
  await manager.stop();
});

test('tab list writes are coalesced after busy bursts but never lost on navigation, close or stop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-persist-')), file = join(directory, 'one', 'tabs.json'), { page } = streamPage(); let closed = 0;
  const context = { storageState: async ({ path }) => writeFileSync(path, '{}'), close: async () => { closed++; } };
  const manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); let writes = 0; const write = manager.persistTabs.bind(manager);
  manager.persistTabs = async sid => { writes++; return write(sid); };
  page.close = async () => { manager.tabs.delete('tab'); };
  manager.recovered.set('one', Promise.resolve()); manager.contexts.set('one', Promise.resolve(context));
  const tab = fakeTab(page); manager.tabs.set('tab', tab);
  for (let i = 0; i < 8; i++) await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 });
  assert.equal(writes, 0, 'a burst of clicks writes nothing yet'); assert.equal(existsSync(file), false);
  await tick(1150); assert.equal(writes, 1, 'one write for the whole burst'); assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].url, 'http://x/1');
  await manager.run('one', 'tab', { kind: 'navigate', url: 'http://x/2' }); assert.equal(writes, 2, 'navigation writes at once'); assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].url, 'http://x/2');
  await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 }); page.u = 'http://x/3'; assert.equal(writes, 2); assert.equal(manager.persistTimers.size, 1);
  await manager.stop(); assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].url, 'http://x/3', 'stop writes what the timer was still holding'); assert.equal(manager.persistTimers.size, 0);
  // Closing the last tab writes the empty list at once and cancels any held write.
  manager.stopping = false; manager.tabs.set('tab', tab); manager.contexts.set('one', Promise.resolve(context)); manager.recovered.set('one', Promise.resolve());
  await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 }); assert.equal(manager.persistTimers.size, 1);
  await manager.close('one', 'tab'); assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []); assert.equal(manager.persistTimers.size, 0); assert.equal(closed, 1);
  await tick(1150); assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [], 'a cancelled write does not run later');
  rmSync(directory, { recursive: true, force: true });
});

test('a crashed browser does not let a held write erase the saved tab list', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-persist-')), file = join(directory, 'one', 'tabs.json'), { page } = streamPage();
  const manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); manager.recovered.set('one', Promise.resolve());
  const tab = fakeTab(page); manager.tabs.set('tab', tab);
  await manager.persistTabs('one'); await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 });
  manager.tabs.delete('tab'); // what the disconnect handler does
  await tick(1150); assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1, 'the earlier list survives for recovery');
  rmSync(directory, { recursive: true, force: true });
});

test('Playwright’s own browser is tried first; a pinned path wins; the system browser is the fallback', async () => {
  const { chromium } = await import('playwright'), real = chromium.launch, calls = [], browser = new EventEmitter(); browser.isConnected = () => true; browser.close = async () => {};
  const saved = { HELM_CHROMIUM_PATH: process.env.HELM_CHROMIUM_PATH, HELM_TEST_CHROMIUM: process.env.HELM_TEST_CHROMIUM };
  const run = async (env, launch) => {
    for (const key of Object.keys(saved)) delete process.env[key]; Object.assign(process.env, env); calls.length = 0; chromium.launch = async options => { calls.push(options.executablePath); return launch(options); };
    const manager = new BrowserManager({ session: sid => ({ id: sid }) });
    try { await manager.start(); } catch (error) { return error; } finally { await manager.stop(); }
  };
  try {
    await run({ HELM_CHROMIUM_PATH: '/pinned/chrome' }, () => browser); assert.deepEqual(calls, ['/pinned/chrome']);
    await run({}, () => browser); assert.deepEqual(calls, [undefined], 'no path is forced, so Playwright picks its headless shell');
    const system = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
    const error = await run({}, options => { if (!options.executablePath) throw new Error('Executable doesn\'t exist'); return browser; });
    if (system) { assert.equal(error, undefined); assert.deepEqual(calls, [undefined, system]); } else assert.match(error.message, /could not start/);
  } finally { chromium.launch = real; for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
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
  const page = manager.tabs.get(first.tab.id).page, observed = page.waitForEvent('dialog');
  const alert = manager.run('one', first.tab.id, { kind: 'evaluate', script: 'alert("Need input"); "dismissed"' });
  await observed; await manager.control('one', first.tab.id, 'phone', true); await manager.run('one', first.tab.id, { kind: 'dialog', accept: false }, 'phone'); assert.equal((await alert).value, 'dismissed'); await manager.control('one', first.tab.id, 'phone', false);
  await manager.run('one', first.tab.id, { kind: 'resize', width: 390, height: 844 });
  await assert.rejects(manager.run('one', second.tab.id, { kind: 'look' }), /not found/);
  const savedId = first.tab.id; await manager.stop();
  assert.ok(existsSync(join(directory, 'one', 'storage.json')));
  manager = new BrowserManager({ directory, session: sid => ({ id: sid }), launch });
  const restored = (await manager.list('one')).tabs[0]; assert.equal(restored.id, savedId); assert.deepEqual(restored.viewport, { width: 390, height: 844 });
  assert.equal((await manager.run('one', savedId, { kind: 'evaluate', script: 'localStorage.getItem("private")' })).value, 'one');
  await manager.close('one', savedId); assert.equal((await manager.list('one')).tabs.length, 0); assert.equal(manager.browser, null);
});
