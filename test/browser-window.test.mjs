import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from 'node:http';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-browser-window-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rm(process.env.HELM_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { createBrowserRoutes } = await import('../packages/connect/src/browser-routes.js');
const { canOpenWindow, windowName, windowProfile, windowOpen, launchWindow, stopWindow, profilePid } = await import('../packages/connect/src/browser-window.js');
const { chromium } = await import('playwright');
const realChromium = [process.env.HELM_TEST_CHROMIUM, '/usr/bin/chromium', '/usr/bin/google-chrome', chromium.executablePath()].find(path => path && existsSync(path));
// Playwright's own Chromium, else the system one Helm itself falls back to.
const starts = options => chromium.launch({ headless: true, ...options }).then(browser => browser.close().then(() => true), () => false);
const pinned = process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM }
  : await starts({}) ? {} : realChromium && await starts({ executablePath: realChromium }) ? { executablePath: realChromium } : null;
const noChromium = !pinned && 'no Chromium here: npx playwright install chromium';

// The real window is headed; the same persistent profile runs headless here.
const setup = async (t, extra = {}) => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Window test</title><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`, windows = [];
  const manager = new BrowserManager({
    directory: mkdtempSync(join(process.env.HELM_DIR, 'b-')), session: sid => ({ id: sid }),
    launch: () => chromium.launch({ headless: true, ...pinned }),
    launchWindow: async (dir, options) => { windows.push(options); return chromium.launchPersistentContext(dir, { headless: true, ...pinned }); },
    canWindow: true, ownerQuietMs: 400, ...extra,
  });
  manager.closeGraceMs = 50;
  t.after(async () => { await manager.stop(); await new Promise(resolve => server.close(resolve)); });
  return { manager, url, windows };
};

test('a screen is needed for a window: a display on Linux, always on a Mac or Windows', () => {
  assert.equal(canOpenWindow({}, 'linux'), false);
  assert.equal(canOpenWindow({ WAYLAND_DISPLAY: 'wayland-1' }, 'linux'), true);
  assert.equal(canOpenWindow({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(canOpenWindow({}, 'darwin'), true);
});

test('a lock left by a crash never closes another program that now has its process number', { skip: process.platform === 'win32' }, async t => {
  const profile = mkdtempSync(join(process.env.HELM_DIR, 'lock-'));
  const run = (...args) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...args], { stdio: 'ignore' });
    t.after(() => child.kill('SIGKILL'));
    return child;
  };
  const lock = (pid, host = hostname()) => { rmSync(join(profile, 'SingletonLock'), { force: true }); symlinkSync(`${host}-${pid}`, join(profile, 'SingletonLock')); };
  const other = run();
  lock(other.pid);
  assert.equal(profilePid(profile), null);
  assert.equal(await stopWindow(profile), false);
  assert.equal(other.exitCode, null); assert.equal(other.signalCode, null);
  // Another machine's lock in a synced folder is not this machine's process.
  const owner = run(`--user-data-dir=${profile}`);
  lock(owner.pid, 'elsewhere');
  assert.equal(profilePid(profile), null);
  // The browser that really runs this profile is still closed.
  lock(owner.pid);
  const exited = new Promise(done => owner.once('exit', done));
  assert.equal(profilePid(profile), owner.pid);
  assert.equal(await stopWindow(profile), true);
  await exited;
});

test('tabs open in the thread’s own window, already signed in; the agent works there and its cursor shows', { timeout: 60000, skip: noChromium }, async t => {
  const { manager, url, windows } = await setup(t);
  // What the thread signed in to before comes along into a fresh window.
  mkdirSync(join(manager.directory, 'one'), { recursive: true });
  writeFileSync(join(manager.directory, 'one', 'storage.json'), JSON.stringify({ cookies: [{ name: 'who', value: 'owner', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));
  const a = await manager.open('one', { url }), b = await manager.open('one', { url: `${url}/#b` });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].name, windowName('one'), 'the window is named so the desktop never gives it the keyboard');
  const listed = await manager.list('one');
  assert.equal(listed.open, true); assert.equal(listed.canWindow, true);
  assert.deepEqual(listed.tabs.map(tab => tab.id).sort(), [a.tab.id, b.tab.id].sort());
  assert.ok(listed.tabs.every(tab => tab.window));
  // The window's first blank tab is used, not left behind.
  assert.equal((await manager.contexts.get('one')).pages().length, 2);
  assert.match((await manager.run('one', a.tab.id, { kind: 'evaluate', script: 'document.cookie' })).value, /who=owner/);
  // No hidden browser runs beside the window.
  assert.equal(manager.browser, null);

  await manager.run('one', a.tab.id, { kind: 'batch', actions: [{ kind: 'type', selector: '#name', text: 'Helm' }, { kind: 'click', name: 'Save' }] });
  assert.equal((await manager.run('one', a.tab.id, { kind: 'evaluate', script: 'document.querySelector("output").textContent' })).value, 'Helm');
  assert.equal((await manager.run('one', a.tab.id, { kind: 'evaluate', script: '!!document.getElementById("__helm_pointer")' })).value, true);
});

