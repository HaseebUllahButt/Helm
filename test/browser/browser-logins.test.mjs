import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { fixture, encrypted } from '../fixtures/browser-logins.mjs';

const directory = await mkdtemp(join(tmpdir(), 'helm-real-logins-'));
process.env.HELM_DIR = directory; process.env.HELM_NO_SERVICE = '1';
// No real windows on the screen of the machine running the tests.
delete process.env.WAYLAND_DISPLAY; delete process.env.DISPLAY;
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(directory, file);
const { BrowserManager } = await import('../../packages/connect/src/browser.js');
const { createBrowserRoutes } = await import('../../packages/connect/src/browser-routes.js');
const { createLoginReader } = await import('../../packages/connect/src/browser-logins.js');
test.after(() => rm(directory, { recursive: true, force: true }));

test('real Chromium sends imported cookies; login menu copies, sets a default, refreshes and clears it', { timeout: 60000 }, async t => {
  const root = join(directory, 'profiles'), f = await fixture(root, { name: 'Test profile' });
  const insert = value => f.insert({ host: '127.0.0.1', name: 'test-login', bytes: encrypted(value, { host: '127.0.0.1' }), secure: false });
  insert('synthetic-first');
  const logins = createLoginReader({ configHome: root, platform: 'linux' });
  const manager = new BrowserManager({ directory: join(directory, 'browser'), session: id => ({ id }), logins });
  const routes = createBrowserRoutes({ manager }); let frontend;
  const server = createServer((req, res) => { res.end(req.headers.cookie || 'no cookies'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await frontend?.close(); await manager.stop(); f.db.close(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  await manager.importLogins('unopened', 'Test profile');
  const early = await manager.open('unopened', { url });
  assert.equal(await manager.tabs.get(early.tab.id).page.textContent('body'), 'test-login=synthetic-first');
  await manager.open('viewer', { url });
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import BrowserLogins from './apps/web/src/session/BrowserLogins'; createRoot(document.getElementById('root')).render(<BrowserLogins client={{rpc:(env,method,params)=>window.request(method,params)}} env={{id:'sandbox',name:'Sandbox'}} session={{id:'viewer'}}/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  frontend = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  for (const width of [1280, 390]) {
    const page = await frontend.newPage({ viewport: { width, height: 650 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('request', (method, params) => routes.dispatch(method, params));
    await page.setContent('<html data-theme="dark"><body><div class="browser-panel" style="padding:24px;display:flex;flex-direction:row;align-items:flex-start;height:auto;min-height:0" id="root"></div></body></html>');
    await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') + await readFile('apps/web/src/session/browser.css', 'utf8') });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    if (width === 390) { await page.getByRole('button', { name: 'Logins', exact: true }).focus(); await page.keyboard.press('Enter'); } else await page.getByRole('button', { name: 'Logins', exact: true }).click();
    await page.getByLabel('Login profile').selectOption('chromium:Default');
    await page.getByRole('button', { name: 'Use for all new chats', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Helm copied logins for 1 site.' }).waitFor();
    await page.getByRole('button', { name: 'Clear default', exact: true }).waitFor();
    assert.deepEqual(await manager.loginDefault('viewer'), { profileKey: 'chromium:Default' });
    const seeded = await manager.open(`new-${width}`, { url });
    assert.equal(await manager.tabs.get(seeded.tab.id).page.textContent('body'), 'test-login=synthetic-first');
    if (width === 1280) {
      f.db.exec('DELETE FROM cookies'); insert('synthetic-refreshed');
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Refresh')?.disabled);
      const target = [...manager.tabs.values()].find(tab => tab.sessionId === 'viewer').page;
      await target.reload(); assert.equal(await target.textContent('body'), 'test-login=synthetic-refreshed');
      // Restore for the next viewport's fresh imports.
      f.db.exec('DELETE FROM cookies'); insert('synthetic-first');
    }
    assert.ok(await page.getByRole('dialog').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
    if (process.env.HELM_TEST_SCREENSHOT_DIR) { await mkdir(process.env.HELM_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, `browser-logins-${width}.png`) }); }
    await page.getByRole('button', { name: 'Clear default', exact: true }).click();
    await page.getByRole('button', { name: 'Clear default', exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(await manager.loginDefault('viewer'), { profileKey: null });
    if (width === 390) await page.keyboard.press('Escape'); else await page.getByRole('button', { name: 'Close', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []); await page.close();
  }
});
