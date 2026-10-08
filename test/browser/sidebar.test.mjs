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
      rpc: (env, method) => method === 'session.list' ? Promise.resolve({ sessions: sessions[env] ?? [] })
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

for (const width of [1280, 390]) test(`a resumed task clears stale recovery and paused cards stay compact at ${width}px`, async t => {
  const { page, boot } = await pageFor(t, { width, height: 900 });
  await boot();
  await page.evaluate(() => {
    const listeners = new Set();
    const paused = { id: 'paused', title: 'Fix external session control', cwd: '/project/helm', engine: 'codex', profileId: 'codex', driver: 'codex', status: 'idle', alive: true, turns: 1, updatedAt: Date.now(), recovery: { kind: 'restart', message: 'Saved conversation', at: Date.now() } };
    const client = window.makeClient([{ id: 'laptop', name: 'Laptop', online: true, info: {} }], { laptop: [paused] });
    client.on = listener => { listeners.add(listener); return () => listeners.delete(listener); };
    const rpc = client.rpc;
    client.rpc = (env, method, params) => method === 'session.list' && window.blockRelist ? new Promise(() => {}) : rpc(env, method, params);
    window.resumeTask = () => {
      window.blockRelist = true;
      const { recovery, ...resumed } = paused;
      for (const listener of listeners) listener('laptop', 'session.update', { session: { ...resumed, status: 'working' } });
    };
    window.finishTask = () => {
      const { recovery, ...finished } = paused;
      for (const listener of listeners) listener('laptop', 'session.update', { session: { ...finished, status: 'idle' } });
    };
    window.mount(client);
  });
  const card = page.locator('.sidebar .need-recovery');
  await card.getByText('Response interrupted', { exact: false }).waitFor();
  await page.screenshot({ path: `/tmp/helm-recovery-sidebar-${width}.png` });
  assert.ok((await card.boundingBox()).height < 165, `recovery uses a compact thread card: ${JSON.stringify(await card.boundingBox())}`);
  const action = card.locator('.need-go');
  assert.equal(await action.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'recovery is not a large filled warning button');
  await page.screenshot({ path: `/tmp/helm-recovery-sidebar-${width}.png` });
  await page.evaluate(() => window.resumeTask());
  await page.locator('.sidebar .need').waitFor({ state: 'detached' });
  await page.locator('.sidebar').getByText('Fix external session control', { exact: true }).waitFor();
  await page.screenshot({ path: `/tmp/helm-recovery-resumed-${width}.png` });
  await page.evaluate(() => window.finishTask());
  assert.equal(await page.locator('.sidebar .need').count(), 0, 'the cleared warning does not return when the turn finishes');
});

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

