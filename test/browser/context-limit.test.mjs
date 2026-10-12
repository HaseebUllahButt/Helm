import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { join } from 'node:path';

let browser;
const capture = (target, name) => process.env.HELM_TEST_SCREENSHOT_DIR && target.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, name) });
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) }); });
after(async () => browser?.close());

// Clicking the context meter of a Claude chat opens "Compact at". Choosing a
// size is saved on every online machine that has the same Claude account;
// a machine that is off keeps its old size and the note says so.
const chatBundle = (engine) => build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { DrivenSession } from './apps/web/src/session/DrivenSession';
  import { saveAccounts } from './apps/web/src/accountsCache';
  const ACCOUNT = 'claude|~/.claude-personal|';
  const machine = (id, name, online) => ({ id, name, online, lastSeen: 1, info: {} });
  const machines = [machine('laptop', 'Laptop', true), machine('vm', 'VM', true), machine('desk', 'Desktop', true), machine('nas', 'NAS', true), machine('old', 'Old PC', false), machine('gone', 'Other PC', false)];
  const chat = { id:'chat', title:'Context chat', cwd:'/project', engine:'${engine}', profileId:'claudes', status:'idle', driver:true, model:'claude-opus-5-5[1m]',
    context:{ used:148500, window:383000, full:1000000, model:'claude-opus-5-5', at:1 } };
  window.calls = [];
  window.fail = '';
  const client = {
    on: () => () => {}, subscribe: () => {},
    rpc: async (env, method, params) => {
      if (method === 'account.contextLimit') {
        window.calls.push({ env, params });
        if (env === window.fail) throw new Error('offline');
        return { ok:true, account:ACCOUNT, matched: env === 'nas' ? 0 : 1, window: params.window };
      }
      if (method === 'usage.limits') return { unsupported:0, accounts:[] };
      if (method === 'model.list') return { models:[], modes:[] };
      if (method === 'agent.list') return { agents:[] };
      if (method === 'session.list') return { sessions:[] };
      if (method === 'session.watch') return { last:0 };
      if (method === 'session.events') return { session:chat, events:[], pending:[], last:0 };
      if (method === 'git.status') return { repo:false };
      return { ok:true };
    },
  };
  // This device remembers that the Old PC has the account and the Other PC does not.
  Promise.all([
    saveAccounts('old', { profiles:[{ id:'claudes', engine:'claude', account:ACCOUNT }] }),
    saveAccounts('gone', { profiles:[{ id:'codex', engine:'codex', account:'codex|~/.codex|' }] }),
  ]).then(() => createRoot(document.getElementById('root')).render(<DrivenSession client={client} env={machines[0]} machines={machines} session={chat}
    onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} onOpenSession={()=>{}} />));
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });

const open = async (browser, width, bundle) => {
  const view = await browser.newPage({ viewport: { width, height: 844 } });
  view.setDefaultTimeout(10_000);
  await view.route('http://helm-ctx-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div class="session" id="root"></div>' }));
  await view.goto('http://helm-ctx-test/');
  const css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  await view.addStyleTag({ content: css });
  await view.addScriptTag({ content: bundle.outputFiles[0].text });
  return view;
};

test('the context meter opens "Compact at"; a choice is saved on every machine with the account', async () => {
  const bundle = await chatBundle('claude');
  for (const [width, label] of [[1280, 'wide'], [390, 'phone']]) {
    const view = await open(browser, width, bundle);
    try {
      const meter = view.locator('button.ctx-meter');
      await meter.waitFor();
      // A chat with some history keeps its composer at the bottom, so the menu opens upward; the bare test page has it near the top.
      if (width < 600) await view.evaluate(() => { document.querySelector('.composer-wrap').style.marginTop = '460px'; });
      assert.equal(await view.locator('.ctx-menu').count(), 0, 'closed until asked');
      await meter.click();
      const menu = view.locator('.ctx-menu');
      await menu.waitFor();
      assert.equal(await menu.locator('.ctx-menu-title').textContent(), 'Compact at');
      assert.deepEqual(await menu.locator('button').allTextContents(), ['Full (1M)', '750k', '500k', '383k', '350k', '200k']);
      assert.equal(await menu.locator('button[aria-checked="true"]').textContent(), '383k', 'the size in force is checked');
      // It opens toward the room there is and stays inside the screen.
      assert.equal(await menu.evaluate((el) => el.classList.contains('down')), width > 600);
      const box = await menu.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0, `menu fits the screen: ${JSON.stringify(box)}`);
      await capture(view, `context-limit-${label}-open.png`);

      await menu.getByRole('menuitemradio', { name: '500k' }).click();
      await menu.getByText('Saved on 3 machines').waitFor();
      assert.equal(await menu.locator('.warn').textContent(), "1 offline - they'll keep their old limit", 'the other PC never had the account, so it is not counted');
      const calls = await view.evaluate(() => window.calls);
      assert.deepEqual(calls.map((c) => c.env).sort(), ['desk', 'laptop', 'nas', 'vm'], 'every online machine is asked, offline ones are not');
      const mine = calls.find((c) => c.env === 'laptop');
      assert.deepEqual(mine.params, { profileId: 'claudes', model: 'claude-opus-5-5', window: 500_000 });
      for (const c of calls.filter((c) => c.env !== 'laptop')) {
        assert.deepEqual(c.params, { account: 'claude|~/.claude-personal|', model: 'claude-opus-5-5', window: 500_000 }, c.env);
      }
      assert.equal(await menu.locator('button[aria-checked="true"]').textContent(), '500k', 'the check follows the choice at once');
      await capture(view, `context-limit-${label}-saved.png`);

      // Full takes the limit away.
      await view.evaluate(() => { window.calls.length = 0; });
      await menu.getByRole('menuitemradio', { name: 'Full (1M)' }).click();
      await menu.locator('button[aria-checked="true"]', { hasText: 'Full' }).waitFor();
      assert.ok((await view.evaluate(() => window.calls)).every((c) => c.params.window === null));

      // A machine that cannot be reached is named, not hidden.
      await view.evaluate(() => { window.fail = 'vm'; });
      await menu.getByRole('menuitemradio', { name: '200k' }).click();
      await menu.getByText('Saved on 2 machines').waitFor();
      assert.match(await menu.locator('.warn').textContent(), /Couldn't reach VM/);

      // Escape and a tap elsewhere close it.
      await view.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      await meter.click();
      await menu.waitFor();
      await view.locator('.limits-line').click({ position: { x: 4, y: 4 }, force: true });
      await menu.waitFor({ state: 'detached' });
      assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    } finally { await view.close(); }
  }
});

test('another engine keeps the plain meter with no menu', async () => {
  const bundle = await chatBundle('codex');
  const view = await open(browser, 390, bundle);
  try {
    await view.locator('.ctx-meter').waitFor();
    assert.equal(await view.locator('button.ctx-meter').count(), 0);
    assert.equal(await view.locator('.ctx-meter').getAttribute('title'), '148.5k of 383k used');
  } finally { await view.close(); }
});
