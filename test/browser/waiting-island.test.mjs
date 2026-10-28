import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, page;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { WaitingIsland } from './apps/web/src/WaitingIsland';
    const root = createRoot(document.getElementById('island'));
    const pending = {
      q: { requestId: 'r-q', kind: 'question', title: 'Question', seq: 1, defaultTo: 'allow', options: [],
        questions: [{ question: 'Tabs or spaces?', options: [{ label: 'Tabs' }, { label: 'Spaces' }] }] },
      c: { requestId: 'r-c', kind: 'command', title: 'Run a command', detail: 'rm -rf tmp/old', seq: 1, defaultTo: 'allow',
        options: [{ id: 'a', role: 'allow', label: 'Allow' }, { id: 'aa', role: 'allow-always', label: 'Always allow' }, { id: 'd', role: 'deny', label: 'Deny' }] },
    };
    const client = { rpc: async (env, method, params) => {
      (window.calls ??= []).push({ method, params });
      if (method === 'session.events') return { pending: [pending[params.id]] };
      return {};
    } };
    const chat = (id, title, kind, engine) => ({ envId: 'laptop', machine: 'Laptop',
      s: { id, title, engine, status: 'blocked', cwd: '/home/me/project', ask: { kind, text: '', more: 0, requestId: 'r-' + id } } });
    window.items = [chat('q', 'Pick a style', 'question', 'claude'), chat('c', 'Clean old rows', 'command', 'codex')];
    window.show = (extra) => root.render(<WaitingIsland client={client} items={window.items} ping={null} pick={null}
      onOpen={(envId, s) => { window.opened = s.id; }} {...extra} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent('<textarea id="box"></textarea><div id="island"></div>');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});
after(() => browser?.close());

test('a pill names the first waiting chat and how many more wait', async () => {
  await page.evaluate(() => window.show());
  await page.locator('.island:not(.open)').waitFor();
  assert.equal(await page.locator('.island-title').innerText(), 'Pick a style');
  assert.equal(await page.locator('.island-more').innerText(), '+1');
});

test('a chat that starts waiting opens the box but never takes the keys', async () => {
  await page.evaluate(() => { window.calls = []; window.show({ ping: { envId: 'laptop', id: 'c', at: Date.now() } }); });
  await page.locator('.island.open .island-cmd').getByText('rm -rf tmp/old').waitFor();
  await page.locator('#box').focus();
  await page.keyboard.press('Control+Enter');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.island-shade').count(), 0, 'no dimmed screen behind a box that opened by itself');
  assert.equal(await page.evaluate(() => window.calls.some((c) => c.method === 'session.answer')), false);
});

test('opened by the owner, a question is answered with Ctrl+number and the next chat comes in', async () => {
  await page.evaluate(() => { window.calls = []; window.show({ pick: { envId: 'laptop', id: 'q', at: Date.now() } }); });
  await page.locator('.island-opt').filter({ hasText: 'Spaces' }).waitFor();
  assert.equal(await page.locator('.island-nav').innerText(), '1 of 2');
  await page.keyboard.press('Control+2');
  await page.locator('.island-flash').getByText('Answered: Spaces').waitFor();
  const sent = await page.evaluate(() => window.calls.find((c) => c.method === 'session.answer').params);
  assert.deepEqual(sent, { id: 'q', requestId: 'r-q', decision: { option: 'allow', answers: { 'Tabs or spaces?': 'Spaces' }, answerLists: { 'Tabs or spaces?': ['Spaces'] } } });
  await page.locator('.island.open .island-title').getByText('Clean old rows').waitFor();
});

test('Ctrl+Enter allows a command once, then the box closes when nothing waits', async () => {
  await page.locator('.island-cmd').waitFor();
  await page.keyboard.press('Control+Enter');
  await page.locator('.island-flash').getByText('Allowed').waitFor();
  const sent = await page.evaluate(() => window.calls.filter((c) => c.method === 'session.answer').at(-1).params);
  assert.deepEqual(sent, { id: 'c', requestId: 'r-c', decision: { option: 'allow' } });
  await page.locator('.island').waitFor({ state: 'detached' });
});

test('Open chat goes to the chat and Esc closes the box to its pill', async () => {
  await page.evaluate(() => {
    // A new request in the same chat: the box shows it again.
    window.items = [{ ...window.items[1], s: { ...window.items[1].s, ask: { kind: 'command', text: '', more: 0, requestId: 'r2-c' } } }];
    window.show({ pick: { envId: 'laptop', id: 'c', at: Date.now() } });
  });
  await page.locator('.island.open').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.island:not(.open)').waitFor();
  await page.locator('.island').click();
  await page.getByRole('button', { name: 'Open chat' }).click();
  assert.equal(await page.evaluate(() => window.opened), 'c');
});
