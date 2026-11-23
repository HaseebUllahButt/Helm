import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

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
    window.makeClient = (envs, sessions, relay='http://helm-test', extra={}) => ({token, relay, pendingActions: () => [], failedActions: () => [], resumeActions: async () => [],
      input(env, params) { return this.rpc(env, 'session.input', params); },
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
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://helm-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://helm-test/');
  // Settled starts folded; these tests read its rows, so it starts open here.
  await page.evaluate(() => localStorage.setItem('helm-fold:sidebar:settled-folded', '1'));
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
  await page.getByText('Helm did not get a reply in time. Try again.', { exact: true }).waitFor();
  await page.evaluate(() => window.reconnect());
  await page.waitForFunction(() => window.projectRequests.length === 2);
  await page.evaluate(() => window.projectRequests[1].resolve({ projects: [] }));
  await page.getByText('Helm did not get a reply in time. Try again.', { exact: true }).waitFor({ state: 'detached' });
  await page.evaluate(() => { window.reconnect(); window.reconnect(); });
  await page.waitForFunction(() => window.projectRequests.length === 4);
  await page.evaluate(() => window.projectRequests[3].resolve({ projects: [] }));
  await page.evaluate(() => window.projectRequests[2].reject(new Error('stale disconnected')));
  assert.equal(await page.getByText('stale disconnected', { exact: true }).count(), 0);
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
        session('Unused',0,{turns:0}),session('Waiting',0,{status:'blocked'}),
        session('Empty terminal',0,{driver:undefined,turns:0,nativeCli:true,pty:true,alive:true,blank:true})],
      vm: [session('Yesterday',24*hour),...Array.from({length:31},(_,i)=>session('Recent '+i,(i+2)*60000))],
    };
    window.mount(window.makeClient(['laptop','vm'].map(id=>({id,name:id,online:true,info:{}})), sessions, 'https://private.sslip.io'));
  });
  const sidebar = page.locator('.sidebar');
  const done = sidebar.locator('.foldwrap').filter({ has: page.locator('.fold-title', { hasText: /^Settled$/ }) });
  // Ten to begin with; Show 25 more brings the rest.
  await done.locator('.tri-title').first().waitFor();
  assert.equal(await done.locator('.tri-title').count(), 10);
  await done.getByRole('button', { name: 'Show 25 more', exact: true }).click();
  const titles = await done.locator('.tri-title').allTextContents();
  assert.equal(titles.length, 35, 'all recent threads remain until their own retirement time');
  assert.deepEqual(titles.slice(-4), ['Newest', 'Yesterday', 'Two days ago', 'Almost retired']);
  assert.equal(titles[0], 'Recent 0');
  assert.equal(titles.includes('Retired'), false);
  assert.equal(await sidebar.locator('.diag').count(), 0);
  assert.doesNotMatch(await sidebar.innerText(), /sslip\.io|socket live/i);
  await page.clock.fastForward(30000);
  await done.getByText('Almost retired', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(await done.locator('.tri-title').count(), 34);
  await sidebar.getByRole('button', { name: 'Search chats, machines, and folders' }).click();
  const palette = page.getByRole('dialog', { name: 'Search and actions' });
  await palette.getByRole('combobox', { name: 'Search chats, machines, and actions' }).fill('Almost retired');
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
  const runningSection = sidebar.locator('.foldwrap').filter({ has: page.locator('.fold-title', { hasText: /^Running$/ }) });
  await runningSection.getByText('Busy', { exact: true }).waitFor();
  // Phone Home gives each machine a direct entry, including offline ones.
  assert.equal(await sidebar.locator('.phone-machines .row.machine').count(), 3);
  assert.equal(await runningSection.getByText('Idle alive', { exact: true }).count(), 0);
  assert.equal(await runningSection.getByText('External idle', { exact: true }).count(), 0);
  assert.equal(await runningSection.getByText('Shared idle', { exact: true }).count(), 0);
  assert.equal(await runningSection.getByText('Shared stopped', { exact: true }).count(), 0);
  assert.equal(await sidebar.getByText('Stale work', { exact: true }).count(), 0, 'a disconnected machine’s cached work is not shown as running');
  await sidebar.getByRole('button', { name: 'Search chats, machines, and folders' }).click();
  const palette = page.getByRole('dialog', { name: 'Search and actions' });
  await palette.getByRole('combobox', { name: 'Search chats, machines, and actions' }).fill('Stale work');
  const staleOption = palette.getByRole('option', { name: /^Stale work/ });
  assert.match(await staleOption.textContent(), /old · working · offline/);
  await staleOption.click();
  await page.locator('.main.showing .session-bar').filter({ hasText: 'Stale work' }).waitFor();
  await page.goBack();
  await page.locator('.sidebar.showing').waitFor();
  const readout = await page.locator('.main .home .home-state').textContent();
  assert.match(readout, /1 running/);
  assert.match(readout, /1 needs you/);
  const homeRows = page.locator('.main .home .row.machine');
  assert.equal(await homeRows.filter({ hasText: 'laptop' }).locator('.rm').textContent(), '1 running');
  assert.equal(await homeRows.filter({ hasText: 'laptop' }).locator('.badge').textContent(), '1');
  assert.match(await homeRows.filter({ hasText: 'vm' }).locator('.rm').textContent(), /^(Nothing is running\.|Idle · CPU \d+%)/);
  assert.match(await homeRows.filter({ hasText: 'old' }).locator('.rm').textContent(), /^Offline · seen 2d ago$/);
  const done = sidebar.locator('.foldwrap').filter({ has: page.locator('.fold-title', { hasText: /^Settled$/ }) });
  assert.equal(await done.locator('.tri-title').count(), 5);
  assert.ok(await done.getByText('Idle alive', { exact: true }).isVisible());
  assert.ok(await done.getByText('Shared stopped', { exact: true }).isVisible());
});


