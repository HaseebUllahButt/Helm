import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useWorkspaceData } from './apps/web/src/useWorkspaceData';
    import * as workspace from './apps/web/src/workspaceCache';
    const token='helm1.'+btoa(JSON.stringify({net:'workspace-test',sub:'device'}))+'.test';
    const listeners=new Set();
    window.subscriptions=0;
    const client={token,
      environments:()=>window.readEnvs(),
      rpc:(...args)=>window.readRpc(...args),
      on:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
      subscribe:()=>{window.subscriptions++},
    };
    window.emit=(env,kind,payload)=>listeners.forEach(fn=>fn(env,kind,payload));
    window.seed=(session)=>{workspace.saveWorkspace(workspace.workspaceScope(token),{
      environments:[{id:'machine',name:'Laptop',online:false,info:{}}],sessions:{machine:[session]}});workspace.writeWorkspaces()};
    function Probe(){
      const data=useWorkspaceData(client,true);
      window.data=data;
      return <pre>{JSON.stringify({envs:data.envs,sessions:data.sessions,error:data.envError})}</pre>;
    }
    window.mount=()=>createRoot(document.getElementById('root')).render(<Probe/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false,
    format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
});
after(async () => browser?.close());

async function pageFor(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://helm-workspace-test/**', route => route.fulfill({
    contentType: 'text/html', body: '<div id="root"></div>',
  }));
  await page.goto('http://helm-workspace-test/');
  await page.addScriptTag({ content: script });
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

test('overlapping machine reads queue one fresh read and keep the latest result', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    window.calls = 0;
    window.readEnvs = () => {
      const call = ++window.calls;
      if (call === 1) return new Promise(resolve => { window.releaseFirst = resolve; });
      return Promise.resolve({ environments: [{ id: 'new', name: 'New', online: true, info: {} }] });
    };
    window.readRpc = () => new Promise(() => {});
    window.mount();
  });
  await page.waitForFunction(() => typeof window.releaseFirst === 'function');
  await page.evaluate(() => { window.data.loadEnvs(); window.data.loadEnvs(); });
  assert.equal(await page.evaluate(() => window.calls), 1);
  await page.evaluate(() => window.releaseFirst({ environments: [{ id: 'old', name: 'Old', online: true, info: {} }] }));
  await page.waitForFunction(() => window.data.envs[0]?.id === 'new');
  assert.equal(await page.evaluate(() => window.calls), 2);
});

test('the first live machine list is read once on mount', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    window.readEnvs = async () => ({ environments: [{ id: 'machine', name: 'Laptop', online: true, info: {} }] });
    window.listCalls = 0;
    window.readRpc = (_env, method) => {
      if (method === 'session.list') window.listCalls++;
      return Promise.resolve({ sessions: [] });
    };
    window.mount();
  });
  await page.waitForFunction(() => window.data.liveListsSeen.current.has('machine'));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.listCalls), 1);
  assert.equal(await page.evaluate(() => window.subscriptions), 1);
});

test('a live chat update survives an older list response and triggers one catch-up read', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    window.envCalls = 0;
    window.readEnvs = async () => ({ environments: ++window.envCalls === 1
      ? [{ id: 'machine', name: 'Laptop', online: true, info: {} }]
      : [{ id: 'machine', name: 'Laptop', online: true, info: {} }] });
    window.current = { id: 'chat', title: 'Chat', cwd: '/work', engine: 'codex', profileId: 'codex', driver: 'codex', status: 'working', updatedAt: 1 };
    window.seed(window.current);
    window.listCalls = 0;
    window.readRpc = (_env, method) => {
      if (method !== 'session.list') return Promise.resolve({});
      if (++window.listCalls === 1) return new Promise(resolve => { window.releaseList = resolve; });
      return Promise.resolve({ sessions: [window.current] });
    };
    window.mount();
  });
  await page.waitForFunction(() => window.data.envs[0]?.online, null, { timeout: 2500 });
  await page.waitForFunction(() => typeof window.releaseList === 'function', null, { timeout: 2500 });
  await page.evaluate(() => {
    window.current = { ...window.current, status: 'idle', updatedAt: 2 };
    window.emit('machine', 'session.update', { session: window.current });
  });
  await page.waitForFunction(() => window.data.sessions.machine?.[0]?.status === 'idle', null, { timeout: 2500 });
  await page.evaluate(() => window.releaseList({ sessions: [{ ...window.current, status: 'working', updatedAt: 1 }] }));
  await page.waitForFunction(() => window.data.liveListsSeen.current.has('machine') && window.listCalls === 2, null, { timeout: 2500 });
  await page.waitForFunction(() => window.data.sessions.machine?.[0]?.status === 'idle', null, { timeout: 2500 });
  assert.equal(await page.evaluate(() => window.data.sessions.machine[0].updatedAt), 2);
});