test('attention cards distinguish failures, limits, and actual questions on mobile', async t => {
  const { page, boot } = await pageFor(t, { width: 390, height: 1000 });
  await boot();
  await page.evaluate(() => {
    const base = { cwd: '/project/helm', engine: 'devin', driver: 'devin', alive: true, status: 'idle', updatedAt: Date.now() };
    const sessions = [
      { ...base, id: 'failed', title: 'Provider failure', recovery: { kind: 'error', message: 'an internal error occurred', at: Date.now() } },
      { ...base, id: 'limited', title: 'Account limit', recovery: { kind: 'limited', message: 'Usage limit reached', at: Date.now() } },
      { ...base, id: 'child', title: 'Parent still working', status: 'working', team: { working: 0, blocked: 0, failed: 1 } },
      { ...base, id: 'question', title: 'Permission needed', status: 'blocked', pending: 1, ask: { kind: 'question', text: 'Proceed?' } },
    ];
    window.mount(window.makeClient([{ id: 'vm', name: 'VM', online: true, info: {} }], { vm: sessions }));
  });
  const sidebar = page.locator('.sidebar');
  for (const title of ['Task failed', 'Usage limit reached', 'Child task failed', 'Needs you']) {
    await sidebar.locator('.need-k').filter({ hasText: new RegExp(`^${title}`) }).waitFor();
  }
  assert.equal(await sidebar.locator('.need-k').filter({ hasText: /Task paused|Helm restarted/ }).count(), 0);
  assert.match(await sidebar.locator('.need-main').filter({ hasText: 'Provider failure' }).getAttribute('title'), /AI service/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/helm-recovery-states-mobile.png' });
});

for (const width of [1280, 390]) test(`a normal native CLI opens with keyboard control on ${width}px`, async context => {
  const touch = width < 500;
  const { page, boot } = await pageFor(context, { width, height: 900 }, touch ? { hasTouch: true, isMobile: true } : {});
  await boot();
  await page.evaluate(() => {
    const machine = { id: 'laptop', name: 'Laptop', online: true, info: {} };
    const session = { id: 'native-example', title: 'Native Claude session', engine: 'claude', cwd: '/work/helm',
      nativeCli: true, pty: true, shared: true, alive: true, status: 'idle', updatedAt: Date.now() };
    const client = window.makeClient([machine], { laptop: [session] });
    const fallback = client.rpc;
    window.nativeCalls = [];
    client.rpc = (env, method, params) => {
      window.nativeCalls.push({ method, params });
      if (method === 'session.attach') return Promise.resolve({ pty: true, text: 'Permission: run harmless command? [y/n]\r\n' });
      if (method === 'session.messages') return Promise.resolve({ messages: [] });
      if (['session.input', 'session.resize', 'session.detach'].includes(method)) return Promise.resolve({ ok: true });
      return fallback(env, method);
    };
    window.mount(client);
  });
  await page.locator('.sidebar').getByRole('button', { name: 'done 1', exact: true }).click();
  await page.locator('.sidebar').getByText('Native Claude session', { exact: true }).click();
  const terminal = page.locator('.xterm-helper-textarea');
  await terminal.waitFor();
  await terminal.press('y');
  await terminal.press('Enter');
  // T3's key row: one row, only while typing, and only on a touch screen.
  const keys = page.locator('.termkeys button');
  assert.equal(await keys.count(), 14);
  assert.equal(await page.locator('.termkeys').isVisible(), touch);
  await page.locator('.termkeys button[aria-label="Down"]').dispatchEvent('pointerdown', { button: 0 });
  await page.waitForFunction(() => window.nativeCalls.filter(c => c.method === 'session.input').length >= 3);
  const calls = await page.evaluate(() => window.nativeCalls.filter(c => c.method === 'session.input'));
  assert.deepEqual(calls.map(c => c.params.data), ['y', '\r', '\x1b[B']);
  assert.ok(calls.every(c => c.params.id === 'native-example' && c.params.raw === true));
  await page.screenshot({ path: `/tmp/helm-native-control-${width}.png` });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.waitForFunction(() => window.nativeCalls.some(c => c.method === 'session.detach' && c.params.watcher));
  assert.equal(await page.evaluate(() => window.nativeCalls.some(c => c.method === 'session.kill')), false);
});

for (const width of [1280, 390]) test(`native Claude channel opens as a Helm chat at ${width}px`, async context => {
  const { page, boot } = await pageFor(context, { width, height: 900 });
  page.setDefaultTimeout(5000);
  await boot();
  await page.evaluate(() => {
    const session = { id: 'native-chat', title: 'Helm interface demo', engine: 'claude', cwd: '/work/helm',
      nativeCli: true, nativeChat: true, pty: true, shared: true, alive: true, status: 'idle', updatedAt: Date.now() };
    const client = window.makeClient([{ id: 'laptop', name: 'Laptop', online: true, info: {} }], { laptop: [session] });
    const fallback = client.rpc;
    window.chatCalls = []; window.chatMessages = [{ role: 'assistant', text: 'This is the Helm conversation interface.', tools: [] }];
    client.rpc = (env, method, params) => {
      window.chatCalls.push({ method, params });
      if (method === 'session.messages') return Promise.resolve({ messages: window.chatMessages, status: 'idle' });
      if (method === 'session.events') return Promise.resolve({ events: [], pending: [], last: 0, session: { status: 'idle' } });
      if (method === 'session.attach') return Promise.resolve({ pty: true, text: 'Claude terminal prompt\r\n' });
      if (['session.detach', 'session.resize'].includes(method)) return Promise.resolve({ ok: true });
      if (['session.watch', 'session.unwatch'].includes(method)) return Promise.resolve({ ok: true, last: 0 });
      if (method === 'session.input') {
        window.chatMessages = [...window.chatMessages, { role: 'user', text: params.data.trim(), tools: [] }, { role: 'assistant', text: 'Your message reached the same Claude session.', tools: [] }];
        return Promise.resolve({ ok: true });
      }
      return fallback(env, method);
    };
    window.mount(client);
  });
  await page.locator('.sidebar').getByRole('button', { name: 'done 1', exact: true }).click();
  await page.locator('.sidebar').getByText('Helm interface demo', { exact: true }).click();
  await page.getByText('This is the Helm conversation interface.', { exact: true }).waitFor();
  assert.equal(await page.locator('.xterm-host').count(), 0);
  const composer = page.locator('.slab textarea');
  await composer.fill('Hello from Helm');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  await page.getByText('Your message reached the same Claude session.', { exact: true }).waitFor();
  const calls = await page.evaluate(() => window.chatCalls);
  assert.deepEqual(calls.find(c => c.method === 'session.input').params, { id: 'native-chat', data: 'Hello from Helm\n' });
  assert.equal(calls.some(c => c.method === 'session.attach'), false);
  assert.equal(await page.locator('.slab .quick').count(), 0);
  await page.getByRole('button', { name: 'show the terminal', exact: true }).click();
  await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'show the conversation', exact: true }).click();
  await page.getByText('Your message reached the same Claude session.', { exact: true }).waitFor();
  await page.screenshot({ path: `/tmp/helm-native-chat-${width}.png` });
});

