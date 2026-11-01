import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A ```mermaid block in a finished reply becomes a diagram (diagrams.ts).
let browser, files, css;
const flow = 'Steps:\n\n```mermaid\nflowchart LR\n  A[Phone] --> B[Hub]\n  B --> C[Machine]\n```\n\nDone.';
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { Markdown } from './apps/web/src/Markdown';
      const root = createRoot(document.getElementById('root'));
      window.showMarkdown = (text, live = false) => {
        flushSync(() => root.render(<Markdown text={text} live={live} />));
      };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.copied = text; } } });
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'esm', splitting: true, jsx: 'automatic',
    outdir: '/helm-test/assets', entryNames: 'entry', chunkNames: '[name]-[hash]',
  });
  files = new Map(bundle.outputFiles.map(file => [file.path.replace('/helm-test', ''), file.text]));
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
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
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/assets/entry.js"></script>' });
  });
  await page.goto('http://helm-test/');
  await page.addStyleTag({ content: css });
  await page.waitForFunction(() => typeof window.showMarkdown === 'function');
  return { page, errors };
}

test('a finished reply draws its mermaid block; Code shows the source and Copy copies it', async t => {
  const { page, errors } = await pageFor(t);
  await page.evaluate(text => window.showMarkdown(text, true), flow);
  // While the reply streams the block stays code, as in T3 Code.
  assert.equal(await page.locator('.diagram-view').count(), 0);
  assert.match(await page.locator('pre code').innerText(), /flowchart LR/);
  await page.evaluate(text => window.showMarkdown(text, false), flow);
  await page.locator('.diagram-view svg').waitFor();
  const labels = await page.locator('.diagram-view svg').textContent();
  for (const word of ['Phone', 'Hub', 'Machine']) assert.match(labels, new RegExp(word));
  assert.equal(await page.locator('.codeblock.diagram pre').isVisible(), false);
  const box = await page.locator('.diagram-view svg').boundingBox();
  assert.ok(box.width > 100 && box.x >= 0 && box.x + box.width <= 390);
  if (process.env.HELM_TEST_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.HELM_TEST_ARTIFACT_DIR}/diagram-phone.png` });

  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  assert.match(await page.evaluate(() => window.copied), /^flowchart LR\n {2}A\[Phone\] --> B\[Hub\]/);
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  assert.equal(await page.locator('.codeblock.diagram pre').isVisible(), true);
  assert.equal(await page.locator('.diagram-view').isVisible(), false);
  await page.getByRole('button', { name: 'Diagram', exact: true }).click();
  assert.equal(await page.locator('.diagram-view').isVisible(), true);

  await page.locator('.diagram-view').click();
  await page.getByRole('dialog', { name: 'Diagram' }).locator('svg').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.deepEqual(errors, []);
});

test('a broken diagram stays readable as code with the reason', async t => {
  const { page, errors } = await pageFor(t);
  await page.evaluate(() => window.showMarkdown('```mermaid\nflowchart LR\n  A --> \n  ((((\n```'));
  await page.locator('.diagram-error').waitFor();
  assert.match(await page.locator('.diagram-error').innerText(), /^Helm cannot draw this diagram/);
  assert.equal(await page.locator('.codeblock.diagram pre').isVisible(), true);
  assert.equal(await page.locator('.diagram-view').count(), 0);
  assert.deepEqual(errors, []);
});

test('a diagram cannot run script, link out or change its look', async t => {
  const { page } = await pageFor(t);
  const evil = '```mermaid\n%%{init: {"securityLevel": "loose", "themeCSS": "svg{display:none}"}}%%\nflowchart LR\n  A["<img src=x onerror=window.hit=1>"] --> B\n  click A "javascript:window.hit=2"\n  click B href "https://example.com"\n```';
  await page.evaluate(text => window.showMarkdown(text), evil);
  await page.locator('.diagram-view svg').waitFor();
  const svg = await page.locator('.diagram-view').innerHTML();
  assert.doesNotMatch(svg, /<script|<img|<a[\s>]|onerror|javascript:|href=/i);
  assert.equal(await page.locator('.diagram-view svg').isVisible(), true);
  await page.locator('.diagram-view').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.hit), undefined);
});
