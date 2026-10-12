import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A working turn shows a changing verb and a ticking clock; a finished one
// ends in a one-line wrap-up with a chip per changed file.
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
    const edit = (id, path) => step(id, { kind: 'edit', changes: [{ path, kind: 'update', diff: '@@ -1 +1 @@\\\\n-old\\\\n+new' }] });
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

test('a working turn shows a verb and a seconds counter, and no bare "Working…"', async () => {
  await page.evaluate(() => window.renderWorking(false));
  const line = page.locator('.working');
  await line.waitFor();
  const text = (await line.innerText()).replace(/\s+/g, ' ');
  assert.match(text, /^[A-Z][a-z' ]+… 4\ds$/);
  assert.doesNotMatch(text, /^Working…/);
  assert.equal(await line.locator('.pulse-dot').count(), 1);
  const before = Number((await line.locator('.working-time').innerText()).replace('s', ''));
  await page.waitForFunction((n) => Number(document.querySelector('.working-time').textContent.replace('s', '')) > n, before, { timeout: 4000 });
  await shot('turn-pulse-working.png');
});

test('the verb is steady for a turn and changes every few seconds', async () => {
  const seq = await page.evaluate(() => [0, 4, 5, 9, 10, 100].map((s) => window.verbAt('w1', s)));
  assert.equal(seq[0], seq[1], 'steady within a few seconds');
  assert.equal(seq[2], seq[3]);
  assert.notEqual(seq[0], seq[2]);
  assert.notEqual(seq[2], seq[4]);
  const all = await page.evaluate(() => new Set(Array.from({ length: 20 }, (_, i) => window.verbAt('w1', i * 5))).size);
  assert.equal(all, 20, 'walks every verb before repeating');
});

test('blocked on you still says so', async () => {
  await page.evaluate(() => window.renderWorking(true));
  assert.equal((await page.locator('.working').innerText()).trim(), 'Waiting for you');
});

test('a finished reply ends in a wrap-up with the files it changed and the tests', async () => {
  await page.evaluate(() => window.passing());
  const meta = page.locator('.turn-meta');
  await meta.waitFor();
  assert.equal((await meta.locator('> span').innerText()).trim(), 'Done in 42s · 2 files changed · tests passed · $0.02');
  const chips = page.locator('.wrapup-chip');
  assert.deepEqual(await chips.allInnerTexts(), ['App.tsx', 'format.ts']);
  assert.equal(await chips.first().getAttribute('title'), '/repo/src/App.tsx');
  await shot('turn-pulse-done.png');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot('turn-pulse-done-wide.png');
  await page.setViewportSize({ width: 390, height: 844 });
});

test('tapping a chip opens the folded work and shows that edit', async () => {
  assert.equal(await page.locator('[data-item-id="e2"]').count(), 0, 'folded to begin with');
  await page.locator('.wrapup-chip', { hasText: 'format.ts' }).click();
  const edit = page.locator('[data-item-id="e2"]');
  await edit.waitFor();
  assert.equal(await page.locator('.activity-head').first().getAttribute('aria-expanded'), 'true');
  assert.equal(await edit.isVisible(), true);
  assert.equal(await edit.evaluate((el) => document.activeElement === el), true, 'the step is focused');
  // The same chip works again after the group is closed by hand.
  await page.locator('.activity-head').first().click();
  await edit.waitFor({ state: 'detached' });
  await page.locator('.wrapup-chip', { hasText: 'format.ts' }).click();
  await edit.waitFor();
  await shot('turn-pulse-revealed.png');
});

test('the last test run decides pass or fail', async () => {
  await page.evaluate(() => window.failing());
  await page.locator('.turn-meta').waitFor();
  assert.equal((await page.locator('.turn-meta > span').innerText()).trim(), 'Done in 42s · 1 file changed · tests failed · $0.02');
});

test('no edits and no test run leaves just the time and cost; more than five files collapse', async () => {
  await page.evaluate(() => window.plain());
  await page.locator('.turn-meta').waitFor();
  assert.equal((await page.locator('.turn-meta').innerText()).trim(), 'Done in 42s · $0.02');
  assert.equal(await page.locator('.wrapup-chip').count(), 0);
  await page.evaluate(() => window.many());
  await page.locator('.wrapup-chip').first().waitFor();
  assert.equal(await page.locator('.wrapup-chip').count(), 5);
  assert.equal((await page.locator('.wrapup-more').innerText()).trim(), '+2 more');
  await shot('turn-pulse-many.png');
});

test('a stopped turn keeps its short footer', async () => {
  await page.evaluate(() => window.stopped());
  await page.locator('.turn-meta').waitFor();
  assert.equal((await page.locator('.turn-meta').innerText()).trim(), 'stopped');
});
