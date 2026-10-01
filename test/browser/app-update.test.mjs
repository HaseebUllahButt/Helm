import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('an arriving update preserves the page and draft until Reload is chosen', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AppUpdate } from './apps/web/src/AppUpdate';
    window.reloads = 0;
    createRoot(document.getElementById('root')).render(<AppUpdate reload={() => window.reloads++} />);
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
    await page.getByRole('status').waitFor();
    assert.equal(await page.evaluate(() => window.reloads), 0);
    assert.equal(await page.getByLabel('Draft').inputValue(), 'keep this unsent message');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await page.evaluate(() => window.reloads), 0);
    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    assert.equal(await page.evaluate(() => window.reloads), 1);
    await page.getByRole('button', { name: 'Later', exact: true }).click();
    assert.equal(await page.getByRole('status').count(), 0);
    assert.equal(await page.getByLabel('Draft').inputValue(), 'keep this unsent message');
  } finally { await browser.close(); }
});
