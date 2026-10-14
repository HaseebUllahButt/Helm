import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-browser-window-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { canOpenWindow } = await import('../packages/connect/src/browser-window.js');
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

test('tabs move into a window and back with their ids, pages and sign-ins', { timeout: 60000 }, async t => {
  const { manager, url, windows } = await setup(t);
  const a = await manager.open('one', { url }), b = await manager.open('one', { url: `${url}/#b` });
  await manager.run('one', a.tab.id, { kind: 'evaluate', script: 'document.cookie = "who=owner; max-age=3600"' });
  assert.equal((await manager.list('one')).window, false);

  const opened = await manager.window('one', { open: true, place: { x: 900, y: 0, width: 700, height: 900 } });
  assert.equal(opened.window, true);
  assert.deepEqual(windows.at(-1).place, { x: 900, y: 0, width: 700, height: 900 });
  assert.deepEqual(opened.tabs.map(tab => tab.id).sort(), [a.tab.id, b.tab.id].sort());
  assert.ok(opened.tabs.every(tab => tab.window));
  // No spare blank tab is left behind in the window.
  assert.equal(manager.contexts.size, 1);
  const context = await manager.contexts.get('one');
  await manager.run('one', a.tab.id, { kind: 'look' });
  assert.equal(context.pages().length, 2);
  assert.match((await manager.run('one', a.tab.id, { kind: 'evaluate', script: 'document.cookie' })).value, /who=owner/);
  // Nothing else is open, so the hidden browser has shut down.
  assert.equal(manager.browser, null);

  // The agent works in the window as it does in the panel.
  await manager.run('one', a.tab.id, { kind: 'batch', actions: [{ kind: 'type', selector: '#name', text: 'Helm' }, { kind: 'click', name: 'Save' }] });
  assert.equal((await manager.run('one', a.tab.id, { kind: 'evaluate', script: 'document.querySelector("output").textContent' })).value, 'Helm');
  // And its cursor is drawn on the page, where the owner is looking.
  assert.equal((await manager.run('one', a.tab.id, { kind: 'evaluate', script: '!!document.getElementById("__helm_pointer")' })).value, true);

  const back = await manager.window('one', { open: false });
  assert.equal(back.window, false);
  assert.deepEqual(back.tabs.map(tab => tab.id).sort(), [a.tab.id, b.tab.id].sort());
  assert.ok(back.tabs.every(tab => !tab.window));
  assert.match((await manager.run('one', a.tab.id, { kind: 'evaluate', script: 'document.cookie' })).value, /who=owner/);
});

test('the agent waits while the owner is using the window, then carries on', { timeout: 60000 }, async t => {
  const { manager, url } = await setup(t);
  const { tab } = await manager.open('one', { url });
  await manager.window('one', { open: true });
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

test('closing the window puts its tabs back in the panel; closing one tab closes just that tab', { timeout: 60000 }, async t => {
  const { manager, url } = await setup(t);
  const a = await manager.open('one', { url }), b = await manager.open('one', { url: `${url}/#b` });
  await manager.window('one', { open: true });
  await manager.tabs.get(b.tab.id).page.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual((await manager.list('one')).tabs.map(tab => tab.id), [a.tab.id]);
  // The owner closes the whole window.
  await (await manager.contexts.get('one')).close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const after = await manager.list('one');
  assert.equal(after.window, false);
  assert.deepEqual(after.tabs.map(tab => tab.id), [a.tab.id]);
  assert.equal((await manager.run('one', a.tab.id, { kind: 'evaluate', script: 'location.origin' })).value, url);
});

test('an empty thread gets one blank tab in its window, and no screen says so plainly', { timeout: 60000 }, async t => {
  const { manager } = await setup(t);
  const opened = await manager.window('one', { open: true });
  assert.equal(opened.tabs.length, 1);
  const { manager: headless } = await setup(t, { canWindow: false });
  await assert.rejects(headless.window('one', { open: true }), /no screen/i);
});
