import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// Math in a reply is drawn with KaTeX (md.ts marks it, math.ts draws it).
let browser, files, css;
const reply = [
  'Only $W_Q$, $W_K$ and $W_V$ learn. Also \\(x^2\\) and $$a+b$$ inline.',
  '',
  '$$',
  '\\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V',
  '$$',
  '',
  '\\[ \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2} \\]',
  '',
  '```math',
  'e^{i\\pi} + 1 = 0',
  '```',
  '',
  'It costs $5 and $10, or $5-$10. Code stays: `$x$`. Escaped: \\$y\\$.',
].join('\n');
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { Markdown } from './apps/web/src/Markdown';
      import { selectionClipboard } from './apps/web/src/copySelection';
      const root = createRoot(document.getElementById('root'));
      window.showMarkdown = (text, live = false) => {
        flushSync(() => root.render(<Markdown text={text} live={live} />));
      };
      window.copySelected = () => selectionClipboard(getSelection(), document.querySelector('.md'));
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'esm', splitting: true, jsx: 'automatic',
    outdir: '/helm-test/assets', entryNames: 'entry', chunkNames: '[name]-[hash]',
  });
  files = new Map(bundle.outputFiles.map(file => [file.path.replace('/helm-test', ''), file.text]));
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '')
    + await readFile('node_modules/katex/dist/katex.min.css', 'utf8');
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
});
after(async () => { await browser?.close(); });

async function pageFor(t) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://helm-test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (files.has(path)) return route.fulfill({ contentType: 'text/javascript', body: files.get(path) });
    if (path.startsWith('/assets/')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/assets/entry.js"></script>' });
  });
  await page.goto('http://helm-test/');
  await page.addStyleTag({ content: css });
  await page.waitForFunction(() => typeof window.showMarkdown === 'function');
  return { page, errors };
}

test('a reply draws its math and leaves prices, code and escaped dollars as text', async t => {
  const { page, errors } = await pageFor(t);
  await page.evaluate(text => window.showMarkdown(text), reply);
  await page.locator('.math[data-tex]').first().waitFor();
  const tex = await page.locator('.math').evaluateAll(boxes => boxes.map(box => [box.className, box.dataset.tex]));
  assert.deepEqual(tex, [
    ['math math-inline', 'W_Q'], ['math math-inline', 'W_K'], ['math math-inline', 'W_V'],
    ['math math-inline', 'x^2'], ['math math-display', 'a+b'],
    ['math math-display', '\\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V'],
    ['math math-display', '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}'],
    ['math math-display', 'e^{i\\pi} + 1 = 0'],
  ]);
  assert.equal(await page.locator('.math .katex').count(), 8);
  // The subscript is drawn as one: MathML for screen readers holds msub.
  assert.equal(await page.locator('.math').first().locator('msub').count(), 1);
  const last = await page.locator('.md p').last().innerText();
  assert.equal(last, 'It costs $5 and $10, or $5-$10. Code stays: $x$. Escaped: $y$.');
  assert.equal(await page.locator('.md p').last().locator('code').innerText(), '$x$');

  // Display math stays inside a phone screen.
  for (const box of await page.locator('.math-display').all()) {
    const { x, width } = await box.boundingBox();
    assert.ok(x >= 0 && x + width <= 390, `math box at ${x}+${width}`);
  }
  if (process.env.HELM_TEST_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.HELM_TEST_ARTIFACT_DIR}/math-phone.png` });

  // Copy gives back the TeX, not the drawn pieces twice.
  await page.evaluate(() => getSelection().selectAllChildren(document.querySelector('.md p')));
  const copied = await page.evaluate(() => window.copySelected().text);
  assert.equal(copied, 'Only $W_Q$, $W_K$ and $W_V$ learn. Also $x^2$ and $$a+b$$ inline.');
  assert.deepEqual(errors, []);
});

test('math in a streaming reply is drawn, and broken TeX stays as its source', async t => {
  const { page, errors } = await pageFor(t);
  await page.evaluate(() => window.showMarkdown('Score: $\\frac{a}{b}$ and $\\frac{a$ so far', true));
  await page.locator('.math[data-tex]').nth(1).waitFor();
  assert.equal(await page.locator('.math').first().locator('.katex').count(), 1);
  const broken = page.locator('.math').nth(1);
  assert.equal(await broken.getAttribute('class'), 'math math-inline math-source');
  assert.equal(await broken.innerText(), '\\frac{a');
  assert.deepEqual(errors, []);
});

test('TeX cannot add links, pictures or markup', async t => {
  const { page, errors } = await pageFor(t);
  await page.evaluate(() => window.showMarkdown(
    'A $<img src=x onerror="window.hit=1">$ B $\\href{javascript:alert(1)}{x}$ C $\\htmlClass{modal-back}{x}$ D $\\rule{999em}{999em}$'));
  await page.locator('.math[data-tex]').nth(3).waitFor();
  assert.equal(await page.locator('.md img, .md a, .md .modal-back').count(), 0);
  assert.equal(await page.evaluate(() => window.hit), undefined);
  const { width } = await page.locator('.md').boundingBox();
  assert.ok(width <= 390);
  assert.deepEqual(errors, []);
});
