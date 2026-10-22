import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const directory = await mkdtemp(join(tmpdir(), 'helm-browser-window-panel-'));
process.env.HELM_DIR = directory; process.env.HELM_NO_SERVICE = '1';
const { BrowserManager } = await import('../../packages/connect/src/browser.js');
const { createBrowserRoutes } = await import('../../packages/connect/src/browser-routes.js');
const pinned = process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {};

test('the panel is the window’s remote: it shows the window, drives it from the address bar and follows it', { timeout: 60000 }, async t => {
  const sessions = { get: id => ({ id }) }, windows = [];
  const manager = new BrowserManager({ session: sessions.get, launch: () => chromium.launch({ headless: true, ...pinned }), canWindow: true,
    launchWindow: async (dir, options) => { windows.push(options); return chromium.launchPersistentContext(dir, { headless: true, ...pinned }); } });
  manager.closeGraceMs = 50;
  const routes = createBrowserRoutes({ sessions, manager }); let frontend;
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>Page ${req.url}</title><h1>Page ${req.url}</h1>`); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await frontend?.close(); await routes.stop(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const opened = await manager.open('viewer', { url: `${url}/one` });
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import BrowserPanel from './apps/web/src/session/BrowserPanel'; createRoot(document.getElementById('root')).render(<BrowserPanel client={{rpc:(env,method,params)=>window.request(method,params),on:()=>()=>{}}} env={{id:'laptop',name:'Laptop',online:true}} session={{id:'viewer',title:'Window'}}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  frontend = await chromium.launch({ headless: true, ...pinned });
  const css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') + '\n' + await readFile('apps/web/src/session/browser.css', 'utf8');
  const page = await frontend.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [], shows = []; page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('request', (method, params) => { if (method === 'browser.show') shows.push(params); return routes.dispatch(method, params); });
  await page.setContent('<html data-theme="dark"><body><div class="browser-dock" style="height:800px;margin:16px"><div id="root" style="display:contents"></div></div></body></html>');
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle.outputFiles[0].text });

  await page.getByText('A Chromium window on Laptop').waitFor();
  await page.locator('.bp-item-title', { hasText: 'Page /one' }).waitFor();
  assert.equal(await page.locator('img').count(), 0, 'no picture of the page in Helm');
  // At a computer, opening the browser brings its window up.
  await page.waitForFunction(() => document.querySelector('.bp-primary')?.textContent === 'Show window');
  assert.equal(shows.length, 1); assert.equal(windows.length, 1);

  // The address bar drives the window's tab.
  await page.getByLabel('Browser address').fill(`${url}/two`); await page.getByLabel('Browser address').press('Enter');
  await manager.tabs.get(opened.tab.id).page.waitForURL(`${url}/two`);
  await page.locator('.bp-item-title', { hasText: 'Page /two' }).waitFor();

  // Read page shows what the agent sees, as text.
  await page.getByRole('button', { name: 'Read page' }).click();
  await page.locator('.browser-text', { hasText: 'Page /two' }).waitFor();

  // A tab the owner opens in the window shows up in the list.
  const extra = await (await manager.contexts.get('viewer')).newPage(); await extra.goto(`${url}/three`);
  await page.locator('.bp-item-title', { hasText: 'Page /three' }).waitFor();

  // Closing the window by hand leaves the tabs listed, asleep.
  await (await manager.contexts.get('viewer')).close();
  await page.getByText('· paused').first().waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Open window' }).waitFor();
  assert.equal(windows.length, 1, 'the list never reopens the window on its own');
  await page.getByRole('button', { name: 'Open window' }).click();
  await page.getByRole('button', { name: 'Show window' }).waitFor();
  assert.equal(windows.length, 2);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.deepEqual(errors, []);
});

test('without a screen the panel lists the hidden tabs and never offers a window', { timeout: 60000 }, async t => {
  const sessions = { get: id => ({ id }) };
  const manager = new BrowserManager({ directory: join(directory, 'hidden'), session: sessions.get, launch: () => chromium.launch({ headless: true, ...pinned }), canWindow: false });
  const routes = createBrowserRoutes({ sessions, manager }); let frontend;
  t.after(async () => { await frontend?.close(); await routes.stop(); });
  await manager.open('vm', { url: 'about:blank' });
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import BrowserPanel from './apps/web/src/session/BrowserPanel'; createRoot(document.getElementById('root')).render(<BrowserPanel client={{rpc:(env,method,params)=>window.request(method,params),on:()=>()=>{}}} env={{id:'vm',name:'VM',online:true}} session={{id:'vm',title:'Hidden'}}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  frontend = await chromium.launch({ headless: true, ...pinned });
  const page = await frontend.newPage({ viewport: { width: 390, height: 844 } });
  const methods = []; await page.exposeFunction('request', (method, params) => { methods.push(method); return routes.dispatch(method, params); });
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByText('Hidden, on VM').waitFor();
  await page.getByRole('button', { name: 'New tab' }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: /window/i }).count(), 0);
  assert.ok(!methods.includes('browser.show'));
});
