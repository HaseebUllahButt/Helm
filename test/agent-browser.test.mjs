import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-agent-browser-'));
process.env.HELM_NO_SERVICE = '1';
// No real windows on the screen of the machine running the tests.
delete process.env.WAYLAND_DISPLAY; delete process.env.DISPLAY;
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(process.env.HELM_DIR, file);
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { systemChromium } = await import('../packages/connect/src/browser-window.js');

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

const fakePage = () => {
  const cdp = new EventEmitter(); cdp.detach = async () => {}; cdp.send = async () => {};
  const page = { u: 'http://x/1', url() { return this.u; }, viewportSize: () => ({ width: 1280, height: 800 }), title: async () => 'Title', mouse: { click: async () => {}, move: async () => {} }, goto: async function (u) { this.u = u; }, evaluate: async function () { return { title: 'Title', url: this.u, text: '', elements: [] }; }, context: () => ({ newCDPSession: async () => cdp }) };
  page.mainFrame = () => ({ evaluate: (...args) => page.evaluate(...args), childFrames: () => [] });
  return { cdp, page };
};
const fakeTab = (page, extra = {}) => ({ id: 'tab', sessionId: 'one', engine: 'chromium', page, downloads: [], lastUsed: Date.now(), console: [], network: [], ...extra });
// Wait for a state, checking now and then, never for a fixed time.
const until = async check => { while (!check()) await new Promise(resolve => setTimeout(resolve, 20)); };
// Every close check the pages started, to wait for them all.
const watchCloses = manager => { const all = [], real = manager.pageClosed.bind(manager); manager.pageClosed = (...args) => { const done = real(...args); all.push(done); return done; }; return () => Promise.all(all); };

test('tab list writes are coalesced after busy bursts but never lost on navigation, close or stop', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-persist-')), file = join(directory, 'one', 'tabs.json'), { page } = fakePage(); let closed = 0;
  const context = { storageState: async () => ({ cookies: [], origins: [] }), close: async () => { closed++; } };
  const manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); let writes = 0, wrote = () => {}; const write = manager.persistTabs.bind(manager);
  manager.persistTabs = async sid => { writes++; await write(sid); wrote(); };
  page.close = async () => { manager.tabs.delete('tab'); };
  manager.recovered.set('one', Promise.resolve()); manager.contexts.set('one', Promise.resolve(context));
  const tab = fakeTab(page); manager.tabs.set('tab', tab);
  for (let i = 0; i < 8; i++) await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 });
  assert.equal(writes, 0, 'a burst of clicks writes nothing yet'); assert.equal(existsSync(file), false);
  await new Promise(resolve => { wrote = resolve; }); assert.equal(writes, 1, 'one write for the whole burst'); assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].url, 'http://x/1');
  await manager.run('one', 'tab', { kind: 'navigate', url: 'http://x/2' }); assert.equal(writes, 2, 'navigation writes at once'); assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].url, 'http://x/2');
  await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 }); page.u = 'http://x/3'; assert.equal(writes, 2); assert.equal(manager.persistTimers.size, 1);
  await manager.stop(); assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].url, 'http://x/3', 'stop writes what the timer was still holding'); assert.equal(manager.persistTimers.size, 0);
  // Closing the last tab writes the empty list at once and cancels any held write.
  manager.stopping = false; manager.tabs.set('tab', tab); manager.contexts.set('one', Promise.resolve(context)); manager.recovered.set('one', Promise.resolve());
  await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 }); assert.equal(manager.persistTimers.size, 1);
  await manager.close('one', 'tab'); assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []); assert.equal(manager.persistTimers.size, 0); assert.equal(closed, 1);
  rmSync(directory, { recursive: true, force: true });
});

test('a crashed browser does not let a held write erase the saved tab list', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-persist-')), file = join(directory, 'one', 'tabs.json'), { page } = fakePage();
  const manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); manager.recovered.set('one', Promise.resolve());
  const tab = fakeTab(page); manager.tabs.set('tab', tab);
  await manager.persistTabs('one'); await manager.run('one', 'tab', { kind: 'click', x: 1, y: 1 });
  manager.tabs.delete('tab'); // what the disconnect handler does
  await until(() => manager.persistTimers.size === 0); assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1, 'the earlier list survives for recovery');
  rmSync(directory, { recursive: true, force: true });
});