test('the agent waits while the owner is using the window, then carries on', { timeout: 60000, skip: noChromium }, async t => {
  const { manager, url } = await setup(t);
  const { tab } = await manager.open('one', { url });
  const page = manager.tabs.get(tab.id).page;
  // The owner clicks in the window: the page tells Helm.
  await page.evaluate(() => window.__helmOwnerInput());
  const started = Date.now();
  await manager.run('one', tab.id, { kind: 'type', selector: '#name', text: 'after you' });
  assert.ok(Date.now() - started >= 250, 'the agent held back while the owner was active');
  assert.equal((await manager.run('one', tab.id, { kind: 'evaluate', script: 'document.querySelector("#name").value' })).value, 'after you');
  // The agent's own clicks are not mistaken for the owner's.
  await manager.run('one', tab.id, { kind: 'click', name: 'Save' });
  const quick = Date.now();
  await manager.run('one', tab.id, { kind: 'click', name: 'Save' });
  assert.ok(Date.now() - quick < 350);
});

test('a closed window keeps its tabs asleep; listing does not reopen it, the agent’s next step does', { timeout: 60000, skip: noChromium }, async t => {
  const { manager, url, windows } = await setup(t);
  const a = await manager.open('one', { url }), b = await manager.open('one', { url: `${url}/#b` }), c = await manager.open('one', { url: `${url}/#c` });
  // Closing one tab closes just that tab.
  await manager.tabs.get(c.tab.id).page.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual((await manager.list('one')).tabs.map(tab => tab.id).sort(), [a.tab.id, b.tab.id].sort());
  // The owner closes the whole window.
  await (await manager.contexts.get('one')).close();
  await new Promise(resolve => setTimeout(resolve, 150));
  const after = await manager.list('one');
  assert.equal(after.open, false); assert.equal(windows.length, 1, 'looking at the list does not open a window');
  assert.deepEqual(after.tabs.map(tab => [tab.id, tab.asleep]).sort(), [[a.tab.id, true], [b.tab.id, true]].sort());
  // A sleeping tab can be closed without waking the window.
  await manager.close('one', b.tab.id);
  assert.deepEqual((await manager.list('one')).tabs.map(tab => tab.id), [a.tab.id]); assert.equal(windows.length, 1);
  // The agent's next step opens the window again, on the same tab and page.
  assert.equal((await manager.run('one', a.tab.id, { kind: 'evaluate', script: 'location.origin' })).value, url);
  assert.equal(windows.length, 2); assert.equal((await manager.list('one')).open, true);
});

