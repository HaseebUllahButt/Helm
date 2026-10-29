import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-agent-browser-'));
process.env.HELM_NO_SERVICE = '1';
// No real windows on the screen of the machine running the tests.
delete process.env.WAYLAND_DISPLAY; delete process.env.DISPLAY;
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(process.env.HELM_DIR, file);
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { systemChromium } = await import('../packages/connect/src/browser-window.js');
const { createBrowserRoutes } = await import('../packages/connect/src/browser-routes.js');
const { runBrowserCommand } = await import('../packages/connect/src/browser-cli.js');

test('Mac Chrome is ready without Linux browsers or a Playwright download', () => {
  const browser = new URL('../packages/connect/src/browser.js', import.meta.url).href;
  const window = new URL('../packages/connect/src/browser-window.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    let installed = true;
    fs.existsSync = path => installed && path === chrome;
    fs.readdirSync = () => [];
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    for (const key of ['HELM_CHROMIUM_PATH', 'HELM_TEST_CHROMIUM', 'HELM_WINDOW_CHROMIUM']) delete process.env[key];
    process.env.PATH = '';
    const { browserReady } = await import(${JSON.stringify(browser)});
    const { systemChromium } = await import(${JSON.stringify(window)});
    assert.equal(systemChromium(), chrome);
    assert.equal(browserReady(), true);
    installed = false;
    assert.equal(browserReady(), false);
    process.env.HELM_WINDOW_CHROMIUM = '/custom/window-browser';
    assert.equal(systemChromium(), undefined);
    assert.equal(browserReady(), true);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('tabs from one chat do not block another and all saved tabs survive recovery', async t => {
  const directory = mkdtempSync(join(process.env.HELM_DIR, 'many-tabs-'));
  const makeManager = () => {
    const manager = new BrowserManager({ directory, session: sid => ({ id: sid }), canWindow: false });
    const context = { newPage: async () => {
      let viewport = { width: 800, height: 600 };
      return Object.assign(new EventEmitter(), {
        context: () => context, url: () => 'about:blank', viewportSize: () => viewport,
        setViewportSize: async value => { viewport = value; },
        title: async () => 'New tab', close: async () => {},
      });
    } };
    manager.context = async () => context;
    manager.settle = async () => {};
    manager.look = async () => ({});
    t.after(() => manager.stop());
    return manager;
  };
  const first = makeManager();
  for (let i = 0; i < 26; i++) await first.open('one', { viewer: 'owner' });
  const second = await first.open('two', { viewer: 'owner' });
  assert.equal(second.tab.engine, 'chromium');
  assert.equal((await first.list('one')).tabs.length, 26);
  await first.stop();
  const restored = makeManager();
  assert.equal((await restored.savedRows('one')).length, 26);
  const tabs = (await restored.list('one')).tabs;
  assert.equal(tabs.length, 26);
  assert.equal(new Set(tabs.map(tab => tab.id)).size, 26);
  assert.equal((await restored.list('two')).tabs[0].id, second.tab.id);
});

test('browser is lazy and actions cannot cross thread boundaries', async () => {
  let launched = 0;
  const manager = new BrowserManager({ session: sid => ['one', 'two'].includes(sid) ? { id: sid } : null, launch: () => { launched++; throw new Error('unexpected launch'); } });
  assert.deepEqual((await manager.list('one')).tabs, []); assert.equal(launched, 0);
  const tab = { id: 'tab', sessionId: 'one', engine: 'chromium', downloads: [], console: [], network: [] }; manager.tabs.set('tab', tab);
  await assert.rejects(manager.run('two', 'tab', { kind: 'look' }), /not found/);
  assert.deepEqual(await manager.run('one', 'tab', { kind: 'console' }), { entries: [] });
  await manager.stop();
});

test('download retention evicts old files and rejects oversized completed downloads', async () => {
  const manager = new BrowserManager({ session: sid => ({ id: sid }) });
  const tab = { id: 'download-tab', sessionId: 'downloads', engine: 'chromium', downloads: [] }; manager.tabs.set(tab.id, tab);
  const folder = join(process.env.HELM_DIR, 'download-fixture'); mkdirSync(folder);
  for (let i = 0; i < 3; i++) { const path = join(folder, String(i)); writeFileSync(path, ''); truncateSync(path, 128 * 1024 * 1024); tab.downloads.push({ id: String(i), name: String(i), path, at: i, status: i < 2 ? 'ready' : 'pending' }); }
  await manager.finishDownload(tab, tab.downloads[2]); assert.equal(tab.downloads[0].status, 'expired'); assert.equal(existsSync(tab.downloads[0].path), false);
  const huge = { id: 'huge', name: 'huge', path: join(folder, 'huge'), status: 'pending' }; writeFileSync(huge.path, ''); truncateSync(huge.path, 129 * 1024 * 1024); tab.downloads.push(huge);
  await manager.finishDownload(tab, huge); assert.match(huge.status, /too large/); assert.equal(existsSync(huge.path), false); await manager.stop();
});

test('a read-only agent can inspect a tab but cannot mutate it through browser CLI', async () => {
  const manager = new BrowserManager({ session: sid => ({ id: sid, mode: 'readonly' }) });
  manager.tabs.set('tab', { id: 'tab', sessionId: 'one', engine: 'chromium', downloads: [], console: [] });
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

const fakePage = () => {
  const cdp = new EventEmitter(); cdp.detach = async () => {}; cdp.send = async () => {};
  const page = { u: 'http://x/1', url() { return this.u; }, viewportSize: () => ({ width: 1280, height: 800 }), title: async () => 'Title', mouse: { click: async () => {}, move: async () => {} }, goto: async function (u) { this.u = u; }, evaluate: async function () { return { title: 'Title', url: this.u, text: '', elements: [] }; }, context: () => ({ newCDPSession: async () => cdp }) };
  return { cdp, page };
};
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const fakeTab = (page, extra = {}) => ({ id: 'tab', sessionId: 'one', engine: 'chromium', page, downloads: [], lastUsed: Date.now(), console: [], network: [], ...extra });

test('tab list writes are coalesced after busy bursts but never lost on navigation, close or stop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-persist-')), file = join(directory, 'one', 'tabs.json'), { page } = fakePage(); let closed = 0;
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
  const directory = mkdtempSync(join(tmpdir(), 'helm-persist-')), file = join(directory, 'one', 'tabs.json'), { page } = fakePage();
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
  const directory = mkdtempSync(join(tmpdir(), 'helm-persist-')), { page } = fakePage(); let saves = 0, now = 1_000_000;
  const context = { storageState: async () => { saves++; return { cookies: [], origins: [] }; }, close: async () => {} };
  const manager = new BrowserManager({ directory, session: sid => ({ id: sid }), now: () => now });
  manager.recovered.set('one', Promise.resolve()); manager.contexts.set('one', Promise.resolve(context));
  const tab = fakeTab(page); manager.tabs.set('tab', tab);
  await manager.sweep(); assert.equal(saves, 0, 'nothing done, nothing to save');
  await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 }); await manager.sweep(); assert.equal(saves, 1, 'saved after the owner acted');
  now += 5000; await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 }); await manager.sweep(); assert.equal(saves, 1, 'not again within 15 seconds');
  now += 11000; await manager.sweep(); assert.equal(saves, 2, 'the later action is saved once the 15 seconds pass');
  now += 20000; await manager.sweep(); assert.equal(saves, 2, 'no action since, no save');
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

