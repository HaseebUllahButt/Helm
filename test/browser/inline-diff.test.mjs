import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// An edit shows its changed lines in the chat, red and green, without a tap.
// A long one stops after a few lines and offers the rest.
let browser, page;
const shots = process.env.HELM_TEST_SCREENSHOT_DIR;
const shoot = async (name) => { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, name) }); } };

const shortDiff = '@@ -3,5 +3,6 @@\\n import a from "a";\\n-const title = "Old";\\n+const title = "New";\\n+const sub = "Added";\\n export default title;\\n function z() {}';
const longLine = 'const veryLongLine = "' + 'x'.repeat(220) + '";';
const bodyLines = Array.from({ length: 12 }, (_, i) => `-  old ${i + 1}\\n+  new ${i + 1}`).join('\\n');
const longDiff = `diff --git a/src/Big.tsx b/src/Big.tsx\\n--- a/src/Big.tsx\\n+++ b/src/Big.tsx\\n@@ -1,30 +1,30 @@\\n context before\\n${bodyLines}\\n+${longLine}\\n context after\\n@@ -90,3 +90,3 @@\\n-tail old\\n+tail new`;
const newFile = Array.from({ length: 20 }, (_, i) => `line ${i + 1} of the new file`).join('\\n');

before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Transcript } from './apps/web/src/session/Transcript';
    const root = createRoot(document.getElementById('root'));
    const t0 = 1_790_000_000_000;
    const step = (id, extra) => ({ id, text: '', status: 'ok', startedAt: t0, doneAt: t0 + 1000, ...extra });
    const edit = (id, path, kind, diff) => step(id, { kind: 'edit', changes: [{ path, kind, diff }] });
    window.render = () => root.render(<Transcript status="idle" loaded turns={[
      { id: 't1', text: 'Change the titles', at: t0, items: [
        step('a', { kind: 'text', text: 'Updating the title first.' }),
        edit('b', '/repo/src/App.tsx', 'update', '${shortDiff}'),
        step('c', { kind: 'text', text: 'Now the big file.' }),
        edit('d', '/repo/src/Big.tsx', 'update', '${longDiff}'),
        step('e', { kind: 'text', text: 'And a new file.' }),
        edit('f', '/repo/src/New.ts', 'add', '${newFile}'),
        step('g', { kind: 'text', text: 'Done.' }),
      ], done: { status: 'ok', durationMs: 9000 } },
    ]} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('http://helm.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('http://helm.test/');
  await page.setContent('<div class="main showing" style="height:100vh;width:100%;display:flex;flex-direction:column"><div id="root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => window.render());
  // A lone edit between two replies still folds into a step line; open each.
  await page.locator('.activity-head').first().waitFor();
  for (const head of await page.locator('.activity-head').all()) await head.click();
  await page.locator('.edit').first().waitFor();
});
after(async () => { await browser?.close(); });

test('a short edit shows its red and green lines without a tap', async () => {
  const card = page.locator('.edit').filter({ hasText: 'App.tsx' });
  await card.locator('.idiff-row').first().waitFor();
  assert.deepEqual(await card.locator('.idiff-row').evaluateAll((rows) => rows.map((r) => r.className.replace('idiff-row ', ''))),
    ['ctx', 'del', 'add', 'add', 'ctx', 'ctx']);
  assert.match(await card.locator('.idiff-row.del').innerText(), /const title = "Old";/);
  assert.match(await card.locator('.edit summary, summary').first().innerText(), /\+2\s+−1/);
  assert.equal(await card.locator('.idiff-more').count(), 0, 'nothing hidden, so no toggle');
  assert.equal(await card.locator('.idiff-gap').count(), 0);
  const [del, add] = await Promise.all([card.locator('.idiff-row.del'), card.locator('.idiff-row.add').first()].map((l) => l.evaluate((e) => getComputedStyle(e).backgroundColor)));
  assert.notEqual(del, add, 'removed and added lines read as different colours');
  assert.notEqual(del, 'rgba(0, 0, 0, 0)');
  assert.doesNotMatch(await card.innerText(), /@@|diff --git|^---|^\+\+\+/m);
});

test('a long edit stops after a few lines, drops the file header, and Show all expands it', async () => {
  const card = page.locator('.edit').filter({ hasText: 'Big.tsx' });
  await card.scrollIntoViewIfNeeded();
  const lines = () => card.locator('.idiff-row').count();
  assert.equal(await lines(), 9, 'one line of context, then eight changed lines');
  assert.equal(await card.locator('.idiff-row.add, .idiff-row.del').count(), 8);
  assert.doesNotMatch(await card.innerText(), /diff --git|a\/src|@@/);
  const more = card.locator('.idiff-more');
  assert.match(await more.innerText(), /Show all 29 lines/);
  await shoot('inline-diff.png');
  await more.click();
  assert.equal(await lines(), 29);
  assert.equal(await card.locator('.idiff-gap').count(), 1, 'the second hunk is a thin separator, not raw text');
  assert.match(await more.innerText(), /Show fewer/);
  await more.click();
  assert.equal(await lines(), 9);
  // The header collapses the whole card.
  await card.locator('summary').click();
  await card.locator('.idiff').waitFor({ state: 'hidden' });
  await card.locator('summary').click();
  await card.locator('.idiff').waitFor({ state: 'visible' });
});

test('a new file shows its first lines as added', async () => {
  const card = page.locator('.edit').filter({ hasText: 'New.ts' });
  await card.scrollIntoViewIfNeeded();
  assert.equal(await card.locator('.idiff-row.add').count(), 8);
  assert.equal(await card.locator('.idiff-row.del').count(), 0);
  assert.match(await card.innerText(), /Create/);
  assert.match(await card.locator('.idiff-more').innerText(), /Show all 20 lines/);
});

test('long lines scroll inside the diff, never the page', async () => {
  const card = page.locator('.edit').filter({ hasText: 'Big.tsx' });
  await card.locator('.idiff-more').click();
  const m = await card.locator('.idiff-box').evaluate((box) => ({
    scrolls: box.scrollWidth > box.clientWidth,
    pageWide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    boxRight: box.getBoundingClientRect().right,
  }));
  assert.equal(m.scrolls, true, 'the box scrolls sideways');
  assert.equal(m.pageWide, false, 'the page does not');
  assert.ok(m.boxRight <= 390);
  // Tinted lines cover the whole scroll width, not just the visible part.
  const full = await card.locator('.idiff-row.add').last().evaluate((r) => r.scrollWidth >= r.parentElement.scrollWidth - 1 && r.getBoundingClientRect().width >= r.parentElement.getBoundingClientRect().width - 1);
  assert.equal(full, true);
  await card.scrollIntoViewIfNeeded();
  await shoot('inline-diff-expanded.png');
  await card.locator('.idiff-more').click();
});

test('it reads well on a wide screen and in the light theme', async () => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.edit').filter({ hasText: 'Big.tsx' }).scrollIntoViewIfNeeded();
  await shoot('inline-diff-1280.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.locator('.edit').filter({ hasText: 'Big.tsx' }).scrollIntoViewIfNeeded();
  await shoot('inline-diff-light.png');
  await page.setViewportSize({ width: 1280, height: 900 });
  await shoot('inline-diff-light-1280.png');
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
});
