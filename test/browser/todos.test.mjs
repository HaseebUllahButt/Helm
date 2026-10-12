import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// The agent's to-do list shows as one checklist that ticks itself off in
// place, not as a folded "TodoWrite" step. Only the newest list is drawn.
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
    ]);
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

test('a to-do list is a card, not a folded step, and says how far along it is', async () => {
  await page.evaluate(() => window.renderTodos('one', true));
  await page.locator('.todos').waitFor();
  assert.equal(await page.locator('.todos').count(), 1);
  assert.equal(await page.getByText('TodoWrite').count(), 0, 'no grey tool line');
  assert.equal(await page.locator('.activity').count(), 0);
  assert.match(await page.locator('.todos-count').innerText(), /0 of 5 done/);
  assert.deepEqual((await rows())[0], ['in_progress', 'Reading the settings page'], 'the row being worked on uses its -ing wording');
});

test('a second write updates the same card in place; only the newest list shows', async () => {
  await page.evaluate(() => window.renderTodos('two', true));
  await page.locator('.todo.completed').first().waitFor();
  assert.equal(await page.locator('.todos').count(), 1, 'one card, not one per write');
  assert.match(await page.locator('.todos-count').innerText(), /2 of 5 done/);
  assert.equal(await page.locator('.todos-bar').getAttribute('aria-valuenow'), '2');
  assert.deepEqual((await rows()).map((r) => r[0]), ['completed', 'completed', 'in_progress', 'pending', 'pending']);
  assert.equal(await page.locator('.todo.ticked').count(), 2, 'rows that just finished tick in');
  assert.equal(await page.locator('.todo.in_progress .todo-text').innerText(), 'Running tests');
  await shot('todos.png');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot('todos-1280.png');
  await page.setViewportSize({ width: 390, height: 844 });
});

test('a list still being written leaves the last good one on screen', async () => {
  await page.evaluate(() => window.renderTodos('streaming', true));
  await page.locator('.todos').waitFor();
  assert.equal(await page.locator('.todos').count(), 1);
  assert.match(await page.locator('.todos-count').innerText(), /0 of 5 done/);
});

test('an ACP plan reads as the same checklist', async () => {
  await page.evaluate(() => window.renderPlan());
  await page.getByText('On it.').waitFor();
  assert.match(await page.locator('.todos-count').innerText(), /1 of 3 done/);
  assert.deepEqual(await rows(), [['completed', 'Inspect the repo'], ['in_progress', 'Write the fix'], ['pending', 'Check the tests']]);
  assert.equal(await page.getByText('plan', { exact: true }).count(), 0);
});

test('works in the light theme too', async () => {
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; window.renderTodos('two', false); });
  await page.locator('.todos').waitFor();
  await shot('todos-light.png');
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
});
