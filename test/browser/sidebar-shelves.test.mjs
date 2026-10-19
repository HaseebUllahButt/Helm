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
    import { Shell, EnvView } from './apps/web/src/App';
    import * as workspace from './apps/web/src/workspaceCache';
    const root = createRoot(document.getElementById('root'));
    const token = 'helm1.' + btoa(JSON.stringify({net:'network',sub:'device'})) + '.test';
    window.scope = workspace.workspaceScope(token);
    window.workspace = workspace;
    window.makeClient = (envs, sessions, relay='http://helm-test', extra={}) => ({token, relay,
      environments: async () => ({ environments: envs }),
      on: () => () => {}, subscribe: () => {}, watchLatency: () => () => {},
      openDirect: async () => {}, route: async () => null,
      rpc: (env, method) => method === 'session.list' ? Promise.resolve({ sessions: structuredClone(sessions[env] ?? []) })
        : method in extra ? Promise.resolve(typeof extra[method] === 'function' ? extra[method](env) : extra[method])
        : new Promise(() => {}),
    });
    window.mount = client => root.render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}} />);
    window.mountEnv = client => root.render(<EnvView client={client} env={{id:'vm',name:'VM',online:true,info:{}}}
      sessions={[]} reload={()=>{}} onNewSession={()=>{}} onSendProject={()=>{}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, plugins: [{ name: 'shell-test-export', setup(builder) {
    builder.onLoad({ filter: /\/App\.tsx$/ }, async ({ path }) => ({ contents: await readFile(path, 'utf8') + '\nexport { Shell, EnvView };', loader: 'tsx' }));
  } }], bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  css += await readFile('node_modules/@xterm/xterm/css/xterm.css', 'utf8');
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

// A mix of everything the sidebar can say: one waiting on the owner, two
// working, one finished and not yet opened, and a long tail of settled chats.
function mount() {
  const now = Date.now(), min = 60000, hour = 3600000;
  localStorage.setItem('helm-seen:v1', JSON.stringify({ since: now - 6 * min, at: {} }));
  const make = (title, more = {}) => ({ id: title, title, cwd: '/home/me/helm', engine: 'claude', profileId: 'claude', driver: 'claude',
    turns: 3, status: 'idle', alive: true, updatedAt: now - hour, ...more });
  const laptop = [
    make('Approve the deploy script', { status: 'blocked', pending: 1, branch: 'release/2.4', updatedAt: now - 4 * min,
      ask: { kind: 'command', text: 'rm -rf dist && npm run build', more: 0 } }),
    make('Rebuild the sidebar shelves', { status: 'working', branch: 'feat/shelves', updatedAt: now - (2 * min + 5000) }),
    make('Fix flaky login test', { status: 'working', engine: 'codex', profileId: 'codex', driver: 'codex', cwd: '/home/me/api', updatedAt: now - 40000 }),
    make('Write the release notes', { updatedAt: now - 5 * min }),
    make('Tidy the settings page', { engine: 'codex', profileId: 'codex', driver: 'codex', updatedAt: now - 2 * hour }),
    make('Investigate slow startup', { updatedAt: now - 5 * hour, cwd: '/home/me/api' }),
    make('Rename the config keys', { engine: 'codex', profileId: 'codex', driver: 'codex', updatedAt: now - 26 * hour }),
  ];
  const vm = Array.from({ length: 40 }, (_, i) => make(`Older chat ${i + 1}`, { updatedAt: now - (6 + i) * hour, cwd: '/srv/app' }));
  window.mount(window.makeClient([{ id: 'laptop', name: 'Laptop', online: true, info: {} }, { id: 'vm', name: 'VM', online: true, info: {} }], { laptop, vm }));
}

const titlesIn = (locator) => locator.locator('.tri-title').allTextContents();
const shelf = (page, name) => page.locator('.sidebar .foldwrap').filter({ has: page.locator('.fold-title', { hasText: new RegExp(`^${name}$`) }) });

for (const width of [1280, 390]) test(`chats sit on shelves with a status at the right at ${width}px`, async t => {
  const { page, boot } = await pageFor(t, { width, height: width > 500 ? 1000 : 844 });
  await page.clock.install({ time: new Date('2026-10-12T12:00:00Z') });
  await boot();
  await page.evaluate(mount);
  const sidebar = page.locator('.sidebar');
  await shelf(page, 'Settled').waitFor();
  assert.deepEqual(await sidebar.locator('.fold-title').allTextContents(), ['Needs you', 'Working', 'Settled', 'Machines']);

  // Needs you: only shown when something waits, with an amber count.
  const needs = shelf(page, 'Needs you');
  assert.equal(await needs.locator('.count').innerText(), '1');
  assert.equal(await needs.locator('.need').count(), 1);
  assert.notEqual(await needs.locator('.count').evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');

  // Working: a ticker since the turn began, and background work steps back.
  const working = shelf(page, 'Working');
  assert.deepEqual((await titlesIn(working)).sort(), ['Fix flaky login test', 'Rebuild the sidebar shelves']);
  const busy = working.locator('.tri-row').filter({ hasText: 'Rebuild the sidebar shelves' });
  assert.match(await busy.locator('.tstat.working').innerText(), /^2m 0[5-9]s$/);
  assert.match(await working.locator('.tri-row').filter({ hasText: 'Fix flaky login test' }).locator('.tstat.working').innerText(), /^4\ds$/);
  // Clocks turn over on the whole second, so one can trail its turn by up to a second.
  await page.clock.runFor(5000);
  assert.match(await busy.locator('.tstat.working').innerText(), /^2m (09|1\d)s$/, 'the clock keeps counting');
  assert.equal(await busy.evaluate(e => getComputedStyle(e).opacity), '0.7');
  await busy.hover();
  await page.waitForFunction(() => [...document.querySelectorAll('.tri-row.recede')].some(e => getComputedStyle(e).opacity === '1'));
  assert.equal(await page.locator('.tstat.working svg.tspin').first().evaluate(e => getComputedStyle(e).animationName), 'tspin');

  // Settled: one line each, newest first, an unopened finish shows a green check.
  const settled = shelf(page, 'Settled');
  const settledTitles = await titlesIn(settled);
  assert.equal(settledTitles.length, 10, 'ten to start with');
  assert.deepEqual(settledTitles.slice(0, 3), ['Write the release notes', 'Tidy the settings page', 'Investigate slow startup']);
  const fresh = settled.locator('.tri-row').filter({ hasText: 'Write the release notes' });
  assert.match(await fresh.locator('.slim-when').innerText(), /^(wrapped up )?5m ago$/);
  assert.equal(await settled.locator('.tstat.unread').count(), 1, 'only the unopened one');
  assert.equal(await fresh.locator('.tstat.unread').count(), 1);
  assert.ok(await settled.locator('.row.slim').first().evaluate(e => e.getBoundingClientRect().height < 46), 'slim rows are one line');
  assert.equal(await settled.locator('.note-inline.fresh').innerText(), '1 new');
  await shot(page, `sidebar-shelves-${width}.png`);
  await page.locator('.sidebar .scroll').evaluate(e => { e.scrollTop = e.scrollHeight; });
  await shot(page, `sidebar-shelves-${width}-scrolled.png`);
  await page.locator('.sidebar .scroll').evaluate(e => { e.scrollTop = 0; });

  // 44 in all, ten shown: Show 25 more, then the last 9.
  await settled.getByRole('button', { name: 'Show 25 more' }).click();
  assert.equal((await titlesIn(settled)).length, 35);
  await settled.getByRole('button', { name: 'Show 9 more' }).click();
  assert.equal((await titlesIn(settled)).length, 44);
  assert.equal(await settled.getByRole('button', { name: /Show .* more/ }).count(), 0);

  // Opening the unopened chat clears the check, and it stays cleared.
  await fresh.locator('.thread-row').click();
  await settled.locator('.tstat.unread').waitFor({ state: 'detached' });
  assert.equal(await fresh.locator('.thread-row').getAttribute('aria-current'), 'page');
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('helm-seen:v1')).at['Write the release notes'] > 0));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
});

