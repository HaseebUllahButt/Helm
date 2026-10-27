import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const directory = await mkdtemp(join(tmpdir(), 'helm-browser-pointer-'));
process.env.HELM_DIR = directory; process.env.HELM_NO_SERVICE = '1';
// No real windows on the screen of the machine running the tests.
delete process.env.WAYLAND_DISPLAY; delete process.env.DISPLAY;
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(directory, file);
const { BrowserManager } = await import('../../packages/connect/src/browser.js');
test.after(() => rm(directory, { recursive: true, force: true }));

test('in the window an agent click shows its cursor on the element centre, and point only highlights', { timeout: 60000 }, async t => {
  const pinned = process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {};
  const manager = new BrowserManager({ session: id => ({ id }), canWindow: true, launchWindow: dir => chromium.launchPersistentContext(dir, { headless: true, ...pinned }) });
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Pointer</title><body style="margin:0;height:2400px"><button id=sign style="position:absolute;left:300px;top:120px;width:160px;height:40px" onclick="this.textContent=\'Done\'">Sign in</button><button id=far style="position:absolute;left:20px;top:1500px">Far away</button><input id=secret type=password value="hunter2-secret" style="position:absolute;left:300px;top:300px">'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await manager.stop(); await new Promise(resolve => server.close(resolve)); });
  const { tab: opened } = await manager.open('pointer', { url: `http://127.0.0.1:${server.address().port}` });
  await manager.run('pointer', opened.id, { kind: 'click', selector: '#sign' }); const tab = manager.tabs.get(opened.id);
  assert.deepEqual({ x: tab.pointer.x, y: tab.pointer.y, by: tab.pointer.by, label: tab.pointer.label }, { x: 380, y: 140, by: 'agent', label: 'Clicking “Sign in”' });
  assert.deepEqual(tab.pointer.box, { x: 300, y: 120, width: 160, height: 40 });
  const page = manager.tabs.get(opened.id).page; assert.equal(await page.textContent('#sign'), 'Done');
  assert.equal(await page.evaluate(() => document.getElementById('__helm_pointer').shadowRoot.textContent.includes('Clicking “Sign in”')), true, 'the cursor is drawn on the page');
  const look = await manager.run('pointer', opened.id, { kind: 'look' }), ref = look.elements.find(e => e.name === 'Done').ref;
  await manager.run('pointer', opened.id, { kind: 'point', ref, note: 'Click here to approve' }); const guided = manager.tabs.get(opened.id);
  assert.equal(guided.pointer.by, 'guide'); assert.equal(guided.pointer.note, 'Click here to approve'); assert.deepEqual([guided.pointer.x, guided.pointer.y], [380, 140]);
  assert.equal(await page.textContent('#sign'), 'Done', 'point does not click');
  await assert.rejects(manager.run('pointer', opened.id, { kind: 'point', selector: '#far' }), /not on screen/);
  assert.equal(await page.evaluate(() => scrollY), 0, 'point does not scroll');
  // A filled password field never lends its value to the pointer, the reply or the saved tabs.
  const hovered = await manager.run('pointer', opened.id, { kind: 'hover', selector: '#secret' }); assert.equal(manager.tabs.get(opened.id).pointer.label, 'Pointing at');
  const pointed = await manager.run('pointer', opened.id, { kind: 'point', selector: '#secret', note: 'Your password' });
  assert.doesNotMatch(JSON.stringify([hovered, pointed, manager.tabs.get(opened.id).pointer]), /hunter2/);
  assert.doesNotMatch(await page.evaluate(() => document.getElementById('__helm_pointer').shadowRoot.textContent), /hunter2/);
  await manager.persistTabs('pointer'); assert.doesNotMatch(await readFile(join(manager.directory, 'pointer', 'tabs.json'), 'utf8'), /hunter2/);
  await manager.run('pointer', opened.id, { kind: 'click', selector: '#far' });
  const far = manager.tabs.get(opened.id).pointer, box = await page.locator('#far').boundingBox();
  assert.equal(far.label, 'Clicking “Far away”'); assert.ok(Math.abs(far.y - (box.y + box.height / 2)) <= 1, 'the pointer lands where the element is after scrolling to it');
});

test('fast pointer placement keeps clipped controls and frame targets correct', { timeout: 30000 }, async t => {
  const pinned = process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {};
  const manager = new BrowserManager({ session: id => ({ id }), canWindow: true,
    launchWindow: dir => chromium.launchPersistentContext(dir, { headless: true, ...pinned }) });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/frame'
      ? '<button style="margin:20px" onclick="this.textContent=\'Frame saved\'">Frame save</button>'
      : '<title>Geometry</title><div id=clip style="position:absolute;left:30px;top:100px;width:200px;height:80px;overflow:auto"><div style="height:220px"></div><button id=inside onclick="window.saved=true">Save inside</button></div><iframe src=/frame style="position:absolute;left:350px;top:100px;width:300px;height:150px"></iframe>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await manager.stop(); await new Promise(resolve => server.close(resolve)); });
  const { tab: opened } = await manager.open('geometry', { url: `http://127.0.0.1:${server.address().port}` });
  const tab = manager.get('geometry', opened.id), page = tab.page;
  let reads = 0;
  const look = manager.look.bind(manager);
  manager.look = async (...args) => { reads++; return look(...args); };
  const saved = await manager.run('geometry', opened.id, { click: 'the Save inside button' });
  assert.equal(reads, 2, 'one read finds the target; one returns the result');
  assert.equal(await page.evaluate(() => window.saved), true);
  assert.ok(await page.locator('#clip').evaluate(el => el.scrollTop > 0));
  let box = await page.locator('#inside').boundingBox();
  assert.ok(Math.abs(tab.pointer.y - (box.y + box.height / 2)) <= 1, 'the arrow follows scrolling inside a container');
  const ref = saved.elements.find(element => element.name === 'Frame save').ref;
  await manager.run('geometry', opened.id, { kind: 'point', ref });
  const framed = page.frames().find(frame => frame.url().endsWith('/frame'));
  box = await framed.getByRole('button').boundingBox();
  assert.deepEqual([tab.pointer.x, tab.pointer.y], [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]);
  await manager.run('geometry', opened.id, { kind: 'click', ref });
  assert.equal(await framed.getByRole('button').textContent(), 'Frame saved');
});
