import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { flushSync } from 'react-dom';
    import { createRoot } from 'react-dom/client';
    import { useNow } from './apps/web/src/useNow';
    let hidden = false;
    Object.defineProperty(document, 'hidden', { get: () => hidden });
    window.show = visible => flushSync(() => { hidden = !visible; document.dispatchEvent(new Event('visibilitychange')); });
    window.renders = 0;
    function Clock() {
      const now = useNow(1000);
      window.renders++;
      return <output>{now}</output>;
    }
    const root = createRoot(document.getElementById('root'));
    window.mount = () => flushSync(() => root.render(<Clock/>));
    window.unmount = () => root.unmount();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
});
after(async () => browser?.close());

async function pageFor(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('http://helm-clock-test/**', route => route.fulfill({
    contentType: 'text/html', body: '<div id="root"></div>',
  }));
  await page.goto('http://helm-clock-test/');
  await page.clock.install({ time: new Date('2026-10-27T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-27T00:00:01Z'));
  await page.addScriptTag({ content: script });
  return page;
}

test('the shared clock stops while hidden and catches up when shown', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => window.mount());
  await page.waitForFunction(() => document.querySelector('output'));
  await page.clock.runFor(1100);
  await page.waitForFunction(() => Number(document.querySelector('output').textContent) > Date.parse('2026-10-27T00:00:00Z'));
  const before = await page.evaluate(() => { window.show(false); return window.renders; });
  await page.clock.runFor(5000);
  assert.equal(await page.evaluate(() => window.renders), before);
  await page.evaluate(() => window.show(true));
  await page.waitForFunction(() => Number(document.querySelector('output').textContent) === Date.now());
  assert.equal(await page.evaluate(() => window.renders), before + 1);
});

test('a clock mounted while hidden waits for visibility and unmount removes its timer', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => { window.show(false); window.mount(); });
  await page.waitForFunction(() => document.querySelector('output'));
  const before = await page.evaluate(() => window.renders);
  await page.clock.runFor(5000);
  assert.equal(await page.evaluate(() => window.renders), before);
  await page.evaluate(() => window.show(true));
  await page.waitForFunction(() => Number(document.querySelector('output').textContent) === Date.now());
  const after = await page.evaluate(() => { window.unmount(); return window.renders; });
  await page.clock.runFor(5000);
  await page.evaluate(() => { window.show(false); window.show(true); });
  assert.equal(await page.evaluate(() => window.renders), after);
});