test('an agent waits for navigation and gets a failed load in plain words', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-go-')), { page, cdp } = fakePage();
  const manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); manager.recovered.set('one', Promise.resolve());
  let fail; page.goto = function (u) { return new Promise((resolve, reject) => { fail = () => reject(new Error(`page.goto: net::ERR_NAME_NOT_RESOLVED at ${u}\nCall log:\n\u001b[2m  - navigating to "${u}"\u001b[22m`)); }); };
  const tab = fakeTab(page); manager.tabs.set('tab', tab);
  const agent = manager.run('one', 'tab', { kind: 'navigate', url: 'eat.nowhere.test' });
  await tick(5); assert.equal(manager.metadata(tab).problem, null, 'a new try clears the old message'); fail();
  await assert.rejects(agent, error => error.message === "Can't find eat.nowhere.test. Check the address.");
  // Stop asks Chromium to stop loading.
  const sent = []; cdp.send = async method => { sent.push(method); };
  await manager.run('one', 'tab', { kind: 'stop' }); assert.ok(sent.includes('Page.stopLoading'));
  await manager.stop(); rmSync(directory, { recursive: true, force: true });
});

test('an agent gets a page once it stops fetching, without waiting for slow pictures', { timeout: 60000 }, async t => {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/img')) return setTimeout(() => { res.setHeader('Content-Type', 'image/gif'); res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')); }, 4000);
    if (req.url === '/api') return setTimeout(() => res.end('data arrived'), 300);
    res.setHeader('Content-Type', 'text/html'); res.end('<title>Heavy</title><img src="/img"><p id=d></p><script>fetch("/api").then(r => r.text()).then(x => d.textContent = x)</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = new BrowserManager({ directory: mkdtempSync(join(tmpdir(), 'helm-settle-')), session: sid => ({ id: sid }), canWindow: false });
  t.after(async () => { await manager.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  try { await manager.start(); } catch { t.skip('no Chromium here'); return; }
  const started = Date.now(), { text } = await manager.open('one', { url: `http://127.0.0.1:${server.address().port}/` });
  assert.match(text, /data arrived/, 'what the page fetched is there');
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('full Chromium is tried first; a pinned path wins; the system browser is the fallback', async () => {
  const { chromium } = await import('patchright-core'), real = chromium.launch, calls = [], browser = new EventEmitter(); browser.isConnected = () => true; browser.close = async () => {}; browser.newBrowserCDPSession = async () => ({ send: async () => ({ userAgent: 'Chrome/153.0.0.0', product: 'Chrome/153.0.1.2' }), detach: async () => {} });
  const saved = { HELM_CHROMIUM_PATH: process.env.HELM_CHROMIUM_PATH, HELM_TEST_CHROMIUM: process.env.HELM_TEST_CHROMIUM };
  const run = async (env, launch) => {
    for (const key of Object.keys(saved)) delete process.env[key]; Object.assign(process.env, env); calls.length = 0; chromium.launch = async options => { assert.equal(options.channel, 'chromium'); assert.ok(options.ignoreDefaultArgs.includes('--enable-automation')); calls.push(options.executablePath); return launch(options); };
    const manager = new BrowserManager({ session: sid => ({ id: sid }) });
    try { await manager.start(); } catch (error) { return error; } finally { await manager.stop(); }
  };
  try {
    await run({ HELM_CHROMIUM_PATH: '/pinned/chrome' }, () => browser); assert.deepEqual(calls, ['/pinned/chrome']);
    await run({}, () => browser); assert.deepEqual(calls, [undefined], 'the Chromium channel selects the full browser');
    const system = systemChromium();
    const error = await run({}, options => { if (!options.executablePath) throw new Error('Executable doesn\'t exist'); return browser; });
    if (system) { assert.equal(error, undefined); assert.deepEqual(calls, [undefined, system]); } else assert.match(error.message, /could not start/);
  } finally { chromium.launch = real; for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('real browser isolation, batched actions, uploads, answering a dialog, and restart restore', { timeout: 60000 }, async t => {
  const { chromium } = await import('playwright');
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Browser test</title><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output><input type="file" id="upload"><script>console.log("ready")</script>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`, directory = join(process.env.HELM_DIR, 'live');
  let launches = 0, manager;
  const launch = async () => { launches++; const path = process.env.HELM_TEST_CHROMIUM || systemChromium(); return chromium.launch({ headless: true, ...(path ? { executablePath: path } : {}) }); };
  manager = new BrowserManager({ directory, session: sid => ({ id: sid }), launch, canWindow: false });
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
  const page = manager.tabs.get(first.tab.id).page, observed = page.waitForEvent('dialog');
  const alert = manager.run('one', first.tab.id, { kind: 'evaluate', script: 'alert("Need input"); "dismissed"' });
  await observed; await manager.run('one', first.tab.id, { kind: 'dialog', accept: false }); assert.equal((await alert).value, 'dismissed');
  await manager.run('one', first.tab.id, { kind: 'resize', width: 390, height: 844 });
  await assert.rejects(manager.run('one', second.tab.id, { kind: 'look' }), /not found/);
  const savedId = first.tab.id; await manager.stop();
  assert.ok(existsSync(join(directory, 'one', 'storage.json')));
  manager = new BrowserManager({ directory, session: sid => ({ id: sid }), launch, canWindow: false });
  const restored = (await manager.list('one')).tabs[0]; assert.equal(restored.id, savedId); assert.deepEqual(restored.viewport, { width: 390, height: 844 });
  assert.equal((await manager.run('one', savedId, { kind: 'evaluate', script: 'localStorage.getItem("private")' })).value, 'one');
  await manager.close('one', savedId); assert.equal((await manager.list('one')).tabs.length, 0); assert.equal(manager.browser, null);
});

test('the agent’s cursor is drawn in a window tab only, and point guides without touching the page', async () => {
  let clock = 1000, clicks = 0, scrolled = 0; const drawn = [];
  const box = { x: 100, y: 40, width: 80, height: 20 };
  const locator = { first: () => locator, scrollIntoViewIfNeeded: async () => { scrolled++; }, boundingBox: async () => box, evaluate: async () => ({ name: 'Sign in', main: true, viewport: { width: 1280, height: 800 }, box }), click: async () => { clicks++; } };
  const page = { url: () => 'http://example.test/', title: async () => 'Example', viewportSize: () => ({ width: 1280, height: 800 }), locator: () => locator, mouse: { click: async () => { clicks++; }, move: async () => {} }, evaluate: async (fn, arg) => { if (arg?.label != null) drawn.push(arg); return { title: 'Example', url: 'http://example.test/', text: '', elements: [] }; } };
  const manager = new BrowserManager({ session: sid => ({ id: sid, mode: sid === 'reader' ? 'readonly' : 'default' }), now: () => clock, canWindow: false });
  const tab = { id: 'tab', sessionId: 'one', engine: 'chromium', page, downloads: [], console: [], network: [] }; manager.tabs.set('tab', tab);
  manager.persistTabs = async () => {}; manager.persistSoon = () => {};
  const started = Date.now(); await manager.run('one', 'tab', { kind: 'click', selector: 'button' });
  assert.equal(tab.pointer, undefined, 'a hidden tab: no cursor work'); assert.equal(scrolled, 0); assert.ok(Date.now() - started < 100, 'a hidden tab: no added wait');
  tab.window = true;
  await manager.run('one', 'tab', { kind: 'click', selector: 'button' });
  assert.deepEqual(tab.pointer, { x: 140, y: 50, box, action: 'click', label: 'Clicking “Sign in”', by: 'agent', seq: 1, at: 1000 }); assert.equal(clicks, 2);
  assert.equal(drawn.at(-1).label, 'Clicking “Sign in”', 'drawn on the page itself');
  assert.equal(scrolled, 0, 'an onscreen target does not repeat the action scroll check');
  await manager.run('one', 'tab', { kind: 'scroll', dy: -300 }).catch(() => {});
  assert.equal(tab.pointer.label, 'Scrolling up'); assert.deepEqual([tab.pointer.x, tab.pointer.y], [640, 400]);
  // A guide works in a hidden tab too, and never clicks or scrolls.
  tab.window = false; scrolled = 0;
  const guided = await manager.run('one', 'tab', { kind: 'point', selector: '#approve', note: 'Click here to approve' });
  assert.deepEqual(guided.tab.pointer, undefined, 'tab answers no longer carry a cursor');
  assert.deepEqual(tab.pointer, { x: 140, y: 50, box, action: 'point', label: '“Sign in”', by: 'guide', note: 'Click here to approve', seq: 3, at: clock });
  assert.equal(drawn.at(-1).guide, true); assert.equal(clicks, 2, 'point never clicks'); assert.equal(scrolled, 0, 'point never scrolls');
  clock += 400; manager.ownerInput(page); assert.equal(tab.pointer, null, 'input in the external window clears the guide');
  await assert.rejects(manager.run('one', 'tab', { kind: 'point', x: 5000, y: 20 }), /not on screen/);
  await assert.rejects(manager.run('one', 'tab', { kind: 'point' }), /choose a target/);
  manager.tabs.set('read', { ...tab, id: 'read', sessionId: 'reader', pointer: null }); await manager.run('reader', 'read', { kind: 'point', selector: 'button' });
  assert.equal(manager.tabs.get('read').pointer.by, 'guide');
  await manager.stop();
});

test('browser point CLI builds a guide action', async () => {
  const calls = [];
  const rpc = async (...args) => { calls.push(args); return {}; };
  await runBrowserCommand(['point', 'tab', '3', '--note', 'Approve here'], { env: { HELM_SESSION_ID: 's1' }, self: () => 'me', rpc, print: () => {} });
  await runBrowserCommand(['point', 'tab', 'button.primary'], { env: { HELM_SESSION_ID: 's1' }, self: () => 'me', rpc, print: () => {} });
  assert.deepEqual(calls.map(c => c[2].action), [{ kind: 'point', ref: 3, note: 'Approve here' }, { kind: 'point', selector: 'button.primary' }]);
  await assert.rejects(runBrowserCommand(['point', 'tab'], { env: { HELM_SESSION_ID: 's1' }, self: () => 'me', rpc, print: () => {} }), /element number or CSS selector/);

});

test('a viewport screenshot shows the page while its web font is still loading', { timeout: 30000 }, async t => {
  let fontRequested, fontResponse;
  const requested = new Promise(resolve => { fontRequested = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/slow-font') { fontResponse = res; res.writeHead(200, { 'Content-Type': 'font/woff2' }); res.flushHeaders(); fontRequested(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<style>@font-face{font-family:slow;src:url(/slow-font)}body{margin:0;font-family:slow,sans-serif;height:2400px;background:linear-gradient(#e61914 0 1000px,#173be8 1000px)}</style><title>Visible now</title><h1>Visible now</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = new BrowserManager({ directory: join(process.env.HELM_DIR, 'font-shot'), session: id => ({ id }), canWindow: false });
  t.after(async () => { fontResponse?.end(); await manager.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const opened = await manager.open('font', { url: `http://127.0.0.1:${server.address().port}` });
  await requested;
  const page = manager.get('font', opened.tab.id).page;
  assert.equal(await page.evaluate(() => document.fonts.status), 'loading');
  const shot = await manager.run('font', opened.tab.id, { kind: 'screenshot' });
  assert.match(shot.image, /^data:image\/jpeg;base64,/);
  assert.equal(fontResponse.writableEnded, false, 'the screenshot did not wait for the font response');
  assert.equal(await page.evaluate(() => document.fonts.status), 'loading');
  await manager.run('font', opened.tab.id, { kind: 'resize', width: 390, height: 844 });
  await manager.run('font', opened.tab.id, { scroll: 'down', pages: 2 });
  await page.waitForFunction(() => scrollY > 1000);
  const scrolled = await manager.run('font', opened.tab.id, { kind: 'screenshot' });
  const pixels = await page.evaluate(async source => {
    const bitmap = await createImageBitmap(await (await fetch(source)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, pixel: [...context.getImageData(10, 600, 1, 1).data] };
  }, scrolled.image);
  assert.deepEqual([pixels.width, pixels.height], [390, 844]);
  assert.ok(pixels.pixel[2] > 200 && pixels.pixel[0] < 50, 'the image shows the blue part after scrolling');
});

test('browser routes keep CLI commands and reject removed panel controls', async () => {
  const calls = [];
  const manager = Object.fromEntries(['open', 'list', 'run', 'close'].map(name => [name, (...args) => { calls.push([name, ...args]); return { ok: true }; }]));
  const routes = createBrowserRoutes({ manager });
  await routes.dispatch('browser.open', { id: 'one', url: 'about:blank' });
  await routes.dispatch('browser.list', { id: 'one' });
  await routes.dispatch('browser.action', { id: 'one', tabId: 'tab', action: { kind: 'look' } });
  await routes.dispatch('browser.close', { id: 'one', tabId: 'tab' });
  assert.deepEqual(calls, [
    ['open', 'one', { id: 'one', url: 'about:blank' }], ['list', 'one'],
    ['run', 'one', 'tab', { kind: 'look' }], ['close', 'one', 'tab'],
  ]);
  for (const method of ['browser.show', 'browser.download', 'browser.apps']) await assert.rejects(routes.dispatch(method, { id: 'one' }), /unknown browser method/);
});
