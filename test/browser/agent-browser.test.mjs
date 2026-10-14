import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const directory = await mkdtemp(join(tmpdir(), 'helm-browser-viewer-'));
process.env.HELM_DIR = directory; process.env.HELM_NO_SERVICE = '1';
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(directory, file);
const { BrowserManager } = await import('../../packages/connect/src/browser.js');
const { createBrowserRoutes } = await import('../../packages/connect/src/browser-routes.js');

test('browser viewer on phone and desktop: click to take over, typing, upload and handing back', { timeout: 60000 }, async t => {
  const sessions = { get: id => ({ id }) }, manager = new BrowserManager({ session: sessions.get });
  const routes = createBrowserRoutes({ sessions, manager }); let frontend;
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Project preview</title><style>body{font:18px system-ui;padding:30px;background:#f5f7fb}input,button{font:inherit;padding:12px;border:1px solid #ccc;border-radius:8px}h1{color:#32335a}.cards{display:flex;gap:18px;margin:20px 0}.cards div{padding:20px;background:white;border-radius:12px;box-shadow:0 3px 12px #e0e3ed}output{display:block;margin-top:20px}</style><h1>Project preview</h1><p>Your agent and you use the same browser.</p><div class=cards><div>Isolated tabs</div><div>Live control</div><div>Fast text views</div></div><label>Name <input id=name aria-label=Name></label><button onclick="document.querySelector(\'output\').textContent=document.getElementById(\'name\').value">Save</button><output></output><p><input type=file id=upload aria-label=Upload></p>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await frontend?.close(); await routes.stop(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const opened = await manager.open('viewer', { url: `http://127.0.0.1:${server.address().port}` });
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import BrowserPanel from './apps/web/src/session/BrowserPanel'; const root=createRoot(document.getElementById('root')); window.unmount=()=>root.unmount(); window.mount=()=>root.render(<BrowserPanel client={{rpc:(env,method,params)=>window.request(method,params),on:()=>()=>{}}} env={{id:'vm',name:'VM',online:true}} session={{id:'viewer',title:'Browser verification'}}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  frontend = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  const css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') + '\n' + await readFile('apps/web/src/session/browser.css', 'utf8');
  for (const width of [1280, 390]) {
    const page = await frontend.newPage({ viewport: { width, height: 1000 } });
    page.on('pageerror', error => t.diagnostic(error.message));
    const frames = []; const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('request', async (method, params) => {
      if (method === 'browser.frame' && width === 390) await new Promise(resolve => setTimeout(resolve, 1100));
      const result = await routes.dispatch(method, params);
      if (method === 'browser.frame') frames.push({ preview: params.preview, image: !!result.image });
      return result;
    });
    await page.setContent('<html data-theme="dark"><body><div class="browser-dock" style="height:900px;max-width:calc(100vw - 20px);margin:16px auto"><div id="root" style="display:contents"></div></div></body></html>');
    await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle.outputFiles[0].text }); await page.evaluate(() => window.mount());
    await page.getByAltText('Live browser page').waitFor();
    // The page fits the live area below the nav bar, without taking control.
    const live = await page.evaluate(() => { const panel = document.querySelector('.browser-panel'), nav = document.querySelector('.bp-nav'); return { width: panel.clientWidth, height: Math.round(panel.getBoundingClientRect().bottom - nav.getBoundingClientRect().bottom) }; });
    const want = { width: Math.max(240, live.width), height: Math.min(1200, Math.max(200, live.height)) }, close = () => { const v = manager.tabs.get(opened.tab.id).page.viewportSize(); return Math.abs(v.width - want.width) < 24 && Math.abs(v.height - want.height) < 24; };
    const fitBy = Date.now() + 10000; while (!close() && Date.now() < fitBy) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(close(), `page ${JSON.stringify(manager.tabs.get(opened.tab.id).page.viewportSize())} fits ${JSON.stringify(want)}`); assert.equal(manager.tabs.get(opened.tab.id).control, null);
    await page.getByAltText('Live browser page').click(); await page.getByRole('button', { name: 'Hand back' }).waitFor();
    await page.getByRole('button', { name: 'More browser tools' }).click();
    await page.getByRole('button', { name: 'Read page' }).click(); await page.locator('.browser-text').filter({ hasText: 'Name' }).waitFor();
    const nameRef = (await manager.run('viewer', opened.tab.id, { kind: 'look' })).elements.find(e => e.name === 'Name').ref;
    await page.getByLabel('Element number', { exact: true }).fill(String(nameRef));
    await page.getByLabel('Text to type into browser').fill('Ada'); await page.getByRole('button', { name: 'Type', exact: true }).click();
    await manager.tabs.get(opened.tab.id).page.waitForFunction(() => document.getElementById('name').value === 'Ada');
    const uploadRef = (await manager.run('viewer', opened.tab.id, { kind: 'look' })).elements.find(e => e.name === 'Upload').ref;
    await page.getByLabel('Element number', { exact: true }).fill(String(uploadRef));
    await page.locator('input[type=file]').setInputFiles({ name: 'attachment.txt', mimeType: 'text/plain', buffer: Buffer.from('Uploaded through Helm') });
    await manager.tabs.get(opened.tab.id).page.waitForFunction(() => document.getElementById('upload').files.length === 1);
    assert.equal(await manager.tabs.get(opened.tab.id).page.locator('#upload').evaluate(el => el.files.length), 1);
    assert.equal(await manager.tabs.get(opened.tab.id).page.locator('#upload').evaluate(el => el.files[0].name), 'attachment.txt');
    if (width === 390) { await page.getByText('Low data for this connection.').waitFor(); assert.ok(frames.some(f => f.preview === 'low')); }
    const owner = manager.tabs.get(opened.tab.id).control, viewport = manager.tabs.get(opened.tab.id).page.viewportSize();
    await page.getByLabel('Browser preview quality').selectOption('text');
    await page.getByText('Live picture is off.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Read page' }).click();
    await page.locator('.browser-text').filter({ hasText: 'Name' }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Browser preview quality"]').value === 'text');
    const until = Date.now() + 10000; while (!frames.some(f => f.preview === 'text') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(frames.some(f => f.preview === 'text' && !f.image));
    assert.equal(manager.tabs.get(opened.tab.id).control, owner, 'quality changes preserve human control');
    assert.deepEqual(manager.tabs.get(opened.tab.id).page.viewportSize(), viewport, 'preview quality never changes page geometry');
    await page.getByLabel('Browser preview quality').selectOption('full'); await page.getByAltText('Live browser page').waitFor();
    if (process.env.HELM_TEST_SCREENSHOT_DIR) { await mkdir(process.env.HELM_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, `browser-${width}.png`), fullPage: true }); }
    // Keyboard users hand back with Enter on the pill's button; the page must not take that key.
    await page.getByRole('button', { name: 'Hand back' }).focus(); await page.keyboard.press('Enter'); await page.getByRole('button', { name: 'Hand back' }).waitFor({ state: 'detached' });
    assert.equal(manager.tabs.get(opened.tab.id).control, null);
    await page.evaluate(() => window.unmount()); await page.close(); assert.deepEqual(errors, []);
  }
});

