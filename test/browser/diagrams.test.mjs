import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A ```mermaid block in a finished reply becomes a diagram (diagrams.ts).
let browser, files, css;
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
