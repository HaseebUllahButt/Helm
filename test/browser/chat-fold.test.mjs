import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// The chat reads like a conversation: what the agent did folds into one
// quiet row, the answer stands alone, steps are said in plain words, fine
// print appears on hover, and a pill takes you back to the latest.
let browser, bundle, styles;
const shots = process.env.HELM_TEST_SCREENSHOT_DIR;
before(async () => {
  if (shots) await mkdir(shots, { recursive: true });
  bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Transcript } from './apps/web/src/session/Transcript';
    import { stepWords, commandWords, plainCommand } from './apps/web/src/session/stepWords';
    import { seconds } from './apps/web/src/format';
    Object.assign(window, { stepWords, commandWords, plainCommand, seconds });
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
      claudeSteps: () => [{ id: 't1', text: 'Go', at: t0, items: [
        bash('c1', { description: 'Run the unit tests', command: 'cd /repo && npm test' }),
        bash('c2', { description: 'Install dependencies', command: 'npm install' }, { status: 'error', output: 'ERR' }),
        bash('c3', { command: "bash -lc 'cd /repo && git status --short'" }),
        bash('c4', { description: 'Build the project', command: 'npm run build' }, { status: 'streaming', doneAt: undefined, output: undefined }),
      ] }],
      codexLive: () => {
        const cmd = (id) => step(id, { kind: 'command', command: 'ls ' + id, output: 'x', exitCode: 0 });
        const blank = (id) => step(id, { kind: 'thinking' });
        return [{ id: 't1', text: 'Go', at: t0, items: [
          text('said', 'Checking why copy fails.'),
          cmd('c1'), blank('k1'), cmd('c2'), blank('k2'), cmd('c3'), blank('k3'), cmd('c4'), blank('k4'),
          step('k5', { kind: 'thinking', text: '**Reading the tests**\\n\\nThe copy test runs first.' }),
          cmd('c5'),
          step('k6', { kind: 'thinking', status: 'streaming', doneAt: undefined }),
        ] }];
      },
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

async function pageFor(t, { width = 390, height = 844, touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
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

test('times read like a person says them', async (t) => {
  const page = await pageFor(t);
  const said = await page.evaluate(() => [400, 45_000, 59_600, 60_000, 223_000, 3_599_000, 3_900_000, 7_380_000].map((ms) => window.seconds(ms)));
  assert.deepEqual(said, ['<1s', '45s', '1m 00s', '1m 00s', '3m 43s', '59m 59s', '1h 05m', '2h 03m']);
});

test('steps are said in plain words, in both tenses', async (t) => {
  const page = await pageFor(t);
  const words = await page.evaluate(() => {
    const w = (it) => window.stepWords({ id: 'x', text: '', status: 'ok', startedAt: 1, ...it });
    return {
      described: w({ kind: 'tool', name: 'Bash', input: { description: 'Run the unit tests', command: 'npm test' } }),
      unknownVerb: w({ kind: 'tool', name: 'Bash', input: { description: 'Unit tests for auth', command: 'npm test' } }),
      wrapped: w({ kind: 'tool', name: 'Bash', input: { command: "bash -lc 'cd /repo && git status --short'" } }),
      npm: w({ kind: 'command', command: 'npm run build' }),
      ls: w({ kind: 'command', command: 'ls -la src/' }),
      cat: w({ kind: 'command', command: 'cat src/app.ts' }),
      grep: w({ kind: 'command', command: 'rg -n "TODO" src' }),
      read: w({ kind: 'command', command: "bash -lc \"sed -n '1,40p' src/app.ts\"", actions: [{ type: 'read', name: 'app.ts', path: '/r/src/app.ts' }] }),
      reads: w({ kind: 'command', command: 'cat a b', actions: [{ type: 'read', name: 'a.ts' }, { type: 'read', name: 'b.ts' }] }),
      search: w({ kind: 'command', command: 'rg flaky', actions: [{ type: 'search', query: 'flaky', path: '/r/test' }] }),
      list: w({ kind: 'command', command: 'ls src', actions: [{ type: 'listFiles', path: '/r/src' }] }),
      readTool: w({ kind: 'tool', name: 'Read', input: { file_path: '/repo/src/App.tsx' } }),
      grepTool: w({ kind: 'tool', name: 'Grep', input: { pattern: 'useTheme' } }),
      web: w({ kind: 'tool', name: 'WebFetch', input: { url: 'https://example.com/a/b' } }),
      edit: w({ kind: 'tool', name: 'Edit', input: { file_path: '/repo/src/App.tsx', old_string: 'a', new_string: 'b' } }),
      write: w({ kind: 'tool', name: 'Write', input: { file_path: '/repo/src/New.ts', content: 'x' } }),
      thought: w({ kind: 'thinking', startedAt: 1000, doneAt: 9000 }),
      todo: w({ kind: 'tool', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] } }),
      other: w({ kind: 'tool', name: 'mcp__github__create_issue', input: { title: 'Bug' } }),
      loop: window.commandWords('for m in a b; do echo $m; done'),
    };
  });
  assert.deepEqual(words.described, { now: 'Running the unit tests', past: 'Ran the unit tests' });
  assert.deepEqual(words.unknownVerb, { now: 'Unit tests for auth', past: 'Unit tests for auth' });
  assert.deepEqual(words.wrapped, { now: 'Running git status', past: 'Ran git status' }, 'bash -lc and cd are stripped');
  assert.deepEqual(words.npm, { now: 'Running npm run build', past: 'Ran npm run build' });
  assert.equal(words.ls.past, 'Listed src/');
  assert.equal(words.loop.past, 'Ran a script', 'a loop is not a program called "for"');
  assert.equal(words.cat.past, 'Read app.ts');
  assert.equal(words.grep.past, 'Searched for TODO');
  assert.deepEqual(words.read, { now: 'Reading app.ts', past: 'Read app.ts' });
  assert.equal(words.reads.past, 'Read 2 files');
  assert.equal(words.search.past, 'Searched for flaky in test/');
  assert.equal(words.list.past, 'Listed src/');
  assert.equal(words.readTool.past, 'Read App.tsx');
  assert.equal(words.grepTool.past, 'Searched for useTheme');
  assert.equal(words.web.past, 'Loaded example.com');
  assert.deepEqual(words.edit, { now: 'Editing App.tsx', past: 'Edited App.tsx' });
  assert.equal(words.write.past, 'Created New.ts');
  assert.equal(words.thought.past, 'Thought for 8s');
  assert.equal(words.todo.past, 'Updated the to-do list (1/2)');
  assert.equal(words.other.past, 'Used create issue');
});

test('a running turn shows Claude steps in plain words; failed ones get a red x, the running one shines', async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => window.show('claudeSteps', 'working'));
  await page.locator('.work.live .step').nth(2).waitFor();
  assert.deepEqual((await page.locator('.work.live .step .alabel').allInnerTexts()).map((x) => x.trim()), ['Installed dependencies', 'Ran git status', 'Building the project']);
  assert.equal(await page.locator('.step.bad .step-x').count(), 1);
  assert.equal(await page.locator('.step:not(.bad) .step-x').count(), 0);
  assert.equal(await page.locator('.step .alabel.shine').count(), 1);
  assert.equal(await page.locator('.steps-earlier').innerText(), '+1 earlier step');
  await page.locator('.step-head').filter({ hasText: 'Ran git status' }).click();
  assert.match(await page.locator('.step-cmd').innerText(), /^bash -lc/, 'the raw command is kept for the expanded view');
  if (shots) await page.screenshot({ path: join(shots, 'chat-fold-running.png') });
});