test('a chat opened on another device shows no green check here; opening one here, now or before, tells the machine', async t => {
  const { page, boot } = await pageFor(t, { width: 1280, height: 900 });
  await boot();
  await page.evaluate(() => {
    const now = Date.now(), min = 60000;
    localStorage.setItem('helm-seen:v1', JSON.stringify({ since: now - 60 * min, at: { 'Read here before the update': now - min } }));
    const make = (title, more) => ({ id: title, title, cwd: '/home/me/helm', engine: 'claude', profileId: 'claude', driver: 'claude',
      turns: 3, status: 'idle', alive: true, ...more });
    window.seen = [];
    const client = window.makeClient([{ id: 'laptop', name: 'Laptop', online: true, info: {} }], { laptop: [
      make('Read on the phone', { updatedAt: now - 5 * min, seenAt: now - 2 * min }),
      make('Not read anywhere', { updatedAt: now - 4 * min }),
      make('Read here before the update', { updatedAt: now - 3 * min }),
    ] });
    const rpc = client.rpc;
    client.rpc = (env, method, params) => method === 'session.seen'
      ? (window.seen.push(params.id), Promise.resolve({ ok: true })) : rpc(env, method, params);
    window.mount(client);
  });
  const settled = shelf(page, 'Settled');
  await settled.waitFor();
  assert.equal(await settled.locator('.tri-row').filter({ hasText: 'Read on the phone' }).locator('.tstat.unread').count(), 0);
  const unread = settled.locator('.tri-row').filter({ hasText: 'Not read anywhere' });
  assert.equal(await unread.locator('.tstat.unread').count(), 1);
  // Read on this device before the machine kept it: handed over once, unprompted.
  await page.waitForFunction(() => window.seen.includes('Read here before the update'));
  assert.deepEqual(await page.evaluate(() => window.seen), ['Read here before the update']);
  await unread.locator('.thread-row').click();
  await unread.locator('.tstat.unread').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.seen.includes('Not read anywhere'));
});