test('project timeout errors clear on recovery and late failures cannot replace a fresh list', async context => {
  const { page, boot } = await pageFor(context, { width: 1280, height: 900 });
  await boot();
  await page.evaluate(() => {
    const listeners = new Set();
    window.projectRequests = [];
    const client = window.makeClient([], {});
    client.on = callback => { listeners.add(callback); return () => listeners.delete(callback); };
    client.rpc = (_env, method) => method === 'project.list'
      ? new Promise((resolve, reject) => window.projectRequests.push({ resolve, reject }))
      : Promise.resolve({ recent: [] });
    window.reconnect = () => { for (const listener of listeners) listener('', 'connection', { online: true }); };
    window.mountEnv(client);
  });
  await page.waitForFunction(() => window.projectRequests.length === 1);
  await page.evaluate(() => window.projectRequests[0].reject(new Error('project.list timed out')));
  await page.getByText('project.list timed out', { exact: true }).waitFor();
  await page.evaluate(() => window.reconnect());
  await page.waitForFunction(() => window.projectRequests.length === 2);
  await page.evaluate(() => window.projectRequests[1].resolve({ projects: [] }));
  await page.getByText('project.list timed out', { exact: true }).waitFor({ state: 'detached' });
  await page.evaluate(() => { window.reconnect(); window.reconnect(); });
  await page.waitForFunction(() => window.projectRequests.length === 4);
  await page.evaluate(() => window.projectRequests[3].resolve({ projects: [] }));
  await page.evaluate(() => window.projectRequests[2].reject(new Error('stale disconnected')));
  assert.equal(await page.getByText('stale disconnected', { exact: true }).count(), 0);
});

