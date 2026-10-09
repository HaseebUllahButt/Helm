import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script, css;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { AppearanceSettings } from './apps/web/src/AppearanceSettings';
    import { applyAppearance, watchSystemTheme, loadAppearance } from './apps/web/src/appearance';
    applyAppearance(); watchSystemTheme(); window.loadAppearance = loadAppearance;
    createRoot(document.getElementById('root')).render(<>
      <AppearanceSettings />
      <div id="sample" style={{ background: 'var(--raised)', padding: 20 }}>Sample conversation</div>
    </>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

for (const width of [1440, 390]) test(`navy is optional, persistent, and independent of OS appearance at ${width}px`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: 'dark' });
  t.after(() => page.close());
  await page.route('http://helm.test/**', route => route.fulfill({ contentType: 'text/html', body: '<meta name="theme-color"><div id="root"></div>' }));
  const open = async () => {
    await page.goto('http://helm.test/');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: script });
    await page.getByRole('button', { name: 'Navy', exact: true }).waitFor();
  };
  const state = () => page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    bar: document.querySelector('meta[name="theme-color"]').content,
    prefs: window.loadAppearance(),
  }));
  await open();
  assert.equal((await state()).bg, 'rgb(20, 22, 27)');
  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  const bounds = await page.locator('#sample').boundingBox();
  await page.getByRole('button', { name: 'Navy', exact: true }).click();
  const navy = await state();
  assert.equal(navy.theme, 'navy');
  assert.equal(navy.bg, 'rgb(8, 27, 38)');
  assert.equal(navy.bar, '#081b26');
  assert.equal(navy.prefs.density, 'compact');
  assert.deepEqual(await page.locator('#sample').boundingBox(), bounds);
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal((await state()).theme, 'navy');
  await open();
  assert.equal(await page.getByRole('button', { name: 'Navy', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal((await state()).bg, 'rgb(8, 27, 38)');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `/tmp/helm-navy-theme-${width}.png` });
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  assert.equal((await state()).bg, 'rgb(20, 22, 27)');
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  assert.equal((await state()).bg, 'rgb(243, 244, 247)');
  assert.equal((await state()).bar, '#f3f4f7');
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  assert.equal((await state()).theme, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal((await state()).bg, 'rgb(20, 22, 27)');
});
