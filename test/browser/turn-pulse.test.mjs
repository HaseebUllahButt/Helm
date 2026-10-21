import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A working turn says how long it has worked and shows its newest steps; a
// finished one ends in a changed-files card and a quiet line of fine print.
let browser, page;
const shots = process.env.HELM_TEST_SCREENSHOT_DIR;
before(async () => {
  if (shots) await mkdir(shots, { recursive: true });
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Transcript } from './apps/web/src/session/Transcript';
    import { verbAt } from './apps/web/src/session/TurnPulse';
    window.verbAt = verbAt;
    const root = createRoot(document.getElementById('root'));
    const t0 = 1_790_000_000_000;
    const step = (id, extra) => ({ id, text: '', status: 'ok', startedAt: t0, doneAt: t0 + 1000, ...extra });
    const edit = (id, path) => step(id, { kind: 'edit', changes: [{ path, kind: 'update', diff: '@@ -1 +1 @@\\n-old\\n+new' }] });
    const finished = (items, done = { status: 'ok', durationMs: 42000, costUsd: 0.02 }) => ({ id: 't1', text: 'Fix the bug', at: t0, items: [
      ...items, step('z', { kind: 'text', text: 'All fixed.' }),
    ], done });
    window.renderTurn = (turn, status = 'idle') => root.render(<Transcript status={status} loaded turns={[turn]} />);
    window.renderWorking = (blocked) => root.render(<Transcript status={blocked ? 'blocked' : 'working'} loaded turns={[
      { id: 'w1', text: 'Add a retry', at: Date.now() - 42_000, items: [
        step('r', { kind: 'tool', name: 'Read', input: { file_path: '/repo/a.ts' }, output: 'x' }),
      ] },
    ]} />);
    window.passing = () => window.renderTurn(finished([
      edit('e1', '/repo/src/App.tsx'),
      edit('e2', '/repo/src/util/format.ts'),
      edit('e3', '/repo/src/App.tsx'),
      step('c', { kind: 'command', command: 'npm test', output: 'ok', exitCode: 0 }),
    ]));
    window.failing = () => window.renderTurn(finished([
      edit('e1', '/repo/src/App.tsx'),
      step('c1', { kind: 'command', command: 'npm test', output: 'ok', exitCode: 0 }),
      step('c2', { kind: 'command', command: 'pnpm vitest run', output: 'boom', exitCode: 1 }),
    ]));
    window.many = () => window.renderTurn(finished(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => edit('m' + n, '/repo/src/' + n + '.ts')),
    ));
    window.plain = () => window.renderTurn(finished([step('g', { kind: 'command', command: 'ls', output: 'x', exitCode: 1 })]));
    window.stopped = () => window.renderTurn(finished([edit('e1', '/repo/a.ts')], { status: 'interrupted' }));
    window.stoppedBare = () => window.renderTurn({ id: 't1', text: 'Fix the bug', at: t0, items: [], done: { status: 'interrupted' } });
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('http://helm.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('http://helm.test/');
  await page.setContent('<div class="main showing" style="height:100vh;width:100%;display:flex;flex-direction:column"><div id="root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});
after(async () => { await browser?.close(); });

const shot = (name) => shots && page.screenshot({ path: join(shots, name) });

test('a working turn says how long it has worked, with a verb, and no bare "Working…"', async () => {
  await page.evaluate(() => window.renderWorking(false));
  const line = page.locator('.working');
  await line.waitFor();
  const text = (await line.innerText()).replace(/\s+/g, ' ');
  assert.match(text, /^Working for 4\ds [A-Z][a-z' ]+…$/);
  assert.doesNotMatch(text, /^Working…/);
  assert.equal(await line.locator('.pulse-dot').count(), 1);
  const before = Number((await line.locator('.working-time').innerText()).replace('s', ''));
  await page.waitForFunction((n) => Number(document.querySelector('.working-time').textContent.replace('s', '')) > n, before, { timeout: 4000 });
  await shot('turn-pulse-working.png');
});

test('the status uses plain words throughout the turn', async () => {
  const seq = await page.evaluate(() => [0, 4, 5, 9, 10, 100].map((s) => window.verbAt('w1', s)));
  assert.equal(seq[0], seq[1], 'steady within a few seconds');
  assert.equal(seq[2], seq[3]);
  assert.ok(seq.every((label) => label === 'Working'));
  const all = await page.evaluate(() => new Set(Array.from({ length: 20 }, (_, i) => window.verbAt('w1', i * 5))).size);
  assert.equal(all, 1, 'keeps the same clear status');
});

test('blocked on you still says so', async () => {
  await page.evaluate(() => window.renderWorking(true));
  assert.equal((await page.locator('.working').innerText()).trim(), 'Waiting for you');
});

test('a finished reply ends in a changed-files card, then fine print with the cost and tests', async () => {
  await page.evaluate(() => window.passing());
  const card = page.locator('.tf');
  await card.waitFor();
  assert.equal((await card.locator('.tf-title').innerText()).trim(), '2 changed files');
  assert.equal((await card.locator('.tf-head .tf-counts').innerText()).replace(/\s+/g, ' ').trim(), '+3 −3', 'the sum of the turn\'s edits');
  const rows = await card.locator('.tf-list li').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(rows, ['App.tsx +2 −2', 'format.ts +1 −1']);
  assert.equal(await card.locator('.tf-list li').first().getAttribute('title'), '/repo/src/App.tsx');
  const meta = page.locator('.final-meta');
  assert.match((await meta.innerText()).replace(/\s+/g, ' '), /\$0\.02 tests passed/);
  assert.equal(await page.locator('.work-head').innerText().then((t) => t.trim()), 'Worked for 42s');
  await shot('turn-pulse-done.png');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot('turn-pulse-done-wide.png');
  await page.setViewportSize({ width: 390, height: 844 });
});

test('"Open diff" opens the folded work and shows the first edit', async () => {
  assert.equal(await page.locator('[data-item-id="e1"]').count(), 0, 'folded to begin with');
  await page.locator('.tf-open').click();
  const edit = page.locator('[data-item-id="e1"]');
  await edit.waitFor();
  assert.equal(await page.locator('.work-head').first().getAttribute('aria-expanded'), 'true');
  assert.equal(await edit.isVisible(), true);
  assert.equal(await edit.evaluate((el) => document.activeElement === el), true, 'the step is focused');
  // The same button works again after the fold is closed by hand.
  await page.locator('.work-head').first().click();
  await edit.waitFor({ state: 'detached' });
  await page.locator('.tf-open').click();
  await edit.waitFor();
  await shot('turn-pulse-revealed.png');
});

test('the last test run decides pass or fail', async () => {
  await page.evaluate(() => window.failing());
  await page.locator('.final-meta').waitFor();
  assert.equal((await page.locator('.final-meta').innerText()).replace(/\s+/g, ' ').trim(), '$0.02 tests failed');
  assert.equal(await page.locator('.tf-title').innerText(), '1 changed file');
});

test('no edits leaves no card; more than six files collapse', async () => {
  await page.evaluate(() => window.plain());
  await page.locator('.final-meta').waitFor();
  assert.equal((await page.locator('.final-meta').innerText()).replace(/\s+/g, ' ').trim(), '$0.02');
  assert.equal(await page.locator('.tf').count(), 0);
  await page.evaluate(() => window.many());
  await page.locator('.tf').waitFor();
  assert.equal(await page.locator('.tf-list li:not(.tf-more)').count(), 6);
  assert.equal((await page.locator('.tf-more').innerText()).trim(), '+1 more');
  assert.equal((await page.locator('.tf-title').innerText()).trim(), '7 changed files');
  await shot('turn-pulse-many.png');
});

test('a stopped turn says so on its fold; one with no work keeps its short footer', async () => {
  await page.evaluate(() => window.stopped());
  await page.locator('.work-head').waitFor();
  assert.match((await page.locator('.work-head').innerText()).trim(), /^You stopped after \d+s$/);
  assert.equal(await page.locator('.turn-meta').filter({ hasText: /^stopped$/ }).count(), 0, 'the fold already says it');
  await page.evaluate(() => window.stoppedBare());
  await page.locator('.turn-meta').waitFor();
  assert.equal((await page.locator('.turn-meta').innerText()).trim(), 'stopped');
});
