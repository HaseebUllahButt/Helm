import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
  const bundle = await build({ stdin: { contents: `
    import React, { lazy, Suspense, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AppErrorBoundary } from './apps/web/src/AppErrorBoundary';
    const Screen = lazy(() => import('/assets/expired.js'));
    function Broken() { throw new Error('Cannot render this chat'); }
    function App() {
      const [screen, setScreen] = useState('chat');
      return <>
        <textarea aria-label="Draft" onChange={e => localStorage.setItem('saved-draft', e.target.value)} />
        <button onClick={() => setScreen('lazy')}>Open screen</button>
        <button onClick={() => setScreen('broken')}>Open broken chat</button>
        {screen === 'lazy' && <Suspense fallback="Opening screen"><Screen /></Suspense>}
        {screen === 'broken' && <Broken />}
      </>;
    }
    window.reloads = 0;
    createRoot(document.getElementById('root')).render(
      <AppErrorBoundary reload={() => window.reloads++}><App /></AppErrorBoundary>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false,
    external: ['/assets/expired.js'], format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
});
after(async () => { await browser?.close(); });

async function pageFor(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('http://helm-test/**', route => route.fulfill(route.request().url().endsWith('.js')
    ? { status: 404, body: 'not found' }
    : { contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://helm-test/');
  await page.addScriptTag({ content: script });
  return page;
}

test('a missing screen chunk shows recovery without clearing pairing or saved drafts', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => localStorage.setItem('helm.auth', 'test-membership'));
  await page.getByLabel('Draft').fill('keep my unsent message');
  await page.getByRole('button', { name: 'Open screen', exact: true }).click();
  await page.getByRole('heading', { name: 'Helm needs a refresh' }).waitFor();
  assert.equal(await page.evaluate(() => window.reloads), 0, 'no reload loop');
  await page.getByRole('button', { name: 'Reload Helm' }).click();
  assert.equal(await page.evaluate(() => window.reloads), 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('saved-draft')), 'keep my unsent message');
  assert.equal(await page.evaluate(() => localStorage.getItem('helm.auth')), 'test-membership');
});

test('a render error leaves a readable recovery screen and error details', async t => {
  const page = await pageFor(t);
  await page.getByRole('button', { name: 'Open broken chat' }).click();
  await page.getByRole('heading', { name: 'Helm couldn’t open this screen' }).waitFor();
  await page.getByText('Error details', { exact: true }).click();
  assert.equal(await page.getByText('Cannot render this chat', { exact: true }).isVisible(), true);
});

test('the installed shell remains recoverable even when its entry bundle is missing', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const html = (await readFile('apps/web/index.html', 'utf8')).replace('/src/main.tsx', '/assets/expired.js');
  let opens = 0;
  await page.route('http://helm-test/**', route => {
    if (new URL(route.request().url()).pathname === '/') {
      opens++;
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto('http://helm-test/');
  assert.equal(await page.getByRole('heading', { name: 'Opening Helm…' }).isVisible(), true);
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', { name: 'Reload Helm' }).click(),
  ]);
  assert.equal(opens, 2);
});
