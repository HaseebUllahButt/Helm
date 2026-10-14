import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-browser-window-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { canOpenWindow, windowName } = await import('../packages/connect/src/browser-window.js');
const { chromium } = await import('playwright');
const pinned = process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {};

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

test('tabs open in the thread’s own window, already signed in; the agent works there and its cursor shows', { timeout: 60000 }, async t => {
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

test('the agent waits while the owner is using the window, then carries on', { timeout: 60000 }, async t => {
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

test('a closed window keeps its tabs asleep; listing does not reopen it, the agent’s next step does', { timeout: 60000 }, async t => {
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

test('Show window opens an empty thread with one blank tab; without a screen it says so plainly', { timeout: 60000 }, async t => {
  const { manager } = await setup(t);
  const shown = await manager.show('one');
  assert.equal(shown.open, true); assert.equal(shown.tabs.length, 1);
  assert.equal((await manager.show('one', shown.tabs[0].id)).tabs.length, 1, 'showing again opens nothing new');
  const { manager: headless } = await setup(t, { canWindow: false });
  await assert.rejects(headless.show('one'), /no screen/i);
  assert.equal((await headless.list('one')).canWindow, false);
});
