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
  const context = { storageState: async () => ({ cookies: [], origins: [] }), close: async () => { closed++; } };
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

test('Chromium dying before Helm keeps the tab list, and a page closing on its own still updates it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-persist-')), file = join(directory, 'one', 'tabs.json');
  const page = () => Object.assign(new EventEmitter(), { url: () => 'http://x/1', viewportSize: () => ({ width: 800, height: 600 }) });
  const saved = () => JSON.parse(readFileSync(file, 'utf8')).length;
  // A restart: Chromium's pages close while the browser still looks connected, then Helm stops.
  let manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); manager.closeGraceMs = 30; manager.recovered.set('one', Promise.resolve());
  let connected = true; manager.browser = { isConnected: () => connected, on() {}, close: async () => {} };
  const a = page(), b = page(); manager.register('one', a); manager.register('one', b); await manager.persistTabs('one'); assert.equal(saved(), 2);
  a.emit('close'); b.emit('close'); await manager.stop();
  assert.equal(saved(), 2, 'stopping after the pages closed forgets nothing');
  await tick(60); assert.equal(saved(), 2, 'nor does the close check that was still waiting');
  // A crash: the pages close and the browser is gone.
  manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); manager.closeGraceMs = 30; manager.recovered.set('one', Promise.resolve());
  manager.browser = { isConnected: () => false, on() {} };
  const c = page(); manager.register('one', c); await manager.persistTabs('one'); c.emit('close'); await tick(60);
  assert.equal(saved(), 1);
  // window.close(): the browser is alive without the page.
  manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); manager.closeGraceMs = 30; manager.recovered.set('one', Promise.resolve());
  manager.browser = { isConnected: () => true, on() {} };
  const d = page(), e = page(); manager.register('one', d); manager.register('one', e); await manager.persistTabs('one');
  d.emit('close'); await tick(60);
  assert.equal(saved(), 1, 'a page that closed itself is gone from the list');
  rmSync(directory, { recursive: true, force: true });
});

test('sign-ins are saved while the owner works, at most every 15 seconds', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-persist-')), { page } = streamPage(); let saves = 0, now = 1_000_000;
  const context = { storageState: async () => { saves++; return { cookies: [], origins: [] }; }, close: async () => {} };
  const manager = new BrowserManager({ directory, session: sid => ({ id: sid }), now: () => now });
  manager.recovered.set('one', Promise.resolve()); manager.contexts.set('one', Promise.resolve(context));
  const tab = fakeTab(page); tab.viewers.set('v', now); manager.tabs.set('tab', tab);
  await manager.sweep(); assert.equal(saves, 0, 'nothing done, nothing to save');
  await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 }); await manager.sweep(); assert.equal(saves, 1, 'saved after the owner acted');
  now += 5000; await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 }); await manager.sweep(); assert.equal(saves, 1, 'not again within 15 seconds');
  now += 11000; tab.viewers.set('v', now); await manager.sweep(); assert.equal(saves, 2, 'the later action is saved once the 15 seconds pass');
  now += 20000; tab.viewers.set('v', now); await manager.sweep(); assert.equal(saves, 2, 'no action since, no save');
  await manager.stop(); rmSync(directory, { recursive: true, force: true });
});

