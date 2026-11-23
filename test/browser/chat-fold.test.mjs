import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// The chat reads like a conversation: what the agent did folds into one
// quiet row, the answer stands alone, and a pill takes you back to the latest.
let browser, bundle, styles;
const shots = process.env.HELM_TEST_SCREENSHOT_DIR;
before(async () => {
  if (shots) await mkdir(shots, { recursive: true });
  bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Transcript } from './apps/web/src/session/Transcript';
    const root = createRoot(document.getElementById('root'));
    const t0 = 1_790_000_000_000;
    const step = (id, extra) => ({ id, text: '', status: 'ok', startedAt: t0, doneAt: t0 + 1000, ...extra });
    const text = (id, t) => step(id, { kind: 'text', text: t });
    const bash = (id, input, extra) => step(id, { kind: 'tool', name: 'Bash', input, output: 'out', ...extra });
    const scenes = {
      folded: () => [{ id: 't1', text: 'Fix it', at: t0, done: { status: 'ok', durationMs: 521000, costUsd: 0.18 }, items: [
        text('n1', 'First I will look around.'),
        step('r1', { kind: 'tool', name: 'Read', input: { file_path: '/repo/a.ts' }, output: 'x' }),
        text('n2', 'Found it. Fixing now.'),
        step('e1', { kind: 'tool', name: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;\\nconst b = 3;' } }),
        bash('b1', { description: 'Run the tests', command: 'npm test' }),
        text('final', 'All fixed.'),
      ] }],
      helperAfter: () => [{ id: 't1', text: 'Check it', at: t0, done: { status: 'ok', durationMs: 96000 }, items: [
        step('r1', { kind: 'tool', name: 'Read', input: { file_path: '/repo/a.ts' }, output: 'x' }),
        text('said', 'Everything checks out.'),
        step('h1', { kind: 'subagent', name: 'Agent', input: { description: 'Look around' }, agent: { status: 'completed' } }),
      ] }],
      wordsTrimmed: () => [{ id: 't1', text: 'Do it all', at: t0, done: { status: 'ok', durationMs: 96000 }, items: [
        step('h1', { kind: 'subagent', name: 'Agent', input: { description: 'Rework the sidebar' }, agent: { status: 'completed' } }),
      ] }],
      onlyText: () => [{ id: 't1', text: 'Hello', at: t0, done: { status: 'ok', durationMs: 2000 }, items: [text('x', 'Hi there.')] }],
      failed: () => [{ id: 't1', text: 'Go', at: t0, done: { status: 'error', error: 'boom' }, items: [
        step('r1', { kind: 'tool', name: 'Read', input: { file_path: '/repo/a.ts' }, output: 'x' }),
        step('err', { kind: 'error', text: 'The model is overloaded' }),
      ] }],
      long: () => {
        const turns = [];
        for (let i = 0; i < 14; i += 1) turns.push({ id: 'p' + i, text: 'Question ' + i, at: t0 + i * 10, done: { status: 'ok' }, items: [text('a' + i, 'Answer number ' + i + '. '.repeat(30))] });
        return turns;
      },
    };
    window.show = (name, status = 'idle') => root.render(<Transcript status={status} loaded turns={scenes[name]()} onBranch={() => {}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  styles = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => { await browser?.close(); });

async function pageFor(t, { width = 390, height = 844 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.on('pageerror', (error) => t.diagnostic(error.stack));
  await page.route('http://helm.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('http://helm.test/');
  await page.setContent('<div class="main showing" style="height:100vh;width:100%;display:flex;flex-direction:column"><div id="root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

test('the fold holds the narration too; only the last words stay out as the answer', async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => window.show('folded'));
  await page.locator('.work-head').waitFor();
  assert.equal((await page.locator('.final').innerText()).trim(), 'All fixed.');
  assert.equal(await page.getByText('First I will look around.').count(), 0, 'narration is folded away');
  await page.locator('.work-head').click();
  await page.getByText('First I will look around.').waitFor();
  const order = await page.locator('.steps-body .prose, .steps-body .act, .steps-body .edits, .steps-body .actgroup').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim().slice(0, 24)));
  assert.match(order[0], /First I will look/);
  assert.ok(order.some((x) => /Found it/.test(x)));
});

test("a terminal chat that files a helper after the reply still shows the reply below the fold", async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => window.show('helperAfter'));
  await page.locator('.work-head').waitFor();
  assert.equal((await page.locator('.final').innerText()).trim(), 'Everything checks out.');
});

test('an old turn that lost its words shows its helpers, not an empty fold', async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => window.show('wordsTrimmed'));
  await page.getByText('Rework the sidebar').first().waitFor();
  assert.equal(await page.locator('.work-head').count(), 0);
});

test('a turn that is only words has no divider; an error stays outside the fold', async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => window.show('onlyText'));
  await page.locator('.final').waitFor();
  assert.equal(await page.locator('.work-head').count(), 0);
  await page.evaluate(() => window.show('failed'));
  await page.locator('.errline').waitFor();
  assert.equal(await page.locator('.work .errline').count(), 0, 'the error is not inside the fold');
  assert.match(await page.locator('.work-head').innerText(), /^Worked/);
});

test('a "Latest" pill appears when you are away from the end, and takes you back', async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => window.show('long'));
  await page.locator('.chat').waitFor();
  await page.waitForFunction(() => { const c = document.querySelector('.chat'); return c.scrollHeight > c.clientHeight && c.scrollTop + c.clientHeight >= c.scrollHeight - 2; });
  assert.equal(await page.locator('.jump').count(), 0, 'at the end there is nothing to jump to');
  await page.locator('.chat').evaluate((el) => { el.scrollTop = 0; });
  const pill = page.locator('.jump');
  await pill.waitFor();
  const [pillBox, chatBox] = await Promise.all([pill.boundingBox(), page.locator('.chat-wrap').boundingBox()]);
  assert.ok(pillBox.y + pillBox.height <= chatBox.y + chatBox.height, 'above the composer, inside the chat');
  if (shots) await page.screenshot({ path: join(shots, 'chat-fold-latest.png') });
  await pill.click();
  await page.locator('.jump').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.chat').evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), true);
});
