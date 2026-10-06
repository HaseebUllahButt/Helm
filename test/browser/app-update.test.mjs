import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

test('an arriving update waits while someone is typing, then reloads by itself', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AppUpdate } from './apps/web/src/AppUpdate';
    window.reloads = 0;
    createRoot(document.getElementById('root')).render(<AppUpdate quietMs={400} reload={() => window.reloads++} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.route('http://helm-test/**', (route) => route.fulfill(route.request().url().endsWith('/api/version')
      ? { contentType: 'application/json', body: JSON.stringify({ build: 'index-new.js' }) }
      : route.request().url().endsWith('.js') ? { contentType: 'text/javascript', body: '' }
        : { contentType: 'text/html', body: '<input aria-label="Draft"><div id="root"></div><script type="module" src="/assets/index-old.js"></script>' }));
    await page.goto('http://helm-test/');
    await page.getByLabel('Draft').fill('keep this unsent message');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    // Mid-sentence: the update waits, however long that takes.
    await page.waitForTimeout(6_500);
    assert.equal(await page.evaluate(() => window.reloads), 0);
    assert.equal(await page.getByLabel('Draft').inputValue(), 'keep this unsent message');
    // Stepped away from the box: the next quiet moment reloads.
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForFunction(() => window.reloads === 1, null, { timeout: 8_000 });
  } finally { await browser.close(); }
});

test('an installed worker loads the new build by itself despite a slow network, without clearing pairing', async context => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AppUpdate } from './apps/web/src/AppUpdate';
    import { clearRefreshMarker } from './apps/web/src/reload';
    clearRefreshMarker();
    createRoot(document.getElementById('root')).render(<AppUpdate quietMs={200} />);
    navigator.serviceWorker.register('/sw.js');
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const worker = await readFile('apps/web/public/sw.js', 'utf8');
  let version = 'old', delay = 0;
  const timers = new Set();
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('cache-control', 'no-store');
    if (path === '/sw.js') {
      response.setHeader('content-type', 'text/javascript'); response.end(worker);
    } else if (path === '/api/version') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ build: `index-${version}.js` }));
    } else if (path.startsWith('/assets/')) {
      response.setHeader('content-type', 'text/javascript');
      response.end(`window.loadedBuild = ${JSON.stringify(path)};\n` + bundle.outputFiles[0].text);
    } else {
      const html = `<!doctype html><div id="root"></div><script type="module" src="/assets/index-${version}.js"></script>`;
      const timer = setTimeout(() => { timers.delete(timer); response.setHeader('content-type', 'text/html'); response.end(html); }, delay);
      timers.add(timer);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/#open=vm/chat`);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(() => { localStorage.setItem('helm.auth', 'keep-pairing'); localStorage.setItem('saved-draft', 'keep-draft'); });
  version = 'new'; delay = 900;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => window.loadedBuild === '/assets/index-new.js', null, { timeout: 15_000 });
  assert.equal(new URL(page.url()).hash, '#open=vm/chat');
  assert.equal(new URL(page.url()).search, '');
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('helm.auth'), localStorage.getItem('saved-draft')]), ['keep-pairing', 'keep-draft']);
  await page.reload();
  await page.waitForFunction(() => window.loadedBuild === '/assets/index-new.js');
});