test('the address bar takes a host, a local dev server or words to search', async () => {
  const { httpUrl } = await import('../packages/connect/src/browser.js');
  assert.equal(httpUrl('github.com/a?b=1'), 'https://github.com/a?b=1');
  assert.equal(httpUrl('localhost:3000'), 'http://localhost:3000/', 'dev servers are plain http');
  assert.equal(httpUrl('192.168.1.5:5173/x'), 'http://192.168.1.5:5173/x');
  assert.equal(httpUrl('vm:8787'), 'http://vm:8787/');
  assert.equal(httpUrl('how do cookies work'), 'https://www.bing.com/search?q=how%20do%20cookies%20work');
  assert.equal(httpUrl('helm'), 'https://www.bing.com/search?q=helm');
  assert.equal(httpUrl('http://example.com'), 'http://example.com/');
  assert.throws(() => httpUrl('file:///etc/passwd'), /HTTP or HTTPS/);
  assert.match(httpUrl('javascript:alert(1)'), /^https:\/\/www\.bing\.com\//, 'a script address is only ever searched for');
});

test('a tab says it is loading from the main page request until the page loads', async () => {
  const manager = new BrowserManager({ directory: mkdtempSync(join(tmpdir(), 'helm-load-')), session: sid => ({ id: sid }) });
  const main = {}, page = Object.assign(new EventEmitter(), { url: () => 'http://x/', viewportSize: () => ({ width: 800, height: 600 }), mainFrame: () => main });
  const tab = manager.register('one', page), request = (frame, nav = true) => ({ isNavigationRequest: () => nav, frame: () => frame, resourceType: () => 'document' });
  page.emit('request', request({}, true)); assert.equal(manager.metadata(tab).loading, false, 'a frame inside the page is not the page loading');
  page.emit('request', request(main, false)); assert.equal(manager.metadata(tab).loading, false);
  const before = tab.revision || 0; page.emit('request', request(main)); assert.equal(manager.metadata(tab).loading, true); assert.ok(tab.revision > before, 'a waiting viewer hears it at once');
  page.emit('load'); assert.equal(manager.metadata(tab).loading, false);
  page.emit('request', request(main)); page.emit('requestfailed', Object.assign(request(main), { failure: () => ({ errorText: 'x' }), url: () => 'http://x/', method: () => 'GET' })); assert.equal(manager.metadata(tab).loading, false, 'a failed load ends too');
  page.emit('close');
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

test('agent pointer is recorded only for a watching viewer and point guides without touching the page', async () => {
  let clock = 1000, clicks = 0, scrolled = 0;
  const box = { x: 100, y: 40, width: 80, height: 20 };
  const locator = { first: () => locator, scrollIntoViewIfNeeded: async () => { scrolled++; }, boundingBox: async () => box, evaluate: async () => 'Sign in', click: async () => { clicks++; } };
  const page = { url: () => 'http://example.test/', title: async () => 'Example', viewportSize: () => ({ width: 1280, height: 800 }), locator: () => locator, mouse: { click: async () => { clicks++; }, move: async () => {} }, evaluate: async () => ({ title: 'Example', url: 'http://example.test/', text: '', elements: [] }) };
  const manager = new BrowserManager({ session: sid => ({ id: sid, mode: sid === 'reader' ? 'readonly' : 'default' }), now: () => clock });
  const tab = { id: 'tab', sessionId: 'one', engine: 'chromium', page, viewers: new Map(), downloads: [], console: [], network: [] }; manager.tabs.set('tab', tab);
  manager.persistTabs = async () => {};
  const started = Date.now(); await manager.run('one', 'tab', { kind: 'click', selector: 'button' });
  assert.equal(tab.pointer, undefined, 'nobody watching: no pointer work'); assert.equal(scrolled, 0); assert.ok(Date.now() - started < 100, 'nobody watching: no added wait');
  tab.viewers.set('phone', clock); tab.viewerProfiles = new Map([['phone', 'full']]);
  const result = await manager.run('one', 'tab', { kind: 'click', selector: 'button' });
  assert.deepEqual(result.tab.pointer, { x: 140, y: 50, box, action: 'click', label: 'Clicking “Sign in”', by: 'agent', seq: 1, at: 1000 }); assert.equal(clicks, 2);
  await manager.run('one', 'tab', { kind: 'scroll', dy: -300 }).catch(() => {});
  assert.equal(tab.pointer.label, 'Scrolling up'); assert.deepEqual([tab.pointer.x, tab.pointer.y], [640, 400]);
  clock += 5000; assert.equal(manager.metadata(tab).pointer, null, 'an idle agent pointer fades');
  tab.viewerProfiles.set('phone', 'text'); await manager.run('one', 'tab', { kind: 'click', x: 5, y: 5 }); assert.equal(tab.pointer.seq, 2, 'text-only viewers see no pointer');
  // A guide works with nobody watching, while the owner holds control, and in a read-only thread.
  tab.viewers.clear(); await manager.control('one', 'tab', 'phone', true);
  const guided = await manager.run('one', 'tab', { kind: 'point', selector: '#approve', note: 'Click here to approve' });
  assert.deepEqual(guided.tab.pointer, { x: 140, y: 50, box, action: 'point', label: '“Sign in”', by: 'guide', note: 'Click here to approve', seq: 3, at: clock });
  assert.equal(clicks, 3, 'point never clicks'); assert.equal(scrolled, 1, 'point never scrolls');
  clock += 30000; assert.equal(manager.metadata(tab).pointer.by, 'guide');
  await manager.run('one', 'tab', { kind: 'hover', x: 2, y: 2 }, 'phone'); assert.equal(tab.pointer?.by, 'guide', 'owner hovering keeps the guide');
  await manager.run('one', 'tab', { kind: 'click', x: 2, y: 2 }, 'phone'); assert.equal(tab.pointer, null, 'owner clicking clears the guide');
  await manager.run('one', 'tab', { kind: 'point', x: 10, y: 20, note: 'Here' }); clock += 61000; assert.equal(manager.metadata(tab).pointer, null, 'a guide lasts a minute');
  await assert.rejects(manager.run('one', 'tab', { kind: 'point', x: 5000, y: 20 }), /not on screen/);
  await assert.rejects(manager.run('one', 'tab', { kind: 'point' }), /choose a target/);
  manager.tabs.set('read', { ...tab, id: 'read', sessionId: 'reader', control: null, pointer: null }); await manager.run('reader', 'read', { kind: 'point', selector: 'button' });
  assert.equal(manager.tabs.get('read').pointer.by, 'guide');
  manager.tabs.set('shared', { id: 'shared', sessionId: 'one', engine: 'bowser', downloads: [], viewers: new Map() });
  await assert.rejects(manager.run('one', 'shared', { kind: 'point', ref: 1 }), /isolated Chromium/);
  await manager.stop();
});

test('browser point CLI builds a guide action and opening a tab tells the chat', async () => {
  const calls = [];
  const rpc = async (...args) => { calls.push(args); return {}; };
  await runBrowserCommand(['point', 'tab', '3', '--note', 'Approve here'], { env: { HELM_SESSION_ID: 's1' }, self: () => 'me', rpc, print: () => {} });
  await runBrowserCommand(['point', 'tab', 'button.primary'], { env: { HELM_SESSION_ID: 's1' }, self: () => 'me', rpc, print: () => {} });
  assert.deepEqual(calls.map(c => c[2].action), [{ kind: 'point', ref: 3, note: 'Approve here' }, { kind: 'point', selector: 'button.primary' }]);
  await assert.rejects(runBrowserCommand(['point', 'tab'], { env: { HELM_SESSION_ID: 's1' }, self: () => 'me', rpc, print: () => {} }), /element number or CSS selector/);
  const opened = [], manager = { open: async () => ({ tab: { id: 'new' } }), stop: async () => {} };
  const routes = createBrowserRoutes({ sessions: { get: () => ({}) }, manager, onOpen: payload => opened.push(payload) });
  await routes.dispatch('browser.open', { id: 's1', url: 'about:blank' }); await routes.dispatch('browser.open', { id: 's1', viewer: 'owner' });
  assert.deepEqual(opened, [{ id: 's1', tabId: 'new' }, { id: 's1', tabId: 'new', viewer: 'owner' }]);
});

test('a viewer fits the page to its panel without control, after agent actions, and fixed sizes stick', async () => {
  let viewport = { width: 1280, height: 800 }, box = { x: 100, y: 40, width: 80, height: 20 }, release, busy;
  const sizes = [], locator = { first: () => locator, scrollIntoViewIfNeeded: async () => {}, boundingBox: async () => box, evaluate: async () => 'Approve', click: async () => {} };
  const page = { url: () => 'http://example.test/', title: async () => 'Example', viewportSize: () => viewport, setViewportSize: async size => { sizes.push(size); viewport = size; }, locator: () => locator, mouse: {}, evaluate: async () => ({ title: 'Example', url: 'http://example.test/', text: '', elements: [] }) };
  const manager = new BrowserManager({ session: sid => ({ id: sid, mode: 'readonly' }) });
  const tab = { id: 'tab', sessionId: 'one', engine: 'chromium', page, viewers: new Map(), downloads: [], console: [], network: [] }; manager.tabs.set('tab', tab);
  manager.persistTabs = async () => {}; manager.persistSoon = () => {}; manager.settle = async () => {};
  const fit = (viewer, extra) => manager.run('one', 'tab', { kind: 'fit', mode: 'panel', auto: true, width: 700, height: 600, ...extra }, viewer);
  assert.deepEqual((await fit('desk')).tab.viewport, { width: 700, height: 600 }, 'no control needed, even in a read-only chat');
  assert.equal(manager.metadata(tab).fit, true);
  await assert.rejects(manager.run('one', 'tab', { kind: 'fit', mode: 'panel', width: 700, height: 600 }), /read-only/);
  await assert.rejects(fit('desk', { width: 5000 }), /expected integer/);
  await fit('desk'); assert.equal(sizes.length, 1, 'an unchanged size is not sent to the page');
  // It waits its turn behind an agent action.
  manager.perform = (original => async (t, action, actor, ...rest) => { if (action.kind === 'look') { busy = true; await new Promise(resolve => { release = resolve; }); busy = false; return {}; } return original.call(manager, t, action, actor, ...rest); })(manager.perform);
  const agent = manager.run('one', 'tab', { kind: 'look' });
  await new Promise(resolve => setTimeout(resolve, 10));
  const queued = fit('desk', { width: 800 }); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(busy, true); assert.equal(sizes.length, 1, 'no fit lands mid-action'); release(); await agent; await queued; assert.deepEqual(viewport, { width: 800, height: 600 });
  // A fixed choice, or the agent resizing, turns fitting off until Fit is picked again.
  await manager.run('one', 'tab', { kind: 'fit', mode: 'phone' }, 'desk'); assert.deepEqual(viewport, { width: 390, height: 844 }); assert.equal(manager.metadata(tab).fit, false);
  await fit('phone-viewer'); assert.deepEqual(viewport, { width: 390, height: 844 }, 'automatic fits leave a fixed size alone');
  await manager.run('one', 'tab', { kind: 'fit', mode: 'panel', width: 900, height: 700 }, 'phone-viewer'); assert.equal(manager.metadata(tab).fit, true);
  manager.owner = () => ({ id: 'one' }); await manager.run('one', 'tab', { kind: 'resize', width: 1280, height: 800 }); assert.equal(tab.fit, false);
  await assert.rejects(manager.run('one', 'tab', { kind: 'fit', mode: 'panel', width: 700, height: 600 }), /agents use resize/);
  await manager.run('one', 'tab', { kind: 'fit', mode: 'panel', width: 700, height: 600 }, 'desk');
  // While someone has control, only their panel sets the size.
  await manager.control('one', 'tab', 'desk', true);
  await fit('phone-viewer', { width: 400, height: 700 }); assert.deepEqual(viewport, { width: 700, height: 600 });
  await fit('desk', { width: 720 }); assert.deepEqual(viewport, { width: 720, height: 600 });
  await manager.control('one', 'tab', 'desk', false);
  // A guide follows its element through a fit.
  await manager.run('one', 'tab', { kind: 'point', selector: '#approve', note: 'Here' });
  box = { x: 10, y: 300, width: 80, height: 20 }; await fit('desk', { width: 500 });
  assert.deepEqual([tab.pointer.x, tab.pointer.y, tab.pointer.by, tab.pointer.note], [50, 310, 'guide', 'Here']);
  await manager.stop();
});

test('a pointer change answers a waiting viewer at once, and plain-words typing shows the pointer', async () => {
  const box = { x: 100, y: 40, width: 80, height: 20 }, locator = { first: () => locator, scrollIntoViewIfNeeded: async () => {}, boundingBox: async () => box, evaluate: async () => 'Email', fill: async () => {}, dispose: async () => {}, ownerFrame: async () => null };
  const page = { url: () => 'http://example.test/', title: async () => 'Example', viewportSize: () => ({ width: 1280, height: 800 }), locator: () => locator, evaluateHandle: async () => ({ asElement: () => locator }), mainFrame: () => null, evaluate: async () => ({ title: 'Example', url: 'http://example.test/', text: '', elements: [] }) };
  const manager = new BrowserManager({ session: sid => ({ id: sid }) });
  const tab = { id: 'tab', sessionId: 'one', engine: 'chromium', page, viewers: new Map(), downloads: [], console: [], network: [], cdp: { send: async () => {}, detach: async () => {} }, previewMode: 'full', frame: 'data:image/jpeg;base64,x', sequence: 3 }; manager.tabs.set('tab', tab);
  manager.persistTabs = async () => {}; manager.persistSoon = () => {}; manager.settle = async () => {};
  const frame = (waitMs = 1500) => manager.frame('one', 'tab', { viewer: 'phone', since: 3, waitMs });
  await frame(0);
  let started = Date.now(); const waiting = frame(); await new Promise(resolve => setTimeout(resolve, 30));
  await manager.run('one', 'tab', { kind: 'point', selector: '#email', note: 'Type here' });
  const answered = await waiting; assert.ok(Date.now() - started < 500, 'the guide arrives without waiting for a paint'); assert.equal(answered.tab.pointer.by, 'guide');
  manager.changed(tab); started = Date.now(); await frame(); assert.ok(Date.now() - started < 100, 'a change between polls is returned at once');
  started = Date.now(); await frame(); assert.ok(Date.now() - started >= 1400, 'with nothing new the request still waits');
  await manager.run('one', 'tab', { kind: 'type', text: 'Ada', target: 1 });
  assert.equal(tab.pointer.label, 'Typing into “Email”');
  await manager.stop();
});
