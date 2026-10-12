import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A to-do update is an ordinary step - "Updated the to-do list (2/5)" - that
// opens to the checklist as it stood. (The live checklist itself sits above
// the composer; the chat just keeps the history.)
let browser, page;
const shot = async (name) => { await page.waitForTimeout(700); if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, name) }); };
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Transcript } from './apps/web/src/session/Transcript';
    const root = createRoot(document.getElementById('root'));
    const t0 = 1_790_000_000_000;
    const step = (id, extra) => ({ id, text: '', status: 'ok', startedAt: t0, doneAt: t0 + 1000, ...extra });
    const todo = (id, list) => step(id, { kind: 'tool', name: 'TodoWrite', input: { todos: list.map(([content, status, activeForm]) => ({ content, status, activeForm })) } });
    const first = todo('w1', [
      ['Read the settings page', 'in_progress', 'Reading the settings page'],
      ['Add the dark switch', 'pending', 'Adding the dark switch'],
      ['Run the tests', 'pending', 'Running tests'],
      ['Update the docs', 'pending'],
      ['Ship it', 'pending'],
    ]);
    const second = todo('w2', [
      ['Read the settings page', 'completed'],
      ['Add the dark switch', 'completed'],
      ['Run the tests', 'in_progress', 'Running tests'],
      ['Update the docs', 'pending'],
      ['Ship it', 'pending'],
    ]);
    const read = step('r', { kind: 'tool', name: 'Read', input: { file_path: '/repo/a.ts' }, output: 'x' });
    const partial = { ...second, id: 'w3', input: undefined, inputJson: '{"todos":[{"content":"Wri', status: 'streaming' };
    const run = (items, live = true) => root.render(<Transcript status={live ? 'working' : 'idle'} loaded turns={[
      { id: 't1', text: 'Add a dark switch', at: t0, items, ...(live ? {} : { done: { status: 'ok' } }) },
    ]} />);
    window.renderTodos = (which, live) => run({ one: [first], two: [first, read, second], streaming: [first, partial] }[which], live);
    window.renderPlan = () => run([
      step('p', { kind: 'tool', name: 'plan', output: '☑ Inspect the repo\\n▸ Write the fix\\n☐ Check the tests' }),
      step('q', { kind: 'text', text: 'On it.' }),
    ], false);
    window.reset = () => root.render(<div />);
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

const rows = () => page.locator('.todo').evaluateAll((els) => els.map((e) => [e.className.split(' ')[1], e.querySelector('.todo-text').textContent]));
const labels = () => page.locator('.work.live .step .alabel').allInnerTexts().then((l) => l.map((t) => t.trim()));

test('a to-do update is one plain step, not a card; opening it shows the checklist', async () => {
  await page.evaluate(() => window.renderTodos('one', true));
  await page.locator('.step').waitFor();
  assert.deepEqual(await labels(), ['Updated the to-do list (0/5)']);
  assert.equal(await page.locator('.todos').count(), 0, 'no card until asked for');
  assert.equal(await page.getByText('TodoWrite').count(), 0, 'no grey tool line');
  await page.locator('.step-head').click();
  await page.locator('.todos').waitFor();
  assert.match(await page.locator('.todos-count').innerText(), /0 of 5 done/);
  assert.deepEqual((await rows())[0], ['in_progress', 'Reading the settings page'], 'the row being worked on uses its -ing wording');
});

test('each write is its own step, in order, and each opens to its own list', async () => {
  await page.evaluate(() => { window.reset(); });
  await page.evaluate(() => window.renderTodos('two', true));
  await page.locator('.step').nth(2).waitFor();
  assert.deepEqual(await labels(), ['Updated the to-do list (0/5)', 'Read a.ts', 'Updated the to-do list (2/5)']);
  await page.locator('.step-head').nth(2).click();
  await page.locator('.todo.completed').first().waitFor();
  assert.match(await page.locator('.todos-count').innerText(), /2 of 5 done/);
  assert.equal(await page.locator('.todos-bar').getAttribute('aria-valuenow'), '2');
  assert.deepEqual((await rows()).map((r) => r[0]), ['completed', 'completed', 'in_progress', 'pending', 'pending']);
  assert.equal(await page.locator('.todo.in_progress .todo-text').innerText(), 'Running tests');
  await shot('todos.png');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot('todos-1280.png');
  await page.setViewportSize({ width: 390, height: 844 });
});

test('a list still being written reads as updating, never raw JSON', async () => {
  await page.evaluate(() => window.renderTodos('streaming', true));
  await page.locator('.step').nth(1).waitFor();
  assert.deepEqual(await labels(), ['Updated the to-do list (0/5)', 'Updating the to-do list']);
  assert.equal(await page.getByText('"todos"').count(), 0);
});

test('an ACP plan reads as the same step and the same checklist, folded with the rest', async () => {
  await page.evaluate(() => { window.reset(); window.renderPlan(); });
  await page.locator('.work-head').waitFor();
  await page.getByText('On it.').waitFor();
  await page.locator('.work-head').click();
  await page.locator('details.actgroup summary').filter({ hasText: 'Updated the to-do list (1/3)' }).click();
  assert.match(await page.locator('.todos-count').innerText(), /1 of 3 done/);
  assert.deepEqual(await rows(), [['completed', 'Inspect the repo'], ['in_progress', 'Write the fix'], ['pending', 'Check the tests']]);
  assert.equal(await page.getByText('plan', { exact: true }).count(), 0);
});

test('works in the light theme too', async () => {
  await page.evaluate(() => { window.reset(); document.documentElement.dataset.theme = 'light'; window.renderTodos('two', true); });
  await page.locator('.step').nth(2).waitFor();
  await page.locator('.step-head').nth(2).click();
  await page.locator('.todos').waitFor();
  await shot('todos-light.png');
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
});