test('Chromium dying before Helm keeps the tab list, and a page closing on its own still updates it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helm-persist-')), file = join(directory, 'one', 'tabs.json');
  const page = () => Object.assign(new EventEmitter(), { url: () => 'http://x/1', viewportSize: () => ({ width: 800, height: 600 }) });
  const saved = () => JSON.parse(readFileSync(file, 'utf8')).length;
  // A restart: Chromium's pages close while the browser still looks connected, then Helm stops.
  let manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); manager.closeGraceMs = 30; manager.recovered.set('one', Promise.resolve()); let closes = watchCloses(manager);
  let connected = true; manager.browser = { isConnected: () => connected, on() {}, close: async () => {} };
  const a = page(), b = page(); manager.register('one', a); manager.register('one', b); await manager.persistTabs('one'); assert.equal(saved(), 2);
  a.emit('close'); b.emit('close'); await manager.stop();
  assert.equal(saved(), 2, 'stopping after the pages closed forgets nothing');
  await closes(); assert.equal(saved(), 2, 'nor does the close check that was still waiting');
  // A crash: the pages close and the browser is gone.
  manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); manager.closeGraceMs = 30; manager.recovered.set('one', Promise.resolve()); closes = watchCloses(manager);
  manager.browser = { isConnected: () => false, on() {} };
  const c = page(); manager.register('one', c); await manager.persistTabs('one'); c.emit('close'); await closes();
  assert.equal(saved(), 1);
  // window.close(): the browser is alive without the page.
  manager = new BrowserManager({ directory, session: sid => ({ id: sid }) }); manager.closeGraceMs = 30; manager.recovered.set('one', Promise.resolve()); closes = watchCloses(manager);
  manager.browser = { isConnected: () => true, on() {} };
  const d = page(), e = page(); manager.register('one', d); manager.register('one', e); await manager.persistTabs('one');
  d.emit('close'); await closes();
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
  await assert.rejects(manager.run('one', first.tab.id, { kind: 'upload', ref: 299, uploads: [{ name: 'stale.txt', data: 'c3RhbGU=' }] }), /element 299 is not on the page now; look at the page again/);
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