test('settings expose the app route and build without exposing pairing credentials', async context => {
  const { page, boot } = await pageFor(context, { width: 1280, height: 900 });
  await boot();
  await page.evaluate(() => {
    const client = window.makeClient([], {}, 'https://hub.example');
    client.connected = false;
    client.lastError = 'connection stopped responding';
    window.mount(client);
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Connection details', { exact: true }).click();
  await page.getByText('Hub: https://hub.example', { exact: true }).waitFor();
  await page.getByText('App build: development', { exact: true }).waitFor();
  await page.getByText('Last connection error: connection stopped responding', { exact: true }).waitFor();
  // The app reloads itself when a new build lands; no button for it.
  assert.equal(await page.getByRole('button', { name: /^Reload app/ }).count(), 0);
  assert.doesNotMatch(await page.locator('.main').innerText(), /helm1\./);
});

test('Done is newest first across machines, retires at three days, and the footer is quiet', async testContext => {
  const { page, boot } = await pageFor(testContext, { width: 390, height: 844 });
  await page.clock.install({ time: new Date('2026-10-03T12:00:00Z') });
  await boot();
  await page.evaluate(() => {
    const now = Date.now(), hour = 3600000;
    const session = (title, age, more={}) => ({id:title,title,cwd:'/project',engine:'codex',profileId:'codex',
      driver:'codex',turns:1,status:'idle',updatedAt:now-age,...more});
    const sessions = {
      laptop: [session('Two days ago',48*hour),session('Newest',hour),session('Retired',72*hour),
        session('Almost retired',72*hour-1000),session('Working',100*hour,{status:'working'}),
        session('Archived',0,{archived:true}),session('Child',0,{delegation:{parentId:'other'}}),
        session('Unused',0,{turns:0}),session('Waiting',0,{status:'blocked'})],
      vm: [session('Yesterday',24*hour),...Array.from({length:31},(_,i)=>session('Recent '+i,(i+2)*60000))],
    };
    window.mount(window.makeClient(['laptop','vm'].map(id=>({id,name:id,online:true,info:{}})), sessions, 'https://private.sslip.io'));
  });
  const sidebar = page.locator('.sidebar');
  const done = sidebar.locator('.foldwrap').filter({ has: page.locator('.fold-title', { hasText: /^done$/ }) });
  await done.getByRole('button', { name: 'done 35', exact: true }).click();
  const titles = await done.locator('.tri-title').allTextContents();
  assert.equal(titles.length, 35, 'all recent threads remain until their own retirement time');
  assert.deepEqual(titles.slice(-4), ['Newest', 'Yesterday', 'Two days ago', 'Almost retired']);
  assert.equal(titles[0], 'Recent 0');
  assert.equal(titles.includes('Retired'), false);
  assert.equal(await sidebar.locator('.diag').count(), 0);
  assert.doesNotMatch(await sidebar.innerText(), /sslip\.io|socket live/i);
  await page.clock.fastForward(30000);
  await done.getByRole('button', { name: 'done 34', exact: true }).waitFor();
  assert.equal(await done.getByText('Almost retired', { exact: true }).count(), 0);
  await sidebar.getByRole('button', { name: 'Search threads, machines and folders' }).click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox', { name: 'Search threads, machines, actions' }).fill('Almost retired');
  await palette.getByRole('option', { name: /Almost retired/ }).waitFor();
  assert.ok(await palette.getByRole('option', { name: /Almost retired/ }).isVisible(), 'retirement preserves searchable history');
});

test('Running counts only working threads and excludes idle native sessions', async testContext => {
  const { page, boot } = await pageFor(testContext, { width: 390, height: 844 });
  await boot();
  await page.evaluate(() => {
    const now = Date.now();
    const session = (title, more={}) => ({id:title,title,cwd:'/project',engine:'codex',profileId:'codex',
      driver:'codex',turns:1,status:'idle',updatedAt:now,...more});
    const sessions = {
      laptop: [
        session('Busy', {status:'working'}),
        session('Idle alive', {alive:true}),
        session('External idle', {alive:true,externalActive:true,adopted:true,status:'idle'}),
        session('Shared idle', {alive:true,shared:true,status:'idle'}),
        session('Shared stopped', {alive:false,shared:true,status:'idle'}),
        session('Waiting', {status:'blocked', alive:true}),
        session('Busy archived', {status:'working', archived:true}),
        session('Busy shell', {status:'working', engine:'shell'}),
        session('Busy child', {status:'working', delegation:{parentId:'Busy'}}),
      ],
      vm: [session('Dormant', {alive:true})],
    };
    const stale = session('Stale work', {status:'working'});
    window.workspace.saveWorkspace(window.scope, {
      environments: [{id:'old',name:'old',online:false,lastSeen:now-2*86400000,info:{}}],
      sessions: { old: [stale] },
    });
    window.mount(window.makeClient([
      {id:'laptop',name:'laptop',online:true,info:{}},
      {id:'vm',name:'vm',online:true,info:{}},
      {id:'old',name:'old',online:false,lastSeen:now-2*86400000,info:{}},
    ], sessions));
  });
  const sidebar = page.locator('.sidebar');
  const rows = sidebar.locator('.row.machine');
  const laptop = rows.filter({ hasText: 'laptop' });
  await laptop.waitFor();
  assert.equal(await laptop.locator('.rm').textContent(), '1 running');
  assert.equal(await laptop.locator('.badge').textContent(), '1');
  assert.equal(await rows.filter({ hasText: 'vm' }).locator('.rm').textContent(), 'idle');
  assert.match(await rows.filter({ hasText: 'old' }).locator('.rm').textContent(), /^seen/);
  const sectionRows = (name) => sidebar.locator('div.section', { hasText: new RegExp(`^${name}$`) })
    .locator('xpath=following-sibling::div[1]');
  const runningSection = sectionRows('running');
  assert.ok(await runningSection.getByText('Busy', { exact: true }).isVisible());
  assert.equal(await runningSection.getByText('Idle alive', { exact: true }).count(), 0);
  assert.equal(await runningSection.getByText('External idle', { exact: true }).count(), 0);
  assert.equal(await runningSection.getByText('Shared idle', { exact: true }).count(), 0);
  assert.equal(await runningSection.getByText('Shared stopped', { exact: true }).count(), 0);
  assert.equal(await sidebar.getByText('Stale work', { exact: true }).count(), 0, 'a disconnected machine’s cached work is not shown as running');
  await sidebar.getByRole('button', { name: 'Search threads, machines and folders' }).click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox', { name: 'Search threads, machines, actions' }).fill('Stale work');
  const staleOption = palette.getByRole('option', { name: /^Stale work/ });
  assert.match(await staleOption.textContent(), /old · working · offline/);
  await staleOption.click();
  await page.locator('.main.showing .session-bar').filter({ hasText: 'Stale work' }).waitFor();
  await page.goBack();
  await page.locator('.sidebar.showing').waitFor();
  const readout = await page.locator('.main .chooser .readout').textContent();
  assert.match(readout, /1 running/);
  assert.match(readout, /1 needs you/);
  const chooserRows = page.locator('.main .chooser .row.machine');
  assert.equal(await chooserRows.filter({ hasText: 'laptop' }).locator('.rm').textContent(), '1 running');
  assert.equal(await chooserRows.filter({ hasText: 'vm' }).locator('.rm').textContent(), 'Nothing running');
  const machineSummaries = await rows.locator('.rm').allTextContents();
  const runningTotal = machineSummaries.reduce((total, text) => total + (+(/^(\d+) running$/.exec(text)?.[1] ?? 0)), 0);
  assert.equal(runningTotal, +(/(\d+) running/.exec(readout)[1]), 'sidebar per-machine counts add up to the readout');
  const done = sidebar.locator('.foldwrap').filter({ has: page.locator('.fold-title', { hasText: /^done$/ }) });
  await done.getByRole('button', { name: 'done 5', exact: true }).click();
  assert.ok(await done.getByText('Idle alive', { exact: true }).isVisible());
  assert.ok(await done.getByText('Shared stopped', { exact: true }).isVisible());
  await rows.filter({ hasText: 'vm' }).click();
  await page.locator('.main.showing h1').filter({ hasText: 'vm' }).waitFor();
});

test('selected running threads have a distinct highlight on desktop and phone', async testContext => {
  for (const width of [1280, 390]) {
    const { page, boot } = await pageFor(testContext, { width, height: 844 });
    await boot();
    await page.evaluate(() => {
      const session = (id, title) => ({ id, title, cwd: '/project', engine: 'codex', profileId: 'codex', driver: 'codex', turns: 1, status: 'working', updatedAt: Date.now() });
      window.mount(window.makeClient([{ id: 'laptop', name: 'Laptop', online: true, info: {} }], { laptop: [session('one', 'First task'), session('two', 'Second task')] }));
    });
    const rows = page.locator('.sidebar .thread-row');
    const first = rows.filter({ hasText: 'First task' });
    const second = rows.filter({ hasText: 'Second task' });
    await first.click();
    assert.equal(await first.getAttribute('aria-current'), 'page');
    assert.equal(await second.getAttribute('aria-current'), null);
    const style = await first.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, outline: getComputedStyle(element).boxShadow }));
    assert.notEqual(style.background, 'rgba(0, 0, 0, 0)');
    assert.notEqual(style.outline, 'none');
    if (width < 900) await page.setViewportSize({ width: 1280, height: 844 });
    await second.click();
    assert.equal(await first.getAttribute('aria-current'), null);
    assert.equal(await second.getAttribute('aria-current'), 'page');
    if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.locator('.sidebar').screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, `sidebar-selected-${width}.png`) });
  }
});