test('a new tab opens at its address, so it never sits on about:blank while the site answers', { timeout: 60000, skip: noChromium }, async t => {
  const slow = createServer((req, res) => setTimeout(() => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>Slow ${req.url}</title>slow`); }, 800));
  await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => slow.close(resolve)));
  const { manager } = await setup(t), url = `http://127.0.0.1:${slow.address().port}`;
  const targets = async () => { const context = await manager.contexts.get('one'), cdp = await context.newCDPSession(context.pages()[0]); try { return (await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page').map(info => info.url); } finally { await cdp.detach(); } };
  await manager.open('one', { url: `${url}/first` });
  const second = manager.open('one', { url: `${url}/second` }), third = manager.open('one', { url: `${url}/third` });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual((await targets()).sort(), [`${url}/first`, `${url}/second`, `${url}/third`], 'no empty tab, and none on about:blank');
  assert.match((await second).text, /^Slow \/second/); await third;
  // A hidden window's error page is empty, so the reason may be missing there.
  await assert.rejects(manager.open('one', { url: 'http://nothing.invalid/' }), /Can't find nothing\.invalid|Could not open nothing\.invalid/);
  assert.equal((await manager.list('one')).tabs.length, 3, 'a tab that could not open is closed');
});

test('a window nobody used for a while is put away; its tabs sleep and come back', { timeout: 60000, skip: noChromium }, async t => {
  const { manager, url, windows } = await setup(t, { windowIdleMs: 60000 });
  const a = await manager.open('one', { url });
  manager.watched = async () => false;
  await manager.sweep(); assert.equal(manager.windowContexts.size, 1, 'used a moment ago');
  manager.tabs.get(a.tab.id).lastUsed -= 61000; manager.watched = async () => true;
  await manager.sweep(); assert.equal(manager.windowContexts.size, 1, 'the owner is looking at it');
  manager.watched = async () => false;
  await manager.sweep(); assert.equal(manager.windowContexts.size, 0);
  assert.deepEqual((await manager.list('one')).tabs.map(tab => [tab.id, tab.asleep]), [[a.tab.id, true]]);
  assert.equal((await manager.run('one', a.tab.id, { kind: 'evaluate', script: 'location.origin' })).value, url);
  assert.equal(windows.length, 2);
});

test('a deleted chat takes its browser with it; tidying removes old folders and refetched files', { timeout: 60000, skip: noChromium }, async t => {
  const { manager, url } = await setup(t);
  await manager.open('gone', { url });
  const known = new Set(['gone']), forgotten = [];
  const routes = createBrowserRoutes({ sessions: { get: sid => { if (!known.has(sid)) throw new Error('unknown session'); return { id: sid }; } }, manager });
  manager.forget = (forget => async sid => { forgotten.push(sid); await forget.call(manager, sid); })(manager.forget);
  routes.sessionChanged({ id: 'gone', status: 'exited' });
  assert.deepEqual(forgotten, [], 'a chat that only stopped keeps its browser');
  known.delete('gone'); routes.sessionChanged({ id: 'gone', status: 'exited' });
  assert.deepEqual(forgotten, ['gone']);
  await new Promise(resolve => { const wait = () => existsSync(join(manager.directory, 'gone')) ? setTimeout(wait, 20) : resolve(); wait(); });
  assert.equal(existsSync(join(manager.directory, 'gone')), false); assert.equal(manager.tabs.size, 0); assert.equal(manager.contexts.size, 0);
  const { utimesSync } = await import('node:fs');
  for (const sid of ['old', 'recent', 'alive']) { mkdirSync(join(windowProfile(manager.directory, sid), 'component_crx_cache'), { recursive: true }); writeFileSync(join(manager.directory, sid, 'tabs.json'), '[]'); }
  const dayAgo = new Date(Date.now() - 25 * 3600000);
  for (const path of [join(manager.directory, 'old'), join(manager.directory, 'old', 'tabs.json')]) utimesSync(path, dayAgo, dayAgo);
  manager.session = sid => { if (sid !== 'alive') throw new Error('unknown session'); return { id: sid }; };
  await manager.tidy();
  assert.equal(existsSync(join(manager.directory, 'old')), false, 'a chat gone for a day');
  assert.equal(existsSync(join(manager.directory, 'recent', 'tabs.json')), true, 'maybe not loaded yet: kept');
  assert.equal(existsSync(join(manager.directory, 'alive', 'tabs.json')), true);
  assert.equal(existsSync(join(windowProfile(manager.directory, 'alive'), 'component_crx_cache')), false);
});

test('saving a window’s sign-ins never flashes a tab, even with frames from other sites', { timeout: 60000, skip: noChromium }, async t => {
  const { manager, url } = await setup(t);
  // The same server under another name is another site, framed in the page.
  const framed = url.replace('127.0.0.1', 'localhost');
  const opened = await manager.open('one', { url });
  await manager.run('one', opened.tab.id, { kind: 'evaluate', script: `new Promise(done => { const f = document.createElement('iframe'); f.src = ${JSON.stringify(framed)}; f.onload = done; document.body.append(f); })` });
  const context = await manager.contexts.get('one'), page = context.pages()[0];
  await page.frames().find(f => f.url().startsWith(framed)).evaluate(() => localStorage.setItem('k', 'v'));
  await page.evaluate(() => { document.cookie = 'who=owner'; });
  // Playwright hides the tab it opens to read storage; Chromium itself is asked.
  const cdp = await context.newCDPSession(page), flashed = [];
  cdp.on('Target.targetCreated', ({ targetInfo }) => { if (targetInfo.type === 'page') flashed.push(targetInfo.url); });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await new Promise(done => setTimeout(done, 200)); flashed.length = 0;
  await manager.save('one');
  await new Promise(done => setTimeout(done, 300));
  assert.deepEqual(flashed, []);
  assert.ok(JSON.parse(readFileSync(join(manager.directory, 'one', 'storage.json'), 'utf8')).cookies.some(c => c.name === 'who'));
});

test('a Helm restart leaves the window open; the next Helm takes its tabs back without reloading them', { timeout: 90000, skip: !realChromium && 'no Chromium installed' }, async t => {
  // The real way of starting a window, kept off the screen for the test.
  const wrapper = join(process.env.HELM_DIR, 'chromium-headless');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${realChromium} --headless=new --no-sandbox "$@"\n`, { mode: 0o755 });
  const before = process.env.HELM_WINDOW_CHROMIUM; process.env.HELM_WINDOW_CHROMIUM = wrapper;
  t.after(() => { if (before === undefined) delete process.env.HELM_WINDOW_CHROMIUM; else process.env.HELM_WINDOW_CHROMIUM = before; });
  const { manager, url } = await setup(t, { launchWindow });
  const folder = windowProfile(manager.directory, 'one');
  // This Chromium outlives the test process; a failed check must still close it.
  t.after(() => stopWindow(folder));
  const opened = await manager.open('one', { url });
  await manager.run('one', opened.tab.id, { kind: 'type', selector: '#name', text: 'kept' });
  const loadedAt = (await manager.run('one', opened.tab.id, { kind: 'evaluate', script: 'performance.timeOrigin' })).value;
  await manager.stop();
  assert.ok(windowOpen(folder), 'the window is still open after Helm stops');

  const next = new BrowserManager({ directory: manager.directory, session: sid => ({ id: sid }), canWindow: true, launchWindow });
  t.after(async () => {
    const context = await next.contexts.get('one');
    await context?.helmDetach?.(); await next.stop();
    await stopWindow(folder);
  });
  const listed = await next.list('one');
  assert.equal(listed.open, true, 'the open window is taken back, not listed asleep');
  assert.deepEqual(listed.tabs.map(tab => [tab.id, !!tab.asleep]), [[opened.tab.id, false]]);
  assert.equal((await next.run('one', opened.tab.id, { kind: 'evaluate', script: 'performance.timeOrigin' })).value, loadedAt, 'the page was not reloaded');
  assert.equal((await next.run('one', opened.tab.id, { kind: 'evaluate', script: 'document.querySelector("#name").value' })).value, 'kept');
  assert.equal((await next.contexts.get('one')).pages().length, 1, 'no extra tab was opened');
});