test('a check waits for a late change, and ignored input fails once', { timeout: 60000 }, async t => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Late</title><output></output><label>Name<input id=name></label><label><input type=checkbox id=agree>Agree</label>'
      + '<button onclick="setTimeout(() => { document.querySelector(\'output\').textContent = \'Saved\'; document.getElementById(\'name\').value = \'Ada\'; document.getElementById(\'agree\').checked = true; location.hash = \'done\'; }, 700)">Save</button>'
      + '<button onclick="window.presses = (window.presses || 0) + 1">Ignore</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = new BrowserManager({ directory: mkdtempSync(join(process.env.HELM_DIR, 'checks-')), session: sid => ({ id: sid }), canWindow: false });
  t.after(async () => { await manager.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  try { await manager.start(); } catch { t.skip('no Chromium here'); return; }
  const { tab } = await manager.open('one', { url: `http://127.0.0.1:${server.address().port}/` });
  const saved = await manager.run('one', tab.id, { actions: [{ click: 'the Save button' }, { check: 'Saved' }, { check: { target: 'Name', value: 'Ada' } }, { check: { target: 'Agree', checked: true } }, { check: { url: '#done' } }, { check: 'Save button', expect: true }] });
  assert.equal(saved.failedAt, undefined, saved.error); assert.ok(saved.results.slice(1).every(step => step.pass));
  const ignored = await manager.run('one', tab.id, { actions: [{ click: 'the Ignore button' }, { check: 'Sent' }] });
  assert.equal(ignored.failedAt, 1); assert.equal(ignored.check.pass, false); assert.match(ignored.error, /"Sent" did not come in 2000 ms/);
  assert.equal((await manager.run('one', tab.id, { evaluate: 'window.presses' })).value, 1, 'the click was delivered once');
});

test('a read covers cross-origin frames, says when it cut the list, and an old number never picks another control', { timeout: 60000 }, async t => {
  const inner = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<button onclick="document.body.insertAdjacentText(\'beforeend\', \'Clicked inside\')">Inner save</button>'); });
  await new Promise(resolve => inner.listen(0, '127.0.0.1', resolve));
  const frameUrl = `http://localhost:${inner.address().port}/inner`;
  const outer = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/many') return res.end(`<title>Many</title><div id=first>${Array.from({ length: 300 }, (_, i) => `<button>Item ${i}</button>`).join('')}</div><div id=rest>${Array.from({ length: 20 }, (_, i) => `<button onclick="document.title='Rest ${i}'">Rest ${i}</button>`).join('')}</div>`);
    res.end(`<title>Frames</title><output></output><ul id=list><li><button onclick="document.querySelector('output').textContent='Alpha'">Alpha</button></li><li><button onclick="document.querySelector('output').textContent='Beta'">Beta</button></li></ul><iframe src="${frameUrl}"></iframe>`);
  });
  await new Promise(resolve => outer.listen(0, '127.0.0.1', resolve));
  const manager = new BrowserManager({ directory: mkdtempSync(join(process.env.HELM_DIR, 'reads-')), session: sid => ({ id: sid }), canWindow: false });
  t.after(async () => { await manager.stop(); for (const server of [inner, outer]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  try { await manager.start(); } catch { t.skip('no Chromium here'); return; }
  const base = `http://127.0.0.1:${outer.address().port}`;
  const { tab } = await manager.open('one', { url: base });
  const page = manager.tabs.get(tab.id).page;
  await page.frameLocator('iframe').locator('button').waitFor();
  const first = await manager.run('one', tab.id, { kind: 'look' });
  assert.ok(page.frames().some(frame => frame.url() === frameUrl));
  assert.ok(first.text.includes(`Frame 1 ${frameUrl}:`), first.text);
  const save = first.elements.find(e => e.name === 'Inner save'); assert.ok(save, 'the cross-origin frame’s control is listed');
  const clicked = await manager.run('one', tab.id, { actions: [{ click: save.ref }, { check: 'Clicked inside' }] });
  assert.equal(clicked.failedAt, undefined, clicked.error);
  const scoped = await manager.run('one', tab.id, { kind: 'look', frame: 1 });
  assert.deepEqual(scoped.elements.map(e => e.name), ['Inner save']);
  // The list is reordered: each number still means its own control.
  const alpha = first.elements.find(e => e.name === 'Alpha').ref, beta = first.elements.find(e => e.name === 'Beta').ref;
  await page.evaluate(() => { const list = document.getElementById('list'); list.prepend(list.lastElementChild); });
  const second = await manager.run('one', tab.id, { kind: 'look' });
  assert.deepEqual(second.elements.slice(0, 2).map(e => [e.name, e.ref]), [['Beta', beta], ['Alpha', alpha]]);
  await manager.run('one', tab.id, { click: alpha });
  assert.equal(await page.evaluate(() => document.querySelector('output').textContent), 'Alpha');
  // A new control in the same place gets a new number; the old one is refused.
  await page.evaluate(() => { document.getElementById('list').innerHTML = '<li><button>Gamma</button></li>'; });
  await manager.run('one', tab.id, { kind: 'look' });
  await assert.rejects(manager.run('one', tab.id, { click: alpha }), new RegExp(`element ${alpha} is not on the page now; look at the page again`));
  assert.equal(await page.evaluate(() => document.querySelector('output').textContent), 'Alpha');
  // More than 300 controls: the reply says so, and a scoped read gets the rest.
  const many = await manager.run('one', tab.id, { goto: `${base}/many` });
  assert.deepEqual(many.cut, { shown: 300, total: 320 });
  assert.match(many.text, /Showing 300 of 320 controls\. Read the rest with a look that has "within"/);
  const rest = await manager.run('one', tab.id, { kind: 'look', within: '#rest' });
  assert.equal(rest.elements.length, 20); assert.equal(rest.cut, undefined);
  await manager.run('one', tab.id, { click: rest.elements[19].ref });
  assert.equal(await page.title(), 'Rest 19');
  await assert.rejects(manager.run('one', tab.id, { kind: 'look', within: '[' }), /within: "\[" is not a CSS selector/);
});

async function busyFrames(t, { nested = true } = {}) {
  const inner = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/c' ? '<button>C button</button>' : `<p>Inside A</p><button>A button</button>${nested ? '<iframe src="/c"></iframe>' : ''}`); });
  await new Promise(resolve => inner.listen(0, '127.0.0.1', resolve));
  const outer = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/b' ? '<button>B button</button>' : `<title>Busy</title><button>Main button</button><iframe id=a src="http://localhost:${inner.address().port}/a"></iframe><iframe id=b src="/b"></iframe>`); });
  await new Promise(resolve => outer.listen(0, '127.0.0.1', resolve));
  const manager = new BrowserManager({ directory: mkdtempSync(join(process.env.HELM_DIR, 'busy-')), session: sid => ({ id: sid }), canWindow: false });
  t.after(async () => { await manager.stop(); for (const server of [inner, outer]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  try { await manager.start(); } catch { t.skip('no Chromium here'); return null; }
  const { tab } = await manager.open('one', { url: `http://127.0.0.1:${outer.address().port}/` });
  const page = manager.tabs.get(tab.id).page;
  await (nested ? page.frameLocator('#a').frameLocator('iframe') : page.frameLocator('#a')).locator('button').waitFor(); await page.frameLocator('#b').locator('button').waitFor();
  const frameA = page.frames().find(frame => frame.url().endsWith('/a'));
  // Frame A runs a long script: nothing in it, or under it, can answer.
  const busy = ms => { const done = frameA.evaluate(ms => { const end = Date.now() + ms; while (Date.now() < end); }, ms).catch(() => {}); return () => done; };
  const frameB = page.frames().find(frame => frame.url().endsWith('/b'));
  return { manager, id: tab.id, busy, frameA, frameB };
}

test('a busy frame does not hold up a read: the main page and other frames still appear', { timeout: 60000 }, async t => {
  const fixture = await busyFrames(t); if (!fixture) return;
  const { manager, id, busy } = fixture, ended = busy(8000), started = Date.now();
  const view = await manager.run('one', id, { kind: 'look' });
  assert.ok(Date.now() - started < 6000, `the read took ${Date.now() - started} ms`);
  assert.deepEqual(view.elements.map(e => e.name).sort(), ['B button', 'Main button']);
  assert.equal(view.quiet.length, 2, 'frame A and the frame inside it are named'); assert.match(view.text, /did not answer and is not listed/);
  await ended();
});

test('a frame that answers late never gives its controls the numbers of another frame', { timeout: 60000 }, async t => {
  const fixture = await busyFrames(t, { nested: false }); if (!fixture) return;
  const { manager, id, busy, frameA, frameB } = fixture;
  // New controls in both frames: frame A numbers its own while the read has stopped waiting for it.
  for (const frame of [frameA, frameB]) await frame.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<button>New button</button>'));
  const ended = busy(3000);
  const first = await manager.run('one', id, { kind: 'look' }), b = first.elements.find(e => e.name === 'B button').ref;
  await ended();
  const second = await manager.run('one', id, { kind: 'look' }), refs = second.elements.map(e => e.ref);
  assert.deepEqual(second.elements.map(e => e.name).sort(), ['A button', 'B button', 'Main button', 'New button', 'New button']);
  assert.equal(new Set(refs).size, refs.length, `numbers repeat: ${second.text}`);
  assert.equal(second.elements.find(e => e.name === 'B button').ref, b);
});

test('text in a frame that did not answer is not taken as gone', { timeout: 60000 }, async t => {
  const fixture = await busyFrames(t); if (!fixture) return;
  const { manager, id, busy } = fixture, ended = busy(5000);
  const result = await manager.run('one', id, { check: 'Inside A', expect: false });
  assert.equal(result.check.pass, false); assert.equal(result.check.found, null);
  assert.match(result.error, /could not be checked: part of the page did not answer/);
  await ended();
});
