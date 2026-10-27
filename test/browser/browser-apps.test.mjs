import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('Running apps opens new chat tabs, stays reachable, follows starts and stops, and stops scanning when closed', { timeout: 30000 }, async t => {
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import BrowserPanel from './apps/web/src/session/BrowserPanel'; const root=createRoot(document.getElementById('root')); window.unmount=()=>root.unmount(); root.render(<BrowserPanel client={{rpc:(env,method,params)=>window.request(env,method,params),on:()=>()=>{}}} env={{id:'vm',name:'VM'}} session={{id:'chat'}}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(5000);
  let apps = [], scans = 0, tabs = [];
  const opens = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('request', (env, method, params) => {
    assert.equal(env, 'vm'); assert.equal(params.id, 'chat');
    if (method === 'browser.apps') { scans++; return { apps }; }
    if (method === 'browser.list') return { tabs, canWindow: false };
    if (method === 'browser.openApp') { opens.push(params); const tab = { id: `tab-${opens.length}`, title: 'Test app', url: params.url, downloads: [], dialog: null }; tabs = [...tabs, tab]; return { tab }; }
    throw new Error(method);
  });
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => { window.timers = new Map(); window.setInterval = fn => { const id = Math.random(); window.timers.set(id, fn); return id; }; window.clearInterval = id => window.timers.delete(id); });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByText('No apps are running for this chat.').waitFor();
  assert.equal(scans, 1);
  apps = [{ name: 'vite', port: 5173, pid: 123 }];
  await page.evaluate(() => { for (const fn of window.timers.values()) fn(); });
  await page.getByRole('button', { name: 'vite · port 5173 · Open' }).waitFor();
  await page.getByRole('button', { name: 'vite · port 5173 · Open' }).click();
  await page.getByRole('button', { name: 'Running apps (1)' }).waitFor();
  assert.equal(opens[0].url, 'http://localhost:5173');
  await page.getByRole('button', { name: 'Running apps (1)' }).click();
  await page.getByRole('button', { name: 'vite · port 5173 · Open' }).click();
  assert.equal(opens.length, 2, 'each tap opens a new tab');
  apps = [];
  await page.evaluate(() => { for (const fn of window.timers.values()) fn(); });
  await page.getByText('No apps are running for this chat.').waitFor();
  assert.equal(await page.locator('.bp-app-card').count(), 0);
  await page.evaluate(() => window.unmount());
  const count = scans;
  await page.evaluate(() => { for (const fn of window.timers.values()) fn(); });
  assert.equal(await page.evaluate(() => window.timers.size), 0);
  assert.equal(scans, count);
  assert.deepEqual(errors, []);
});
