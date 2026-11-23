import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useRef } from 'react';
    import { createRoot } from 'react-dom/client';
    import { selectionClipboard } from './apps/web/src/copySelection';
    window.selectionClipboard = selectionClipboard;
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

test('chat keeps a copy made in another app and never copies empty text', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    window.copies = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copies.push(text); } } });
  });
  await page.addScriptTag({ content: script });
  await page.waitForSelector('#reply');
  const press = () => page.evaluate(() => {
    document.getElementById('reply').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup'));
  });
  const select = node => page.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector(node));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }, node);
  await select('#reply');
  await press();
  assert.deepEqual(await page.evaluate(() => window.copies), ['Copy just this reply']);
  // The owner leaves Helm, copies in another app, and clicks the old selection.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
  await press();
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' })));
  assert.equal(await page.evaluate(() => window.copies.length), 1);
  // A new selection of the same text copies again.
  await page.evaluate(() => { window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
  await page.waitForFunction(() => true);
  await select('#reply');
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')));
  await press();
  assert.equal(await page.evaluate(() => window.copies.length), 2);
  // Text that copies as nothing (only a button) never replaces the clipboard.
  await page.evaluate(() => { document.getElementById('reply').innerHTML = '<button id="only">Open</button>'; });
  await select('#only');
  await press();
  assert.equal(await page.evaluate(() => window.copies.length), 2);
});

async function fixture(t, html) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('https://helm.test/', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('https://helm.test/');
  await page.addScriptTag({ content: script });
  await page.waitForSelector('#reply');
  await page.evaluate(html => { document.getElementById('reply').innerHTML = html; }, html);
  return page;
}

test('automatic selection writes HTML and text, explicit copy uses both MIME types', async t => {
  const page = await fixture(t, '<div class="md"><ol><li><strong>Bold</strong></li></ol></div>');
  await page.evaluate(() => {
    window.richCopies = [];
    Object.defineProperty(navigator.clipboard, 'write', { value: async items => {
      window.richCopies.push(await Promise.all(items[0].types.map(async type => [type, await (await items[0].getType(type)).text()])));
    } });
    const node = document.querySelector('strong');
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new PointerEvent('pointerup'));
  });
  await page.waitForFunction(() => window.richCopies.length === 1);
  const rich = Object.fromEntries(await page.evaluate(() => window.richCopies[0]));
  assert.equal(rich['text/plain'], 'Bold');
  assert.match(rich['text/html'], /<strong>Bold<\/strong>/);
  assert.doesNotMatch(rich['text/html'], /<(ol|ul|li)\b/);
  const explicit = await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return { prevented: event.defaultPrevented, text: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html') };
  });
  assert.equal(explicit.prevented, true);
  assert.equal(explicit.text, 'Bold');
  assert.match(explicit.html, /<strong>Bold<\/strong>/);
  assert.doesNotMatch(explicit.html, /<(ol|ul|li)\b/);
});

test('code copy keeps blank lines and excludes the copy toolbar', async t => {
  const page = await fixture(t, '<div class="md"><div class="codeblock"><div class="codehead">js<button>copy</button></div><pre><code>  one\n\n\n  two</code></pre></div></div>');
  const data = await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('.md'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return window.selectionClipboard(selection, document.getElementById('root'));
  });
  assert.equal(data.text, '  one\n\n\n  two');
  assert.doesNotMatch(data.html, /button|codehead/);
  assert.match(data.html, /<pre><code>/);
});

test('phone handles copy without pointer events and retry a blocked write on touchend', async t => {
  const page = await fixture(t, 'Phone selection');
  await page.evaluate(() => {
    window.copies = [];
    window.blockCopy = false;
    window.blocked = 0;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
      if (window.blockCopy) { window.blocked++; throw Error('gesture required'); }
      window.copies.push(text);
    } } });
    document.execCommand = () => false;
    const range = document.createRange(); range.selectNodeContents(document.getElementById('reply'));
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  await page.waitForFunction(() => window.copies.length === 1);
  assert.equal(await page.locator('.selection-copied').innerText(), 'Copied');
  await page.evaluate(() => {
    window.blockCopy = true;
    window.getSelection().removeAllRanges();
    document.getElementById('reply').textContent = 'New selection';
    const range = document.createRange(); range.selectNodeContents(document.getElementById('reply'));
    window.getSelection().addRange(range);
  });
  // Wait for the automatic copy to try and be refused.
  await page.waitForFunction(() => window.blocked === 1);
  assert.equal(await page.evaluate(() => window.copies.length), 1);
  await page.evaluate(() => { window.blockCopy = false; document.dispatchEvent(new Event('touchend')); });
  await page.waitForFunction(() => window.copies.at(-1) === 'New selection');
  // Clearing it must not leave stale text waiting for the next tap.
  await page.evaluate(() => new Promise(resolve => {
    // The chat's own listener came first, so it has seen the change when this runs.
    document.addEventListener('selectionchange', resolve, { once: true });
    window.getSelection().removeAllRanges();
  }));
  await page.evaluate(() => document.dispatchEvent(new Event('touchend')));
  assert.equal(await page.evaluate(() => window.copies.length), 2);
});

test('missing clipboard API uses existing selection and never reports blocked copy as success', async t => {
  const page = await fixture(t, '<strong>LAN selection</strong>');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined });
    window.allowCopy = false;
    window.copies = [];
    window.tries = 0;
    document.execCommand = command => {
      window.tries++;
      if (!window.allowCopy || command !== 'copy') return false;
      const clipboardData = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
      window.copies.push({ text: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html') });
      return true;
    };
    const range = document.createRange(); range.selectNodeContents(document.querySelector('strong'));
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  await page.waitForFunction(() => window.tries === 1);
  assert.equal(await page.locator('.selection-copied').count(), 0);
  await page.evaluate(() => { window.allowCopy = true; document.dispatchEvent(new Event('touchend')); });
  await page.waitForFunction(() => window.copies.length === 1);
  assert.deepEqual(await page.evaluate(() => window.copies[0]), { text: 'LAN selection', html: '<p><strong>LAN selection</strong></p>' });
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'LAN selection');
});