const PROVIDERS = ['devin', 'opencode', 'opencode2', 'agy', 'antigravity', 'pi', 'omp', 'cursor', 'grok', 'codex', 'claude',
  'gemini', 'kimi', 'muse'];

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
  const running = sidebar.locator('.foldwrap').filter({ has: page.locator('.fold-title', { hasText: /^Running$/ }) });
  const done = sidebar.locator('.foldwrap').filter({ has: page.locator('.fold-title', { hasText: /^Settled$/ }) });
  await running.locator('.tri-title').first().waitFor();
  const n = PROVIDERS.length;
  assert.equal(await running.locator('.thread-row').count(), n * 3, 'starting, working and child work are all running');
  assert.equal(await sidebar.locator('.need').count(), n, 'each blocked approval is a Needs you card');
  await done.locator('.tri-title').first().waitFor();
  const more = done.getByRole('button', { name: /^Show \d+ more$/ });
  while (await more.count()) await more.click();
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
  assert.equal(await starting.locator('.tstat.working').textContent(), 'starting');
  assert.equal(await running.locator('.thread-row').filter({ hasText: 'claude children' }).locator('.tstat.working').count(), 1);
  // The machine counts live on Home (a computer's main pane).
  if (width > 500) {
    await page.getByRole('button', { name: 'Home' }).click();
    const laptop = page.locator('.main .home .row.machine').filter({ hasText: 'Laptop' });
    assert.equal(await laptop.locator('.rm').textContent(), `${n * 3} running`);
    assert.equal(await laptop.locator('.badge').textContent(), String(n));
  }

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
  await sidebar.getByRole('button', { name: 'Search chats, machines, and folders' }).click();
  await page.getByRole('combobox', { name: 'Search chats, machines, and actions' }).fill('Laptop');
  await page.getByRole('option', { name: /^Laptop online/ }).click();
  const main = page.locator('.main');
  const working = main.locator('div.section', { hasText: /^Running$/ }).locator('xpath=following-sibling::div[1]');
  await working.locator('.rowx').first().waitFor();
  assert.equal(await working.locator('.rowx').count(), n * 3 + 1, 'machine screen counts the same running threads as the sidebar');
  assert.equal(await working.locator('.rowx').filter({ hasText: 'claude children' }).locator('.chip').textContent(), 'working');
  assert.equal(await working.locator('.rowx').filter({ hasText: 'claude starting' }).locator('.chip').textContent(), 'starting');
  // Searching opens every fold, so the rows below "recent" are on screen.
  await main.getByPlaceholder('search Laptop').fill('unknown');
  for (const engine of PROVIDERS) {
    const unknown = main.locator('.rowx').filter({ hasText: `${engine} unknown` });
    await unknown.waitFor();
    assert.equal(await unknown.locator('.chip').textContent(), 'Status unknown', `${engine} unknown says so on the machine screen`);
  }
  await page.screenshot({ path: `/tmp/helm-machine-unknown-${width}.png` });
  await main.getByPlaceholder('search Laptop').fill('exited');
  await main.locator('.rowx').filter({ hasText: 'claude exited' }).waitFor();
  assert.equal(await main.locator('.rowx .chip.done').count(), 0, 'a closed agent is never shown as done');
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
  const search = sidebar.getByRole('button', { name: 'Search chats, machines, and folders' });
  await search.waitFor();
  assert.equal(await sidebar.locator('.fold-title', { hasText: /^Running$/ }).count(), 0);
  assert.equal(await sidebar.getByText('Was busy', { exact: true }).count(), 0);
  await search.click();
  await page.getByRole('combobox', { name: 'Search chats, machines, and actions' }).fill('HomePC');
  await page.getByRole('option', { name: /^HomePC offline/ }).click();
  const main = page.locator('.main');
  const row = main.locator('.rowx').filter({ hasText: 'Was busy' });
  await row.waitFor();
  assert.equal(await main.locator('div.section', { hasText: /^Running$/ }).count(), 0, 'no working section on a machine that cannot answer');
  assert.equal(await row.locator('.chip').textContent(), 'Last status: working');
  await page.screenshot({ path: `/tmp/helm-offline-machine-${width}.png` });
});
