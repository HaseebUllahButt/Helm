import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, files, css;
const reply = 'Remove the entry with:\n\n```bash\nhelm revoke 05d4f2982dc8\n```\n\n**Done**. [Help](https://example.com)\n\n- One\n- Two\n\n| A | B |\n|---|---|\n| 1 | 2 |';
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { Markdown } from './apps/web/src/Markdown';
      const root = createRoot(document.getElementById('root'));
      window.showMarkdown = (text, live = false) => {
        flushSync(() => root.render(<Markdown text={text} live={live} className="prose" />));
        return document.getElementById('root').innerHTML;
      };
      Object.defineProperty(navigator, 'clipboard', { value: {
        writeText: async (text) => { window.copied = text; },
      } });
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

async function pageFor(t, highlighter) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('http://helm-test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/highlight-')) return highlighter(route, files.get(path));
    if (files.has(path)) return route.fulfill({ contentType: 'text/javascript', body: files.get(path) });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/assets/entry.js"></script>' });
  });
  await page.goto('http://helm-test/');
  await page.addStyleTag({ content: css });
  await page.waitForFunction(() => typeof window.showMarkdown === 'function');
  return page;
}

test('missing optional chunk never exposes raw fences, including after opening another reply', async t => {
  let failures = 0;
  const page = await pageFor(t, route => { failures++; return route.fulfill({ status: 404, body: 'expired chunk' }); });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const firstPaint = await page.evaluate(text => window.showMarkdown(text), reply);
  assert.match(firstPaint, /class="codeblock"/);
  assert.doesNotMatch(firstPaint, /```|md raw/);
  await page.waitForFunction(() => document.querySelector('table'));
  assert.equal(await page.locator('.md strong').innerText(), 'Done');
  assert.equal(await page.locator('.md li').count(), 2);
  assert.equal(await page.locator('.md a').getAttribute('href'), 'https://example.com');
  if (process.env.HELM_TEST_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.HELM_TEST_ARTIFACT_DIR}/markdown-phone.png` });
  await page.getByRole('button', { name: 'copy', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copied), 'helm revoke 05d4f2982dc8');
  await page.evaluate(() => window.showMarkdown('Another reply:\n\n```sh\necho readable\n```'));
  assert.equal(await page.locator('pre code').innerText(), 'echo readable');
  assert.ok(failures >= 1);
  assert.deepEqual(errors, []);
  const bounds = await page.locator('.codeblock').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
});

test('a delayed highlighter adds colors without changing layout or clipboard text', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let requested = false;
  const page = await pageFor(t, async (route, body) => {
    requested = true;
    await gate;
    await route.fulfill({ contentType: 'text/javascript', body });
  });
  const text = '```js\nconst answer = 42;\n```';
  const firstPaint = await page.evaluate(text => window.showMarkdown(text), text);
  assert.match(firstPaint, /class="codeblock"/);
  assert.doesNotMatch(firstPaint, /```|hljs-keyword/);
  const before = await page.locator('.codeblock').boundingBox();
  release();
  await page.locator('.hljs-keyword').waitFor();
  assert.equal(requested, true);
  assert.equal(await page.locator('pre code').innerText(), 'const answer = 42;');
  assert.deepEqual(await page.locator('.codeblock').boundingBox(), before);
  await page.getByRole('button', { name: 'copy', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copied), 'const answer = 42;');
});

test('streamed code stays formatted as the fence and final paragraph arrive', async t => {
  const page = await pageFor(t, route => route.fulfill({ status: 404, body: 'unavailable' }));
  const chunks = ['Run:\n\n```bash\nhelm', 'Run:\n\n```bash\nhelm revoke 05d4f2982dc8\n```', 'Run:\n\n```bash\nhelm revoke 05d4f2982dc8\n```\n\nDone.'];
  for (const text of chunks) {
    await page.evaluate(text => window.showMarkdown(text, true), text);
    assert.equal(await page.locator('.codeblock').count(), 1);
    assert.equal(await page.locator('.md.raw').count(), 0);
    assert.doesNotMatch(await page.locator('.md').innerText(), /```/);
  }
  const streaming = await page.locator('.md').innerHTML();
  await page.evaluate(text => window.showMarkdown(text), chunks.at(-1));
  assert.equal(await page.locator('.md').innerHTML(), streaming);
});

test('streaming keeps shorter or different fences inside a code example', async t => {
  const page = await pageFor(t, route => route.fulfill({ status: 404, body: 'unavailable' }));
  for (const [open, inner] of [['````markdown', '```bash'], ['~~~markdown', '```bash']]) {
    const close = open.startsWith('~') ? '~~~' : '````';
    const partial = `Before\n\n${open}\nExample:\n${inner}\n\necho hello`;
    for (const body of [partial, `${partial}\n\`\`\`\n${close}\n\nAfter.`]) {
      await page.evaluate(text => window.showMarkdown(text), body);
      const completed = await page.locator('.md').innerHTML();
      await page.evaluate(text => window.showMarkdown(text, true), body);
      assert.equal(await page.locator('.md').innerHTML(), completed);
    }
  }
});

test('a live reply leaves its finished paragraphs alone while the end grows', async t => {
  const page = await pageFor(t, route => route.fulfill({ status: 404, body: 'unavailable' }));
  const reply = 'First **finished** paragraph.\n\n```sh\necho one\n```\n\n- a\n- b\n\nThe last paragraph keeps growing word by word.';
  await page.evaluate(text => window.showMarkdown(text, true), reply.slice(0, 40));
  // A reader selects a word in the first paragraph while the reply streams.
  await page.evaluate(() => {
    const p = document.querySelector('.md p');
    p.dataset.kept = 'yes';
    const range = document.createRange();
    range.selectNodeContents(p.querySelector('strong'));
    getSelection().addRange(range);
  });
  for (let at = 41; at <= reply.length; at++) {
    await page.evaluate(text => window.showMarkdown(text, true), reply.slice(0, at));
  }
  assert.equal(await page.locator('.md p[data-kept]').count(), 1);
  assert.equal(await page.evaluate(() => String(getSelection())), 'finished');
  const streaming = await page.locator('.md').innerHTML();
  await page.evaluate(text => window.showMarkdown(text), reply);
  assert.equal(await page.locator('.md').innerHTML(), streaming.replace(' data-kept="yes"', ''));
});