test('One search control opens the palette, keys work, selection has no left bar', async testContext => {
  const { page, boot } = await pageFor(testContext, { width: 1280, height: 800 });
  await boot();
  await page.evaluate(() => {
    const now = Date.now();
    const session = (title, more={}) => ({id:title,title,cwd:'/work/rocket',engine:'codex',profileId:'codex',
      driver:'codex',turns:1,status:'working',updatedAt:now,...more});
    window.mount(window.makeClient([{id:'laptop',name:'laptop',online:true,info:{}}], {laptop:[session('Rocket thread')]}));
  });
  const sidebar = page.locator('.sidebar');
  const search = sidebar.getByRole('button', { name: 'Search threads, machines and folders' });
  await search.waitFor();
  assert.equal(await sidebar.getByRole('textbox').count(), 0);
  assert.equal(await sidebar.getByRole('button', { name: /Go to/ }).count(), 0);
  assert.equal(await search.count(), 1);
  assert.equal(await search.getAttribute('title'), 'Search threads, machines and folders');
  assert.equal(await search.locator('kbd').count(), 0);
  const label = search.locator('.grow');
  assert.equal(await label.textContent(), 'Search anything');
  const labelFits = await label.evaluate(element => element.scrollWidth <= element.clientWidth);
  assert.ok(labelFits, 'the visible search label is not truncated in the desktop sidebar');
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await sidebar.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, 'sidebar-simple-search.png') });
  const searchBounds = await search.boundingBox();
  const padBounds = await sidebar.locator('.side-pad').boundingBox();
  assert.ok(searchBounds.width >= padBounds.width * 0.9, `search button ${searchBounds.width}px spans the ${padBounds.width}px sidebar pad`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const paletteInput = palette.getByRole('combobox', { name: 'Search threads, machines, actions' });
  await search.click();
  await palette.waitFor();
  await paletteInput.fill('rocket');
  await palette.getByRole('option', { name: /Rocket thread/ }).waitFor();
  await paletteInput.fill('laptop');
  await palette.getByRole('option', { name: 'laptop online' }).waitFor();
  await page.keyboard.press('Escape');
  await palette.waitFor({ state: 'hidden' });
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('/');
  await palette.waitFor();
  await page.keyboard.press('Control+k');
  await palette.waitFor({ state: 'hidden' });
  await page.keyboard.press('Control+k');
  await palette.waitFor();
  await page.keyboard.press('Escape');
  const selectedMachine = sidebar.locator('.row.machine[aria-current="true"]');
  await selectedMachine.waitFor();
  assert.match(await selectedMachine.getAttribute('class'), /\bactive\b/);
  const selectedStyle = await selectedMachine.evaluate(element => ({
    background: getComputedStyle(element).backgroundColor,
    barDisplay: getComputedStyle(element, '::after').display,
  }));
  assert.notEqual(selectedStyle.background, 'rgba(0, 0, 0, 0)', 'the selected machine keeps its highlight');
  assert.equal(selectedStyle.barDisplay, 'none', 'the selected machine has no left bar');
  const otherActiveBar = await page.evaluate(() => {
    const list = document.createElement('div');
    list.className = 'rows';
    list.innerHTML = '<button class="row active">Other list</button>';
    document.querySelector('.main').append(list);
    const bar = getComputedStyle(list.firstChild, '::after');
    const barStyle = { display: bar.display, width: bar.width };
    list.remove();
    return barStyle;
  });
  assert.deepEqual(otherActiveBar, { display: 'block', width: '3px' }, 'other active rows keep the shared bar');
});

test('The palette searches remembered threads of offline machines, deduped and filtered', async testContext => {
  const { page, boot } = await pageFor(testContext, { width: 1280, height: 800 });
  await boot();
  await page.evaluate(() => {
    const now = Date.now();
    const session = (id, title, more={}) => ({id,title,cwd:'/work/live',engine:'codex',profileId:'codex',
      driver:'codex',turns:1,status:'idle',updatedAt:now,...more});
    window.workspace.saveWorkspace(window.scope, {
      environments: [{id:'nas',name:'nas',online:false,lastSeen:now-7200000,info:{}}],
      sessions: { nas: [session('dup','Cached dup',{cwd:'/srv/dup'})] },
    });
    const client = window.makeClient([
      {id:'laptop',name:'laptop',online:true,info:{}},
      {id:'nas',name:'nas',online:false,lastSeen:now-7200000,info:{}},
    ], {laptop:[session('live','Live thread')]}, 'http://helm-test', {
      'brain.snapshot': () => { window.snapshotAt = Date.now(); return {snapshot:{machines:{nas:{name:'nas',at:now-3600000,sessions:[
        {id:'snap1',title:'Snapshot only',cwd:'/srv/archive-tool',engine:'codex',status:'idle',updatedAt:now-3600000,turns:1,driver:'codex'},
        {id:'dup',title:'Cached dup',cwd:'/srv/dup',engine:'codex',status:'idle',updatedAt:now-3600000,turns:1,driver:'codex'},
        {id:'kid',title:'Snapshot child',cwd:'/srv/archive-tool',engine:'codex',status:'idle',delegation:{parentId:'snap1'}},
        {id:'arch',title:'Snapshot archived',cwd:'/srv/archive-tool',engine:'codex',status:'idle',archived:true},
      ]}}}}; },
    });
    window.mount(client);
  });
  await page.waitForFunction(() => window.snapshotAt);
  const sidebar = page.locator('.sidebar');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const paletteInput = palette.getByRole('combobox', { name: 'Search threads, machines, actions' });
  await sidebar.getByRole('button', { name: 'Search threads, machines and folders' }).click();
  await palette.waitFor();
  await paletteInput.fill('archive-tool');
  const snapshotOnly = palette.getByRole('option', { name: /Snapshot only/ });
  await snapshotOnly.waitFor();
  const snapshotOnlyText = await snapshotOnly.textContent();
  assert.match(snapshotOnlyText, /nas/);
  assert.match(snapshotOnlyText, /offline/);
  assert.equal(await palette.getByRole('option', { name: /Snapshot child/ }).count(), 0);
  assert.equal(await palette.getByRole('option', { name: /Snapshot archived/ }).count(), 0);
  await paletteInput.fill('Cached dup');
  assert.equal(await palette.getByRole('option', { name: /Cached dup/ }).count(), 1, 'cached and snapshot copies dedupe by id');
  await paletteInput.fill('archive-tool');
  await snapshotOnly.click();
  await palette.waitFor({ state: 'hidden' });
  await page.locator('.main.showing .session-bar').filter({ hasText: 'Snapshot only' }).waitFor();
});

