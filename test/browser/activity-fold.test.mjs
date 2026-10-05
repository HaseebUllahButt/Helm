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
    window.renderHistory = (text, attachments = []) => root.render(<Transcript status="idle" loaded turns={[
      { id: 'saved-reply', text, at: t0, attachments, items: [], done: { status: 'ok' } },
      { id: 'saved-tool', text: '', at: t0 + 1, attachments: [], items: [
        step('saved-read', { kind: 'tool', name: 'Read', input: { file_path: '/repo/app.ts' } }),
      ], done: { status: 'ok' } },
    ]} />);
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

test('completed imported question replies display their answers, including from a saved cache', async () => {
  const text = `<send_user_message_question_reply>\n${JSON.stringify([
    { answer: 'Before today’s Fable change only', question: 'Which rollback point do you mean?', questionItemId: '["internal","call-id",0]' },
    { answer: 'Keep my chats', question: 'What should be preserved?' },
  ])}\n</send_user_message_question_reply>`;
  await page.evaluate((text) => {
    localStorage.setItem('saved-test-reply', JSON.stringify({ text }));
    window.renderHistory(JSON.parse(localStorage.getItem('saved-test-reply')).text);
  }, text);
  await page.getByText('Before today’s Fable change only', { exact: false }).waitFor();
  const bubble = await page.locator('.turn.user .bubble').innerText();
  assert.match(bubble, /Before today’s Fable change only\s+Keep my chats/);
  assert.doesNotMatch(bubble, /send_user_message_question_reply|questionItemId|call-id/);
  assert.equal(await page.locator('.turn.user').count(), 1, 'tool-only turns do not render empty bubbles');
  assert.equal(await page.locator('#root').evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent === '0') return true;
    return false;
  }), false, 'empty attachment arrays do not print a stray zero');
});

test('ordinary messages and unfamiliar reply records remain readable', async () => {
  for (const text of [
    'I wrote <send_user_message_question_reply> in my notes.',
    '<send_user_message_question_reply>broken JSON</send_user_message_question_reply>',
    '<send_user_message_question_reply>[{"answer":42}]</send_user_message_question_reply>',
    '<send_user_message_question_reply>[]</send_user_message_question_reply>',
  ]) {
    await page.evaluate((text) => window.renderHistory(text), text);
    await page.getByText(text, { exact: false }).waitFor();
    assert.ok((await page.locator('.turn.user .bubble').innerText()).includes(text));
  }
});

test('old image envelopes become image previews and keep their caption and zoom', async () => {
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5fsAAAAASUVORK5CYII=';
  const text = '<image name=[Image #1] path="/tmp/old-image.png">\n</image>\n[Image #1] Why is this broken?';
  await page.evaluate((text) => window.renderHistory(text), text);
  await page.locator('.turn-image-gone').waitFor();
  assert.doesNotMatch(await page.locator('.bubble').innerText(), /<image|\/tmp\/|\[Image #1\]/);
  await page.evaluate(({ text, data }) => window.renderHistory(text, [{ filename: 'old-image.png', mime: 'image/png', data }]), { text, data });
  const image = page.locator('img.turn-image');
  await image.waitFor();
  await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('img.turn-image')?.naturalWidth === 1);
  assert.equal(await image.getAttribute('src'), `data:image/png;base64,${data}`);
  assert.match(await page.locator('.bubble').innerText(), /Why is this broken\?/);
  assert.equal(await page.locator('.turn-image-gone').count(), 0);
  await image.click();
  await page.locator('.lightbox').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.lightbox').waitFor({ state: 'detached' });
});
