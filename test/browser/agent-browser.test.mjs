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

test('browser viewer on phone and desktop: takeover, typing, upload and releasing stream', { timeout: 60000 }, async t => {
  const sessions = { get: id => ({ id }) }, manager = new BrowserManager({ session: sessions.get });
  const routes = createBrowserRoutes({ sessions, manager }); let frontend;
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Project preview</title><style>body{font:18px system-ui;padding:30px;background:#f5f7fb}input,button{font:inherit;padding:12px;border:1px solid #ccc;border-radius:8px}h1{color:#32335a}.cards{display:flex;gap:18px;margin:20px 0}.cards div{padding:20px;background:white;border-radius:12px;box-shadow:0 3px 12px #e0e3ed}output{display:block;margin-top:20px}</style><h1>Project preview</h1><p>Your agent and you use the same browser.</p><div class=cards><div>Isolated tabs</div><div>Live control</div><div>Fast text views</div></div><label>Name <input id=name aria-label=Name></label><button onclick="document.querySelector(\'output\').textContent=document.getElementById(\'name\').value">Save</button><output></output><p><input type=file id=upload aria-label=Upload></p>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await frontend?.close(); await routes.stop(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const opened = await manager.open('viewer', { url: `http://127.0.0.1:${server.address().port}` });
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import BrowserPanel from './apps/web/src/session/BrowserPanel'; const root=createRoot(document.getElementById('root')); window.unmount=()=>root.unmount(); window.mount=()=>root.render(<BrowserPanel client={{rpc:(env,method,params)=>window.request(method,params)}} env={{id:'vm',name:'VM',online:true}} session={{id:'viewer',title:'Browser verification'}}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
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
    await page.setContent('<html data-theme="dark"><body><div class="thread-details" style="position:static;margin:16px auto;max-width:calc(100vw - 20px)"><div id="root"></div></div></body></html>');
    await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle.outputFiles[0].text }); await page.evaluate(() => window.mount());
    await page.getByAltText('Live browser page').waitFor();
    await page.getByRole('button', { name: 'Take control' }).click(); await page.getByRole('button', { name: 'Release control' }).waitFor();
    await page.getByRole('button', { name: 'Read page & controls' }).click(); await page.locator('.browser-text').filter({ hasText: 'Name' }).waitFor();
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
    if (width === 390) { await page.getByText('Low data preview for this connection.').waitFor(); assert.ok(frames.some(f => f.preview === 'low')); }
    const owner = manager.tabs.get(opened.tab.id).control, viewport = manager.tabs.get(opened.tab.id).page.viewportSize();
    await page.getByLabel('Browser preview quality').selectOption('text');
    await page.getByText('Live images are off.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Read page & controls' }).click();
    await page.locator('.browser-text').filter({ hasText: 'Name' }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Browser preview quality"]').value === 'text');
    const until = Date.now() + 10000; while (!frames.some(f => f.preview === 'text') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(frames.some(f => f.preview === 'text' && !f.image));
    assert.equal(manager.tabs.get(opened.tab.id).control, owner, 'quality changes preserve human control');
    assert.deepEqual(manager.tabs.get(opened.tab.id).page.viewportSize(), viewport, 'preview quality never changes page geometry');
    await page.getByLabel('Browser preview quality').selectOption('full'); await page.getByAltText('Live browser page').waitFor();
    if (process.env.HELM_TEST_SCREENSHOT_DIR) { await mkdir(process.env.HELM_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, `browser-${width}.png`), fullPage: true }); }
    await page.getByRole('button', { name: 'Release control' }).click(); await page.getByRole('button', { name: 'Take control' }).waitFor();
    await page.evaluate(() => window.unmount()); await page.close(); assert.deepEqual(errors, []);
  }
});