for (const width of [1280, 390]) test(`one VM brain stays the entry point while offline at ${width}px`, async t => {
  const { page, boot } = await pageFor(t, {width,height:900});
  await boot();
  await page.evaluate(()=>{
    const vmBrain = {id:'vm-brain',title:'Brain',brain:true,engine:'codex',profileId:'codex',driver:'codex',cwd:'/home/ubuntu',status:'idle'};
    localStorage.setItem('helm.brains',JSON.stringify([{envId:'vm',session:vmBrain}]));
    window.mount(window.makeClient([
      {id:'laptop',name:'Laptop',online:true,info:{}},
      {id:'why',name:'why',kind:'pc',online:true,info:{}},
      {id:'vm',name:'VM',online:false,info:{}},
    ],{laptop:[{...vmBrain,id:'former-laptop-brain'}],why:[]}));
  });
  const entry = page.locator('.sidebar').getByRole('button',{name:/Helm brain/});
  await entry.waitFor();
  assert.equal(await entry.count(),1);
  assert.match(await entry.innerText(),/VM.*offline/s);
  await entry.click();
  await page.getByRole('heading',{name:'Brain',exact:true}).waitFor();
  assert.equal(await page.getByText('Choose its account',{exact:true}).count(),0,'a cold offline open retains the VM conversation');
  assert.match(await page.locator('.main .bar .sub').innerText(),/VM/);
});

test('opening the online brain validates the VM provider before entering the conversation', async t => {
  const {page,boot}=await pageFor(t,{width:390,height:900});
  await boot();
  await page.evaluate(()=>{
    const brain={id:'vm-brain',title:'Helm brain',brain:true,engine:'codex',profileId:'codex',driver:'codex',cwd:'/home/ubuntu',status:'idle'};
    const client=window.makeClient([{id:'laptop',name:'Laptop',online:true,info:{}},{id:'vm',name:'VM',online:true,info:{}}],{vm:[brain],laptop:[]});
    const rpc=client.rpc;
    window.brainCalls=[];
    client.rpc=(env,method,params)=>{window.brainCalls.push({env,method,params});return method==='brain.open' ? Promise.resolve({session:brain,envId:'vm',created:false}) : rpc(env,method,params)};
    window.mount(client);
  });
  await page.locator('.sidebar').getByRole('button',{name:/Helm brain/}).click();
  await page.getByRole('heading',{name:'Helm brain',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.brainCalls.filter(c=>c.method==='brain.open').map(c=>c.env)),['vm']);
});

const PROVIDERS = ['devin', 'opencode', 'opencode2', 'agy', 'antigravity', 'pi', 'omp', 'cursor', 'grok', 'codex', 'claude',
  'rovo', 'gemini', 'kimi', 'muse'];