test('a busy Codex keeps its last words on screen; blank thoughts are not steps', async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => window.show('codexLive', 'working'));
  await page.locator('.work.live .step').nth(2).waitFor();
  assert.equal(await page.locator('.work.live .prose').innerText(), 'Checking why copy fails.');
  assert.deepEqual((await page.locator('.work.live .step .alabel').allInnerTexts()).map((x) => x.trim()), ['Reading the tests', 'Listed c5/', 'Thinking']);
  assert.equal(await page.locator('.steps-earlier').innerText(), '+4 earlier steps');
  await page.locator('.step-head').filter({ hasText: 'Reading the tests' }).click();
  assert.equal(await page.locator('.think-body').innerText(), 'Reading the tests\n\nThe copy test runs first.');
  if (shots) await page.screenshot({ path: join(shots, 'chat-fold-codex-live.png') });
});

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
  // A Claude edit carries its diff inline and counts in the card.
  await page.locator('.edit .idiff-row.add').first().waitFor();
  assert.equal(await page.locator('.tf-title').innerText(), '1 changed file');
  assert.equal((await page.locator('.tf-head .tf-counts').innerText()).replace(/\s+/g, ' '), '+2 −1');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
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

test('fine print shows on hover with a mouse, and always on a touch screen', async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => window.show('folded'));
  const meta = page.locator('.final-meta');
  await meta.waitFor();
  const opacity = () => meta.evaluate((el) => getComputedStyle(el).opacity);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  assert.equal(await opacity(), '0');
  await page.locator('.final').hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.final-meta')).opacity === '1');
  // The user bubble's time works the same way.
  const bubbleMeta = page.locator('.turn.user .bubble-meta').first();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  assert.equal(await bubbleMeta.evaluate((el) => getComputedStyle(el).opacity), '0');
  await page.locator('.turn.user .bubble').first().hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.turn.user .bubble-meta')).opacity === '1');
  const touch = await pageFor(t, { touch: true });
  await touch.evaluate(() => window.show('folded'));
  await touch.locator('.final-meta').waitFor();
  assert.equal(await touch.locator('.final-meta').evaluate((el) => getComputedStyle(el).opacity), '1');
  assert.equal(await touch.locator('.bubble-meta').first().evaluate((el) => getComputedStyle(el).opacity), '1');
  if (shots) await touch.screenshot({ path: join(shots, 'chat-fold-touch.png') });
});

test('the copy button puts the answer on the clipboard', async (t) => {
  const page = await pageFor(t);
  // A plain http test page has no clipboard, so stand one in.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { window.copied = text; } }, configurable: true }));
  await page.evaluate(() => window.show('folded'));
  await page.locator('.final').hover();
  await page.locator('.copy-answer').click();
  assert.equal(await page.evaluate(() => window.copied), 'All fixed.');
  await page.locator('.copy-answer[aria-label="Copied"]').waitFor();
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
  assert.equal((await pill.innerText()).trim(), 'Latest');
  const [pillBox, chatBox] = await Promise.all([pill.boundingBox(), page.locator('.chat-wrap').boundingBox()]);
  assert.ok(Math.abs(pillBox.x + pillBox.width / 2 - (chatBox.x + chatBox.width / 2)) < 2, 'centred');
  assert.ok(pillBox.y + pillBox.height <= chatBox.y + chatBox.height, 'above the composer, inside the chat');
  if (shots) await page.screenshot({ path: join(shots, 'chat-fold-latest.png') });
  await pill.click();
  await page.locator('.jump').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.chat').evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), true);
});