test('the row menu still opens above its neighbours on a stepped-back working row', async t => {
  const { page, boot } = await pageFor(t, { width: 1280, height: 900 });
  await boot();
  await page.evaluate(mount);
  const row = shelf(page, 'Working').locator('.tri-row').filter({ hasText: 'Fix flaky login test' });
  await row.hover();
  await row.getByRole('button', { name: 'actions for Fix flaky login test' }).click();
  const menu = row.locator('.row-menu');
  await menu.waitFor();
  const onTop = await menu.getByRole('button', { name: 'Archive thread' }).evaluate(e => {
    const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return e === hit || e.contains(hit);
  });
  assert.ok(onTop, 'nothing covers the menu');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.tri-row:has(.row-menu)')).opacity === '1');
});

test('the chat you are in stays on its shelf when it is folded or paged', async t => {
  const { page, boot } = await pageFor(t, { width: 1280, height: 900 });
  await boot();
  await page.evaluate(mount);
  const settled = shelf(page, 'Settled');
  await settled.waitFor();
  assert.equal(await settled.getByText('Older chat 21', { exact: true }).count(), 0, 'beyond the first ten');
  await settled.getByRole('button', { name: 'Show 25 more' }).click();
  await settled.getByText('Older chat 21', { exact: true }).click();
  await settled.locator('.thread-row[aria-current="page"]').waitFor();
  // Fold it: the header gains a count, and the chat you are in stays.
  await settled.locator('.fold-toggle[aria-expanded="true"]').click();
  assert.equal(await settled.locator('.count').innerText(), '44');
  assert.deepEqual(await titlesIn(settled), ['Older chat 21']);
    await settled.locator('.fold-toggle[aria-expanded="false"]').click();
  assert.equal((await titlesIn(settled)).length, 10 + 1, 'ten, plus the chat you are in');
});

test('Working folds to a count and still shows the chat you are in', async t => {
  const { page, boot } = await pageFor(t, { width: 1280, height: 900 });
  await boot();
  await page.evaluate(mount);
  const working = shelf(page, 'Working');
  await working.locator('.tri-row').first().waitFor();
  await working.locator('.tri-row').filter({ hasText: 'Fix flaky login test' }).locator('.thread-row').click();
  assert.equal(await working.locator('.tri-row.active.recede').count(), 0, 'the chat you are in is not dimmed');
  await working.locator('.fold-toggle[aria-expanded="true"]').click();
  assert.equal(await working.locator('.count').innerText(), '2');
  assert.deepEqual(await titlesIn(working), ['Fix flaky login test']);
  await working.locator('.fold-toggle[aria-expanded="false"]').click();
  assert.equal((await titlesIn(working)).length, 2);
});

test('reduced motion stills the spinner; the light theme keeps every status readable', async t => {
  const { page, boot } = await pageFor(t, { width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot();
  await page.evaluate(mount);
  await shelf(page, 'Working').locator('.tspin').first().waitFor();
  assert.equal(await page.locator('.tspin').first().evaluate(e => getComputedStyle(e).animationName), 'none');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.waitForTimeout(500);
  for (const kind of ['working', 'unread']) {
    const colour = await page.locator(`.tstat.${kind}`).first().evaluate(e => getComputedStyle(e).color);
    const [r, g, b] = colour.match(/\d+/g).map(Number);
    assert.ok((r + g + b) / 3 < 150, `${kind} is dark enough to read on white: ${colour}`);
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll on a phone');
  await shot(page, 'sidebar-shelves-light-390.png');
});

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
  await page.getByRole('button', { name: 'actions for Write the release notes' }).click();
  await page.getByRole('button', { name: 'Archive thread' }).click();
  const notice = page.getByRole('status').filter({ hasText: 'Archived Write the release notes' });
  await notice.waitFor();
  await notice.getByRole('button', { name: 'Undo' }).click();
  await page.waitForFunction(() => window.archived.length === 2);
  assert.deepEqual(await page.evaluate(() => window.archived), [{ id: 'notes', archived: true }, { id: 'notes', archived: false }]);
  await notice.waitFor({ state: 'detached' });
});
