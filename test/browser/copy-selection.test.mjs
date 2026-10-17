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
  assert.equal(single.text, 'hir');
  assert.doesNotMatch(single.html, /<(ol|ul|li)\b/);
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

test('prose in nested list items has no marker; selected child lists keep their own numbering', async t => {
  const page = await fixture(t, '<div class="md"><ol start="7"><li><p>Ordinary <em>words</em></p><ol start="3"><li>Child one</li><li>Child two</li></ol></li></ol></div>');
  const data = await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('.md p'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const prose = window.selectionClipboard(selection, document.getElementById('root'));
    const items = document.querySelectorAll('.md li li');
    range.setStart(items[0].firstChild, 0); range.setEnd(items[1].firstChild, 9);
    selection.removeAllRanges(); selection.addRange(range);
    return { prose, list: window.selectionClipboard(selection, document.getElementById('root')) };
  });
  assert.equal(data.prose.text, 'Ordinary words');
  assert.match(data.prose.html, /<em>words<\/em>/);
  assert.doesNotMatch(data.prose.html, /<(ol|ul|li)\b/);
  assert.equal(data.list.text, '3. Child one\n4. Child two');
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
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
      if (window.blockCopy) throw Error('gesture required');
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
  await page.waitForTimeout(550);
  assert.equal(await page.evaluate(() => window.copies.length), 1);
  await page.evaluate(() => { window.blockCopy = false; document.dispatchEvent(new Event('touchend')); });
  await page.waitForFunction(() => window.copies.at(-1) === 'New selection');
  // Clearing it must not leave stale text waiting for the next tap.
  await page.evaluate(() => { window.getSelection().removeAllRanges(); });
  await page.waitForTimeout(30);
  await page.evaluate(() => document.dispatchEvent(new Event('touchend')));
  assert.equal(await page.evaluate(() => window.copies.length), 2);
});

test('missing clipboard API uses existing selection and never reports blocked copy as success', async t => {
  const page = await fixture(t, '<strong>LAN selection</strong>');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined });
    window.allowCopy = false;
    window.copies = [];
    document.execCommand = command => {
      if (!window.allowCopy || command !== 'copy') return false;
      const clipboardData = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
      window.copies.push({ text: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html') });
      return true;
    };
    const range = document.createRange(); range.selectNodeContents(document.querySelector('strong'));
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  await page.waitForTimeout(550);
  assert.equal(await page.locator('.selection-copied').count(), 0);
  await page.evaluate(() => { window.allowCopy = true; document.dispatchEvent(new Event('touchend')); });
  await page.waitForFunction(() => window.copies.length === 1);
  assert.deepEqual(await page.evaluate(() => window.copies[0]), { text: 'LAN selection', html: '<p><strong>LAN selection</strong></p>' });
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'LAN selection');
});

test('copying a list numbers each sibling once and a short selection ignores unrelated history', async t => {
  const page = await fixture(t, '<div class="md"><ol reversed start="12"><li>First</li><li value="5">Second</li><li>Third</li></ol></div>');
  const result = await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('.md'));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const list = window.selectionClipboard(selection, document.getElementById('root'));
    const history = document.createElement('div');
    history.innerHTML = '<ol>' + '<li>Unrelated</li>'.repeat(3000) + '</ol>';
    document.getElementById('root').append(history);
    let scans = 0;
    const original = Range.prototype.intersectsNode;
    Range.prototype.intersectsNode = function(node) { scans++; return original.call(this, node); };
    range.selectNodeContents(document.querySelector('.md li'));
    const short = window.selectionClipboard(selection, document.getElementById('root'));
    return { list, short, scans };
  });
  assert.equal(result.list.text, '12. First\n5. Second\n4. Third');
  assert.equal(result.short.text, 'First');
  assert.equal(result.scans, 0, 'selecting prose must not walk the rest of the chat');
});
