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
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

async function pageFor(testContext, viewport) {
  const context = await browser.newContext({ viewport });
  testContext.after(() => context.close());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://helm-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://helm-test/');
  const boot = async () => { await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script }); };
  testContext.after(() => assert.deepEqual(errors, []));
  return { page, boot };
}

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
  assert.equal(await page.getByRole('button', { name: /^Reload app/ }).count(), 1);
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
  const titles = await done.locator('.rt-text').allTextContents();
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

test('Running counts only count working threads on online machines', async testContext => {
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
  await done.getByRole('button', { name: 'done 2', exact: true }).click();
  assert.ok(await done.getByText('Idle alive', { exact: true }).isVisible());
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
