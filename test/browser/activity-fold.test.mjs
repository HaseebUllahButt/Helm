import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// Tool calls, commands and their output, edits and helpers fold into one line
// per stretch of work, so a conversation reads as what was said. Nothing a
// command printed lands on screen until it is asked for.
let browser, page;
const long = Array.from({ length: 40 }, (_, i) => `output line ${i + 1}`).join('\\n');
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Transcript } from './apps/web/src/session/Transcript';
    const root = createRoot(document.getElementById('root'));
    const t0 = 1_790_000_000_000;
    const step = (id, extra) => ({ id, text: '', status: 'ok', startedAt: t0, doneAt: t0 + 1000, ...extra });
    const done = [
      step('a', { kind: 'thinking', text: 'Planning the fix' }),
      step('b', { kind: 'tool', name: 'Read', input: { file_path: '/repo/src/App.tsx' }, output: 'file body' }),
      step('c', { kind: 'command', command: 'npm test', output: '${long}', exitCode: 0 }),
      step('d', { kind: 'command', command: 'grep -rn foo src', output: 'src/a.ts:1: foo', exitCode: 1 }),
      step('e', { kind: 'edit', changes: [{ path: '/repo/src/App.tsx', kind: 'update', diff: '@@ -1 +1 @@\\\\n-old\\\\n+new' }] }),
      step('f', { kind: 'text', text: 'Fixed the bug and the tests pass.' }),
    ];
    window.render = (live) => root.render(<Transcript status={live ? 'working' : 'idle'} loaded turns={[
      { id: 't1', text: 'Fix the bug', at: t0, items: done, done: { status: 'ok', durationMs: 9000 } },
      ...(live ? [{ id: 't2', text: 'Now run it again', at: t0 + 1, items: [
        step('g', { kind: 'tool', name: 'Read', input: { file_path: '/repo/README.md' }, output: 'x' }),
        step('h', { kind: 'command', command: 'npm run build', output: 'building chunk 1\\\\nbuilding chunk 2', status: 'streaming', doneAt: undefined }),
      ] }] : []),
    ]} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent('<div class="main showing" style="height:100vh;width:100%;display:flex;flex-direction:column"><div id="root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});
after(async () => { await browser?.close(); });

test('a finished stretch of work is one closed line that names what happened', async () => {
  await page.evaluate(() => window.render(false));
  const head = page.locator('.activity-head').first();
  await head.waitFor();
  assert.equal(await page.locator('.activity').count(), 1);
  assert.equal(await head.getAttribute('aria-expanded'), 'false');
  const label = (await head.innerText()).replace(/\s+/g, ' ');
  assert.match(label, /Read 1 file · Ran 2 commands · Edited App\.tsx · 1 failed/);
  assert.equal(await page.getByText('output line 1', { exact: true }).count(), 0, 'no command output on screen');
  assert.equal(await page.locator('.cmd').count(), 0, 'no command cards until opened');
  await page.getByText('Fixed the bug and the tests pass.').waitFor();
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, 'activity-closed.png') });
});

test('opening shows each step as a line; a command opens to its output, and both close again', async () => {
  await page.locator('.activity-head').first().click();
  await page.locator('.cmd').first().waitFor();
  assert.equal(await page.locator('.cmd').count(), 2);
  assert.equal(await page.locator('.cmd-out').count(), 0, 'commands stay one line when the group opens');
  await page.locator('.cmd-head').filter({ hasText: 'npm test' }).click();
  await page.getByText('output line 40', { exact: false }).waitFor();
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, 'activity-open.png') });
  await page.locator('.cmd-head').filter({ hasText: 'npm test' }).click();
  await page.locator('.cmd-out').waitFor({ state: 'detached' });
  await page.locator('.activity-head').first().click();
  await page.locator('.cmd').first().waitFor({ state: 'detached' });
});

test('while it works the line says what it is doing now, and stays open if opened', async () => {
  await page.evaluate(() => window.render(true));
  const live = page.locator('.activity.live .activity-head');
  await live.waitFor();
  assert.match((await live.innerText()).replace(/\s+/g, ' '), /Running npm run build · Read 1 file so far/);
  assert.equal(await page.getByText('building chunk 2').count(), 0);
  await live.click();
  await page.getByText('building chunk 2').waitFor();
  await page.evaluate(() => window.render(true));
  assert.equal(await page.locator('.activity.live').getAttribute('class').then((c) => c.includes('open')), true, 'a re-render keeps it open');
});