for (const width of [1280, 390]) test(`every provider stays Running until idle and only idle reaches Done at ${width}px`, async testContext => {
  const { page, boot } = await pageFor(testContext, { width, height: 900 });
  await boot();
  await page.evaluate((providers) => {
    const now = Date.now();
    const listeners = new Set();
    const sessions = providers.flatMap((engine) => {
      const session = (state, more) => ({ id: `${engine}-${state}`, title: `${engine} ${state}`, cwd: '/project/helm', engine,
        profileId: engine, driver: engine, turns: 1, status: 'idle', alive: true, updatedAt: now, ...more });
      return [
        session('starting', { status: 'starting', recovery: { kind: 'restart', message: 'old', at: now - 1000 } }),
        session('working', { status: 'working' }),
        session('children', { team: { working: 1, blocked: 0, failed: 0 } }),
        session('approval', { status: 'blocked', pending: 1, ask: { kind: 'command', text: 'npm test' } }),
        session('idle', {}),
        session('exited', { status: 'exited', alive: false }),
        session('unknown', { status: 'unknown' }),
      ];
    });
    window.sessions = sessions;
    const client = window.makeClient([{ id: 'laptop', name: 'Laptop', online: true, info: {} }], { laptop: sessions });
    client.on = listener => { listeners.add(listener); return () => listeners.delete(listener); };
    window.push = (id, more) => {
      const s = sessions.find((x) => x.id === id);
      Object.assign(s, more);
      for (const listener of listeners) listener('laptop', 'session.update', { session: { ...s } });
    };
    window.mount(client);
  }, PROVIDERS);
  const sidebar = page.locator('.sidebar');
  const running = sidebar.locator('div.section', { hasText: /^running$/ }).locator('xpath=following-sibling::div[1]');
  const done = sidebar.locator('.foldwrap').filter({ has: page.locator('.fold-title', { hasText: /^done$/ }) });
  await running.locator('.tri-title').first().waitFor();
  const n = PROVIDERS.length;
  assert.equal(await running.locator('.thread-row').count(), n * 3, 'starting, working and child work are all running');
  assert.equal(await sidebar.locator('.need').count(), n, 'each blocked approval is a Needs you card');
  await done.getByRole('button', { name: `done ${n}`, exact: true }).click();
  const doneTitles = await done.locator('.tri-title').allTextContents();
  assert.deepEqual(doneTitles.sort(), PROVIDERS.map((engine) => `${engine} idle`).sort(), 'only idle threads are done');
  for (const engine of PROVIDERS) {
    for (const state of ['starting', 'working', 'children']) {
      assert.equal(await running.getByText(`${engine} ${state}`, { exact: true }).count(), 1, `${engine} ${state} is running`);
    }
    assert.equal(await sidebar.locator('.need').getByText(`${engine} approval`, { exact: true }).count(), 1);
    for (const state of ['exited', 'unknown']) {
      assert.equal(await sidebar.getByText(`${engine} ${state}`, { exact: true }).count(), 0, `${engine} ${state} is not shown as finished`);
    }
  }
  const starting = running.locator('.thread-row').filter({ hasText: 'claude starting' });
  assert.equal(await starting.locator('.chip').textContent(), 'starting');
  assert.equal(await running.locator('.thread-row').filter({ hasText: 'claude children' }).locator('.chip.working').count(), 1);
  const laptop = sidebar.locator('.row.machine').filter({ hasText: 'Laptop' });
  assert.equal(await laptop.locator('.rm').textContent(), `${n * 3} running · ${n} status unavailable`,
    'threads the machine cannot read are counted, not called idle');
  assert.equal(await laptop.locator('.badge').textContent(), String(n));

  // A turn that finishes moves to Done; a new turn moves it back at once.
  await page.evaluate(() => window.push('grok-working', { status: 'idle' }));
  await done.getByText('grok working', { exact: true }).waitFor();
  assert.equal(await running.getByText('grok working', { exact: true }).count(), 0);
  await page.evaluate(() => window.push('grok-working', { status: 'working' }));
  await running.getByText('grok working', { exact: true }).waitFor();
  assert.equal(await done.getByText('grok working', { exact: true }).count(), 0);
  // An approval that is answered goes back to Running, not Done.
  await page.evaluate(() => window.push('pi-approval', { status: 'working', pending: 0 }));
  await running.getByText('pi approval', { exact: true }).waitFor();
  assert.equal(await done.getByText('pi approval', { exact: true }).count(), 0);
  // A thread that is closed while the list is catching up never flashes into Done.
  await page.evaluate(() => window.push('cursor-idle', { status: 'exited', alive: false }));
  await done.getByText('cursor idle', { exact: true }).waitFor({ state: 'detached' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
  await page.screenshot({ path: `/tmp/helm-running-done-${width}.png` });

  // The machine screen sorts the same threads the same way.
  await laptop.click();
  const main = page.locator('.main');
  const working = main.locator('div.section', { hasText: /^working$/ }).locator('xpath=following-sibling::div[1]');
  await working.locator('.rowx').first().waitFor();
  assert.equal(await working.locator('.rowx').count(), n * 3 + 1, 'machine screen counts the same running threads as the sidebar');
  assert.equal(await working.locator('.rowx').filter({ hasText: 'claude children' }).locator('.chip').textContent(), 'working');
  assert.equal(await working.locator('.rowx').filter({ hasText: 'claude starting' }).locator('.chip').textContent(), 'starting');
  // Searching opens every fold, so the rows below "recent" are on screen.
  await main.getByPlaceholder('search Laptop').fill('unknown');
  for (const engine of PROVIDERS) {
    const unknown = main.locator('.rowx').filter({ hasText: `${engine} unknown` });
    await unknown.waitFor();
    assert.equal(await unknown.locator('.chip').textContent(), 'status unavailable', `${engine} unknown says so on the machine screen`);
  }
  await page.screenshot({ path: `/tmp/helm-machine-unknown-${width}.png` });
  await main.getByPlaceholder('search Laptop').fill('exited');
  await main.locator('.rowx').filter({ hasText: 'claude exited' }).waitFor();
  assert.equal(await main.locator('.rowx .chip.done').count(), 0, 'a closed agent is never shown as done');
});

test('a list read before a live update cannot undo it', async testContext => {
  const { page, boot } = await pageFor(testContext, { width: 390, height: 844 });
  await boot();
  await page.evaluate(() => {
    const listeners = new Set();
    const thread = { id: 'race', title: 'Racing thread', cwd: '/project', engine: 'opencode', profileId: 'opencode', driver: 'opencode',
      turns: 1, status: 'idle', alive: true, updatedAt: Date.now() };
    const client = window.makeClient([{ id: 'vm', name: 'VM', online: true, info: {} }], {});
    client.on = listener => { listeners.add(listener); return () => listeners.delete(listener); };
    window.lists = [];
    window.hold = false;
    client.rpc = (env, method) => {
      if (method !== 'session.list') return new Promise(() => {});
      // What the machine says, read at the moment the list was asked for.
      const snapshot = [{ ...thread }];
      if (!window.hold) return Promise.resolve({ sessions: snapshot });
      return new Promise((resolve) => window.lists.push(() => resolve({ sessions: snapshot })));
    };
    window.push = (more) => {
      Object.assign(thread, more);
      for (const listener of listeners) listener('vm', 'session.update', { session: { ...thread } });
    };
    window.mount(client);
  });
  const sidebar = page.locator('.sidebar');
  const running = sidebar.locator('div.section', { hasText: /^running$/ }).locator('xpath=following-sibling::div[1]');
  const done = sidebar.locator('.foldwrap').filter({ has: page.locator('.fold-title', { hasText: /^done$/ }) });
  await done.getByRole('button', { name: 'done 1', exact: true }).waitFor();
  // A list goes out while the thread is idle and takes a while to come back.
  await page.evaluate(() => { window.hold = true; window.push({ title: 'Racing thread' }); });
  await page.waitForFunction(() => window.lists.length === 1);
  // The thread starts a turn before that old list arrives.
  await page.evaluate(() => window.push({ status: 'working' }));
  await running.getByText('Racing thread', { exact: true }).waitFor();
  await page.waitForTimeout(600);
  await page.evaluate(() => window.lists.shift()());
  await page.waitForTimeout(100);
  assert.equal(await running.getByText('Racing thread', { exact: true }).count(), 1, 'the old idle list does not move it to Done');
  assert.equal(await done.count(), 0);
  // And it asks again rather than waiting for the half-minute check.
  await page.waitForFunction(() => window.lists.length === 1);
  await page.evaluate(() => window.lists.shift()());
  await page.waitForTimeout(100);
  assert.equal(await running.getByText('Racing thread', { exact: true }).count(), 1);
  // The same holds the other way: a finished turn is not put back in Running.
  await page.evaluate(() => window.push({ title: 'Racing thread' }));
  await page.waitForFunction(() => window.lists.length === 1);
  await page.evaluate(() => window.push({ status: 'idle' }));
  await done.getByRole('button', { name: 'done 1', exact: true }).waitFor();
  await page.waitForTimeout(600);
  await page.evaluate(() => { window.lists.shift()(); });
  await page.waitForTimeout(100);
  assert.equal(await sidebar.locator('div.section', { hasText: /^running$/ }).count(), 0, 'the old working list does not bring it back');
});

for (const width of [1280, 390]) test(`an offline machine's last known work is not shown as working at ${width}px`, async testContext => {
  const { page, boot } = await pageFor(testContext, { width, height: 844 });
  await boot();
  await page.evaluate(() => {
    const now = Date.now();
    const stale = { id: 'stale', title: 'Was busy', cwd: '/project', engine: 'antigravity', profileId: 'antigravity', driver: 'antigravity',
      turns: 1, status: 'working', updatedAt: now - 3600000 };
    const machine = { id: 'pc', name: 'HomePC', online: false, lastSeen: now - 3600000, info: {} };
    window.workspace.saveWorkspace(window.scope, { environments: [machine], sessions: { pc: [stale] } });
    const client = window.makeClient([machine], {});
    // A machine that is not connected cannot answer at all.
    client.rpc = () => Promise.reject(new Error('not connected'));
    window.mount(client);
  });
  const sidebar = page.locator('.sidebar');
  const machine = sidebar.locator('.row.machine').filter({ hasText: 'HomePC' });
  await machine.waitFor();
  assert.equal(await sidebar.locator('div.section', { hasText: /^running$/ }).count(), 0);
  assert.equal(await sidebar.getByText('Was busy', { exact: true }).count(), 0);
  await machine.click();
  const main = page.locator('.main');
  const row = main.locator('.rowx').filter({ hasText: 'Was busy' });
  await row.waitFor();
  assert.equal(await main.locator('div.section', { hasText: /^working$/ }).count(), 0, 'no working section on a machine that cannot answer');
  assert.equal(await row.locator('.chip').textContent(), 'was working');
  await page.screenshot({ path: `/tmp/helm-offline-machine-${width}.png` });
});

test('a working brain says so in the sidebar, where its machine count already includes it', async testContext => {
  const { page, boot } = await pageFor(testContext, { width: 390, height: 844 });
  await boot();
  await page.evaluate(() => {
    const brain = { id: 'brain', title: 'Helm brain', cwd: '/home/helm', engine: 'claude', profileId: 'claude', driver: 'claude',
      turns: 1, status: 'working', alive: true, brain: true, updatedAt: Date.now() };
    window.mount(window.makeClient([{ id: 'vm', name: 'VM', online: true, info: {} }], { vm: [brain] }));
  });
  const sidebar = page.locator('.sidebar');
  await sidebar.locator('.brain-entry .chip.working').waitFor();
  assert.equal(await sidebar.locator('.row.machine').filter({ hasText: 'VM' }).locator('.rm').textContent(), '1 running');
  assert.equal(await sidebar.locator('.thread-row').count(), 0, 'the brain keeps its own place, not a second row');
});
