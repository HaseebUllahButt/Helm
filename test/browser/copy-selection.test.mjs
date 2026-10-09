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

test('formatted copy retains list numbers, paragraphs, links and emphasis', async t => {
  const page = await fixture(t, '<div class="md"><h2>Plan</h2><ol start="3"><li><strong>First</strong> task</li><li><em>Next</em> <a href="https://example.com/">task</a></li></ol><p>Done</p></div>');
  const data = await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('.md'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return window.selectionClipboard(selection, document.getElementById('root'));
  });
  assert.match(data.text, /3\. First task\n4\. Next task/);
  assert.match(data.text, /Plan\n/);
  assert.match(data.html, /<strong>First<\/strong>/);
  assert.match(data.html, /<em>Next<\/em>/);
  assert.match(data.html, /href="https:\/\/example.com\/"/);
  assert.match(data.html, /<ol start="3">/);
});

test('partial list selections keep their original numbering and nested bullets', async t => {
  const page = await fixture(t, '<div class="md"><ol><li>Skip</li><li>Second<ul><li>Child</li></ul></li><li>Third</li></ol></div>');
  const data = await page.evaluate(() => {
    const items = document.querySelectorAll('.md > ol > li');
    const range = document.createRange(); range.setStart(items[1].firstChild, 0); range.setEnd(items[2].firstChild, 5);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return window.selectionClipboard(selection, document.getElementById('root'));
  });
  assert.equal(data.text, '2. Second\n  - Child\n3. Third');
  assert.match(data.html, /<ol start="2">/);
  const single = await page.evaluate(() => {
    const text = document.querySelectorAll('.md > ol > li')[2].firstChild;
    const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 4);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return window.selectionClipboard(selection, document.getElementById('root'));
  });
  assert.equal(single.text, '3. hir');
  assert.match(single.html, /<ol start="3">/);
});

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
  assert.equal(rich['text/plain'], '1. Bold');
  assert.match(rich['text/html'], /<strong>Bold<\/strong>/);
  const explicit = await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return { prevented: event.defaultPrevented, text: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html') };
  });
  assert.equal(explicit.prevented, true);
  assert.equal(explicit.text, '1. Bold');
  assert.match(explicit.html, /<strong>Bold<\/strong>/);
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
