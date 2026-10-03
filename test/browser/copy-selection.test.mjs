import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useRef } from 'react';
    import { createRoot } from 'react-dom/client';
    import { useCopySelection } from './apps/web/src/useCopySelection';
    function Chat() {
      const ref = useRef(null); useCopySelection(ref);
      return <div ref={ref}><p id="reply">Copy just this reply</p><textarea id="draft" defaultValue="Private draft" /></div>;
    }
    createRoot(document.getElementById('root')).render(<Chat />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

test('chat copies completed text selections, not hover or outside text', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<div id="root"></div><p id="outside">Outside chat</p>');
  await page.evaluate(() => {
    window.copies = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copies.push(text); } } });
  });
  await page.addScriptTag({ content: script });
  await page.waitForSelector('#reply');
  await page.locator('#reply').hover();
  assert.deepEqual(await page.evaluate(() => window.copies), []);
  const select = async (id, keyboard = false) => page.evaluate(({ id, keyboard }) => {
    const node = document.getElementById(id);
    if (!keyboard) node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(keyboard ? new KeyboardEvent('keyup', { key: 'Shift' }) : new PointerEvent('pointerup'));
  }, { id, keyboard });
  await select('reply');
  assert.deepEqual(await page.evaluate(() => window.copies), ['Copy just this reply']);
  await select('outside');
  assert.equal(await page.evaluate(() => window.copies.length), 1);
  // Copying something elsewhere must not suppress a repeat selection.
  await page.evaluate(() => navigator.clipboard.writeText('Elsewhere'));
  await select('reply');
  assert.equal(await page.evaluate(() => window.copies.at(-1)), 'Copy just this reply');
  const count = await page.evaluate(() => window.copies.length);
  await page.locator('#outside').click();
  assert.equal(await page.evaluate(() => window.copies.length), count);
  await page.evaluate(() => { window.getSelection().removeAllRanges(); document.dispatchEvent(new PointerEvent('pointerup')); });
  await select('reply', true);
  assert.equal(await page.evaluate(() => window.copies.length), 4);
  await page.locator('#draft').fill('Do not copy this draft');
  await page.locator('#draft').selectText();
  await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => window.copies.length), 4);
});