test('an agent click puts the pointer on the element centre, and point only highlights', { timeout: 60000 }, async t => {
  const manager = new BrowserManager({ session: id => ({ id }) });
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Pointer</title><body style="margin:0;height:2400px"><button id=sign style="position:absolute;left:300px;top:120px;width:160px;height:40px" onclick="this.textContent=\'Done\'">Sign in</button><button id=far style="position:absolute;left:20px;top:1500px">Far away</button><input id=secret type=password value="hunter2-secret" style="position:absolute;left:300px;top:300px">'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await manager.stop(); await new Promise(resolve => server.close(resolve)); });
  const { tab: opened } = await manager.open('pointer', { url: `http://127.0.0.1:${server.address().port}` });
  await manager.frame('pointer', opened.id, { viewer: 'owner' });
  const started = Date.now(), { tab } = await manager.run('pointer', opened.id, { kind: 'click', selector: '#sign' });
  assert.ok(Date.now() - started >= 110, 'a watching viewer gets a moment to follow');
  assert.deepEqual({ x: tab.pointer.x, y: tab.pointer.y, by: tab.pointer.by, label: tab.pointer.label }, { x: 380, y: 140, by: 'agent', label: 'Clicking “Sign in”' });
  assert.deepEqual(tab.pointer.box, { x: 300, y: 120, width: 160, height: 40 });
  const page = manager.tabs.get(opened.id).page; assert.equal(await page.textContent('#sign'), 'Done');
  const look = await manager.run('pointer', opened.id, { kind: 'look' }), ref = look.elements.find(e => e.name === 'Done').ref;
  const guided = await manager.run('pointer', opened.id, { kind: 'point', ref, note: 'Click here to approve' });
  assert.equal(guided.tab.pointer.by, 'guide'); assert.equal(guided.tab.pointer.note, 'Click here to approve'); assert.deepEqual([guided.tab.pointer.x, guided.tab.pointer.y], [380, 140]);
  assert.equal(await page.textContent('#sign'), 'Done', 'point does not click');
  await assert.rejects(manager.run('pointer', opened.id, { kind: 'point', selector: '#far' }), /not on screen/);
  assert.equal(await page.evaluate(() => scrollY), 0, 'point does not scroll');
  // A filled password field never lends its value to the pointer, the reply or the saved tabs.
  const hovered = await manager.run('pointer', opened.id, { kind: 'hover', selector: '#secret' });
  const pointed = await manager.run('pointer', opened.id, { kind: 'point', selector: '#secret', note: 'Your password' });
  assert.equal(hovered.tab.pointer.label, 'Pointing at'); assert.doesNotMatch(JSON.stringify([hovered, pointed]), /hunter2/);
  await manager.persistTabs('pointer'); assert.doesNotMatch(await readFile(join(manager.directory, 'pointer', 'tabs.json'), 'utf8'), /hunter2/);
  await manager.run('pointer', opened.id, { kind: 'click', selector: '#far' });
  const far = manager.tabs.get(opened.id).pointer, box = await page.locator('#far').boundingBox();
  assert.equal(far.label, 'Clicking “Far away”'); assert.ok(Math.abs(far.y - (box.y + box.height / 2)) <= 1, 'the pointer lands where the element is after scrolling to it');
});
