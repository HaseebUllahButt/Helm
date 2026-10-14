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

test('the panel opens its tabs in a real window, drives them from the address bar, and takes them back', { timeout: 60000 }, async t => {
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
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('request', (method, params) => routes.dispatch(method, params));
  await page.setContent('<html data-theme="dark"><body><div class="browser-dock" style="height:800px;margin:16px"><div id="root" style="display:contents"></div></div></body></html>');
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByAltText('Live browser page').waitFor();

  await page.getByRole('button', { name: 'Open in a window' }).click();
  await page.getByText('Open in a window on Laptop.').waitFor();
  assert.equal(windows.length, 1);
  assert.equal(manager.tabs.get(opened.tab.id).window, true);
  assert.equal(await page.getByAltText('Live browser page').count(), 0, 'no picture stream while the window shows the page');
  assert.equal(await page.getByRole('alert').count(), 0, 'the move says nothing went wrong');

  // The address bar drives the window's tab without asking to take control.
  await page.getByLabel('Browser address').fill(`${url}/two`); await page.getByLabel('Browser address').press('Enter');
  await manager.tabs.get(opened.tab.id).page.waitForURL(`${url}/two`);
  assert.equal(manager.tabs.get(opened.tab.id).control, null);

  // A tab the owner opens in the window shows up in the panel.
  await (await manager.contexts.get('viewer')).newPage();
  await page.locator('.bp-tab').nth(1).waitFor();

  await page.getByRole('button', { name: 'Bring back here' }).click();
  await page.getByAltText('Live browser page').waitFor();
  assert.equal(manager.tabs.get(opened.tab.id).window, false);
  assert.equal(manager.tabs.get(opened.tab.id).page.url(), `${url}/two`);

  // Closing the window by hand brings the panel's picture back too.
  await page.getByRole('button', { name: 'Open in a window' }).click();
  await page.getByText('Open in a window on Laptop.').waitFor();
  await (await manager.contexts.get('viewer')).close();
  await page.getByAltText('Live browser page').waitFor({ timeout: 8000 });
  assert.deepEqual(errors, []);
});
