import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { join } from 'node:path';

let browser, script, css;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Shell } from './apps/web/src/App';
    const root = createRoot(document.getElementById('root'));
    const token = 'helm1.' + btoa(JSON.stringify({net:'network',sub:'device'})) + '.test';
    window.makeClient = (envs, sessions, relay='http://helm-test', extra={}) => ({token, relay,
      environments: async () => ({ environments: envs }),
      on: () => () => {}, subscribe: () => {}, watchLatency: () => () => {},
      openDirect: async () => {}, route: async () => null,
      rpc: (env, method) => method === 'session.list' ? Promise.resolve({ sessions: structuredClone(sessions[env] ?? []) })
        : method in extra ? Promise.resolve(typeof extra[method] === 'function' ? extra[method](env) : extra[method])
        : new Promise(() => {}),
    });
    window.mount = client => root.render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, plugins: [{ name: 'shell-test-export', setup(builder) {
    builder.onLoad({ filter: /\/App\.tsx$/ }, async ({ path }) => ({ contents: await readFile(path, 'utf8') + '\nexport { Shell };', loader: 'tsx' }));
  } }], bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

async function pageFor(testContext, viewport, options = {}) {
  const context = await browser.newContext({ viewport, ...options });
  testContext.after(() => context.close());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://helm-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://helm-test/');
  const boot = async () => { await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script }); };
  testContext.after(() => assert.deepEqual(errors, []));
  return { page, boot };
}

const shot = (page, name) => process.env.HELM_TEST_SCREENSHOT_DIR
  ? page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, name) }) : null;

const titlesIn = (locator) => locator.locator('.tri-title').allTextContents();
const shelf = (page, name) => page.locator('.sidebar .foldwrap').filter({ has: page.locator('.fold-title', { hasText: new RegExp(`^${name}$`) }) });

test('archiving from Home says so, and Undo brings the chat back', async t => {
  const { page, boot } = await pageFor(t, { width: 390, height: 844 });
  await boot();
  await page.evaluate(() => {
    const now = Date.now();
    window.archived = [];
    const notes = { id: 'notes', title: 'Write the release notes', cwd: '/home/me/helm', engine: 'claude', profileId: 'claude', driver: 'claude',
      turns: 3, status: 'idle', alive: true, updatedAt: now - 300000 };
    const client = window.makeClient([{ id: 'laptop', name: 'Laptop', online: true, info: {} }], { laptop: [notes] });
    const rpc = client.rpc;
    client.rpc = (env, method, params) => method === 'session.archive'
      ? (window.archived.push(params), Promise.resolve({ ok: true })) : rpc(env, method, params);
    window.mount(client);
  });
  await shelf(page, 'Settled').locator('.fold-toggle[aria-expanded="false"]').click();
  await page.getByRole('button', { name: 'Show actions for Write the release notes' }).click();
  await page.getByRole('button', { name: 'Archive chat' }).click();
  const notice = page.getByRole('status').filter({ hasText: 'Archived Write the release notes' });
  await notice.waitFor();
  await notice.getByRole('button', { name: 'Undo' }).click();
  await page.waitForFunction(() => window.archived.length === 2);
  assert.deepEqual(await page.evaluate(() => window.archived), [{ id: 'notes', archived: true }, { id: 'notes', archived: false }]);
  await notice.waitFor({ state: 'detached' });
});

test('a pinned chat sits above every shelf and leaves its own; Unpin puts it back', async t => {
  const { page, boot } = await pageFor(t, { width: 1280, height: 900 });
  await boot();
  await page.evaluate(() => {
    const now = Date.now();
    const make = (id, title, more = {}) => ({ id, title, cwd: '/home/me/helm', engine: 'claude', profileId: 'claude', driver: 'claude',
      turns: 3, status: 'idle', alive: true, updatedAt: now - 7200000, ...more });
    const laptop = [
      make('ask', 'Approve the deploy script', { status: 'blocked', pending: 1, updatedAt: now - 60000, ask: { kind: 'command', text: 'ls', more: 0 } }),
      make('busy', 'Rebuild the shelves', { status: 'working', updatedAt: now - 30000 }),
      make('notes', 'Write the release notes'),
    ];
    window.pins = [];
    const client = window.makeClient([{ id: 'laptop', name: 'Laptop', online: true, info: {} }], { laptop });
    const rpc = client.rpc;
    client.rpc = (env, method, params) => {
      if (method !== 'session.pin') return rpc(env, method, params);
      window.pins.push(params);
      const s = laptop.find((x) => x.id === params.id);
      s.pinnedAt = params.pinned ? Date.now() + window.pins.length : null;
      return Promise.resolve({ ok: true, session: structuredClone(s) });
    };
    window.mount(client);
  });
  const side = page.locator('.sidebar');
  const titles = () => page.locator('.sidebar .fold-title').allTextContents();
  await shelf(page, 'Settled').waitFor();
  assert.deepEqual(await titles(), ['Needs you', 'Running', 'Settled']);

  await shelf(page, 'Settled').locator('.fold-toggle[aria-expanded="false"]').click();
  await side.getByRole('button', { name: 'Show actions for Write the release notes' }).click();
  await page.getByRole('button', { name: 'Pin chat' }).click();
  await shelf(page, 'Pinned').waitFor();
  // The settled chat was the only one there, so Settled goes.
  assert.deepEqual(await titles(), ['Pinned', 'Needs you', 'Running']);

  // A working chat pinned later goes on top and keeps its working clock.
  await side.getByRole('button', { name: 'Show actions for Rebuild the shelves' }).click();
  await page.getByRole('button', { name: 'Pin chat' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar .foldwrap .tri-row').length && window.pins.length === 2);
  await page.locator('.sidebar .fold-title', { hasText: /^Running$/ }).waitFor({ state: 'detached' });
  assert.deepEqual(await titlesIn(shelf(page, 'Pinned')), ['Rebuild the shelves', 'Write the release notes']);
  assert.deepEqual(await titles(), ['Pinned', 'Needs you']);
  await shot(page, 'sidebar-pinned.png');

  await side.getByRole('button', { name: 'Show actions for Write the release notes' }).click();
  await page.getByRole('button', { name: 'Unpin chat' }).click();
  await shelf(page, 'Settled').waitFor();
  assert.deepEqual(await titlesIn(shelf(page, 'Pinned')), ['Rebuild the shelves']);
  assert.deepEqual(await page.evaluate(() => window.pins), [
    { id: 'notes', pinned: true }, { id: 'busy', pinned: true }, { id: 'notes', pinned: false }]);
});
