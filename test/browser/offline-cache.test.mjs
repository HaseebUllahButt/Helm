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
    import { Shell } from './apps/web/src/App';
    import * as cache from './apps/web/src/session/logCache';
    import * as workspace from './apps/web/src/workspaceCache';
    import { txn, idb } from './apps/web/src/idb';
    import { apply, emptyLog } from './apps/web/src/session/types';
    import { useSessionLog } from './apps/web/src/session/useSessionLog';
    const root = createRoot(document.getElementById('root'));
    const token = 'helm1.' + btoa(JSON.stringify({net:'network',sub:'device'})) + '.test';
    const scope = workspace.workspaceScope(token);
    const listeners = new Set();
    const client = {token,relay:'http://helm-test',
      environments:()=>window.envs?window.envs():new Promise(()=>{}),
      on:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},subscribe:()=>{},
      watchLatency:()=>()=>{},openDirect:async()=>{},route:async()=>null,
      latency:()=>null,directTo:()=>false,
      rpc:(...args)=>window.reads?window.reads(...args):new Promise(()=>{}),
    };
    const session = id => ({id,title:id,cwd:'/project',engine:'codex',profileId:'codex',driver:'codex',
      turns:1,status:'working',updatedAt:Date.now()});
    const events = (text='Saved response',id='turn') => [
      {seq:1,at:1,type:'turn.start',turnId:id,text:'Saved question'},
      {seq:2,at:2,type:'item.start',turnId:id,id:'reply',kind:'text'},
      {seq:3,at:3,type:'item.delta',id:'reply',text},
    ];
    window.seed = async () => {
      workspace.saveWorkspace(scope,{environments:[{id:'machine',name:'Laptop',online:true,lastSeen:null,info:{}}],
        sessions:{machine:[session('Cached chat'),session('Another chat')]},
        view:{envId:'machine',session:session('Cached chat')}});
      await cache.saveCached('machine','Cached chat',3,events(),1);
      await cache.saveCached('machine','Another chat',3,events('Other saved response'),1);
      await txn('kv','readonly',s=>s.get('helm.workspace:'+scope));
    };
    function Probe(){const state=useSessionLog(client,'machine','Cached chat');window.state=state;return <pre>{JSON.stringify(state.log)}</pre>}
    window.mount = () => root.render(<Shell client={client} conn={{online:false,reachable:false}} onSignOut={()=>{}}/>);
    window.unmount = () => root.render(null);
    window.probe = () => root.render(<Probe/>);
    Object.assign(window,{cache,workspace,txn,idb,scope,events,session,apply,emptyLog});
  `, resolveDir: process.cwd(), loader: 'tsx' }, plugins: [{ name: 'test-shell-export', setup(b) {
    b.onLoad({ filter: /\/App\.tsx$/ }, async ({ path }) => ({ contents: await readFile(path, 'utf8') + '\nexport { Shell };', loader: 'tsx' }));
  } }], bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());
async function pageFor(t) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('http://helm-test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://helm-test/');
  const boot = async () => { await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script }); };
  await boot();
  t.after(() => assert.deepEqual(errors, []));
  return { page, boot };
}

async function openFromSearch(page, title) {
  await page.locator('.sidebar').getByRole('button', { name: 'Search threads, machines and folders' }).click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox', { name: 'Search threads, machines, actions' }).fill(title);
  await palette.getByRole('option', { name: new RegExp(`^${title}.*offline`) }).click();
  await palette.waitFor({ state: 'hidden' });
}

test('saved workspace and chat open with every network request stalled, including after a reload', async t => {
  const { page, boot } = await pageFor(t);
  await page.evaluate(() => window.seed());
  for (let pass = 0; pass < 2; pass++) {
    await page.evaluate(() => window.mount());
    await page.getByText('Saved response', { exact: true }).waitFor({ timeout: 1500 });
    assert.match(await page.locator('.session-bar').innerText(), /Saved chat.*reconnecting/);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const sidebar = page.locator('.sidebar');
    assert.equal(await sidebar.getByText('Another chat', { exact: true }).count(), 0, 'disconnected threads are not listed as running');
    await openFromSearch(page, 'Another chat');
    await page.getByText('Other saved response', { exact: true }).waitFor({ timeout: 1500 });
    await openFromSearch(page, 'Cached chat');
    await page.getByText('Saved response', { exact: true }).waitFor({ timeout: 1500 });
    if (!pass) { await page.reload(); await boot(); }
  }
});

test('durable workspace restores the selected chat when the localStorage mirror is missing', async t => {
  const { page, boot } = await pageFor(t);
  await page.evaluate(async () => { await window.seed(); localStorage.clear(); });
  await page.reload(); await boot();
  await page.evaluate(() => window.mount());
  await page.getByText('Saved response', { exact: true }).waitFor({ timeout: 1500 });
});

test('returning to a chat sees the latest in-memory save even when disk is unavailable', async t => {
  const { page } = await pageFor(t);
  const result = await page.evaluate(async () => {
    await window.seed();
    IDBDatabase.prototype.transaction = () => { throw Error('disk unavailable'); };
    const latest = [...window.events(), {seq:4,at:4,type:'item.delta',id:'reply',text:' latest'}];
    const writing = window.cache.saveCached('machine','Cached chat',4,latest,1);
    const read = await window.cache.loadCached('machine','Cached chat');
    await writing;
    return read;
  });
  assert.equal(result.last, 4);
  assert.equal(result.events.at(-1).text, ' latest');
});

test('a request that succeeds before its transaction aborts is never reported saved', async t => {
  const { page } = await pageFor(t);
  const result = await page.evaluate(async () => {
    let rejected = false;
    try { await window.txn('kv', 'readwrite', s => {
      const req = s.put('not committed', 'abort-test');
      req.addEventListener('success', () => s.transaction.abort());
      return req;
    }); } catch { rejected = true; }
    return {rejected,stored:await window.txn('kv','readonly',s=>s.get('abort-test'))};
  });
  assert.deepEqual(result, { rejected: true, stored: undefined });
});

test('cache eviction reads ordered keys instead of copying all transcript payloads', async t => {
  const { page } = await pageFor(t);
  const count = await page.evaluate(async () => {
    IDBObjectStore.prototype.getAll = () => { throw Error('payload scan forbidden'); };
    for(let i=0;i<35;i++) await window.cache.saveCached('machine',String(i),3,window.events(),1);
    return (await window.txn('session-logs','readonly',s=>s.getAllKeys())).length;
  });
  assert.equal(count,25);
});

test('trimming a long cached turn retains its real owner even behind queued steering', async t => {
  const { page } = await pageFor(t);
  const result = await page.evaluate(async () => {
    const events = window.events();
    events.push({seq:4,at:4,type:'turn.start',turnId:'ticket',text:'Queued steering',queued:true});
    for(let seq=5;seq<4205;seq++) events.push({seq,at:seq,type:'item.delta',id:'reply',text:'x'});
    await window.cache.saveCached('machine','long',4204,events,1);
    const cached = await window.cache.loadCached('machine','long');
    const log = window.emptyLog(); cached.events.forEach(e=>window.apply(log,e));
    return {first:cached.first,turn:log.turns.find(t=>t.id==='turn'),count:cached.events.length};
  });
  assert.equal(result.first,205);
  assert.equal(result.turn.items[0].text.length,4000);
  assert.equal(result.count,4002);
});

test('a blocked cache transaction cannot hold up healthy network history or overwrite it later', async t => {
  const { page } = await pageFor(t);
  await page.evaluate(() => window.seed());
  // A reload clears the RAM mirror; keep the saved IndexedDB record.
  await page.reload(); await page.addScriptTag({content:script});
  await page.evaluate(async () => {
    const db = await window.idb();
    const tx = db.transaction('session-logs','readwrite'), store = tx.objectStore('session-logs');
    window.releaseDisk = false;
    const hold = () => { const r=store.get('holding');r.onsuccess=()=>{if(!window.releaseDisk)hold();}; };
    hold();
    window.reads = async (env,method) => method==='session.events'
      ? {events:window.events('Fresh network response'),last:3,firstSeq:1,logFirst:1,pending:[]}
      : {last:3};
    window.probe();
  });
  await page.waitForFunction(()=>window.state?.log.loaded && !window.state.syncing, null, {timeout:1500});
  assert.match(await page.locator('pre').innerText(), /Fresh network response/);
  await page.evaluate(() => { window.releaseDisk=true; });
  await page.waitForFunction(()=>window.state.log.turns[0].items[0].text==='Fresh network response');
});

test('workspace cache separates memberships and omits provider configuration', async t => {
  const { page } = await pageFor(t);
  const result = await page.evaluate(async () => {
    await window.seed();
    window.workspace.saveWorkspace(window.scope,{sessions:{machine:[{...window.session('safe'),env:{SECRET:'private'},token:'private'}]}});
    return {other:window.workspace.loadWorkspace('other:device'),raw:localStorage.getItem('helm.workspace:'+window.scope)};
  });
  assert.deepEqual(result.other,{environments:[],sessions:{}});
  assert.doesNotMatch(result.raw,/SECRET|private/);
});

test('malformed cached navigation cannot crash the app on startup', async t => {
  const { page } = await pageFor(t);
  const result = await page.evaluate(() => {
    localStorage.setItem('helm.workspace:broken',JSON.stringify({environments:[null],sessions:{machine:null},view:{session:{}}}));
    return window.workspace.loadWorkspace('broken');
  });
  assert.deepEqual(result,{environments:[],sessions:{}});
});

test('a fast live machine list preserves saved threads and navigation from a slower disk read', async t => {
  const { page, boot } = await pageFor(t);
  await page.evaluate(async()=>{await window.seed();localStorage.clear();});
  await page.reload();await boot();
  const result = await page.evaluate(async()=>{
    const reading=window.workspace.loadWorkspaceDurable(window.scope);
    await Promise.resolve();
    window.workspace.saveWorkspace(window.scope,{environments:[{id:'machine',name:'Fresh laptop',online:true,lastSeen:null,info:{}}]});
    return await reading;
  });
  assert.equal(result.environments[0].name,'Fresh laptop');
  assert.equal(result.sessions.machine.length,2);
  assert.equal(result.view.session.id,'Cached chat');
});

test('a machine response after sign-out cannot recreate forgotten workspace metadata', async t => {
  const {page}=await pageFor(t);
  await page.evaluate(async()=>{
    await window.seed();
    window.envs=()=>new Promise(resolve=>{window.finishEnvs=resolve});
    window.mount();
  });
  await page.waitForFunction(()=>typeof window.finishEnvs==='function');
  await page.evaluate(()=>window.unmount());
  await page.waitForFunction(()=>!document.querySelector('#root').childElementCount);
  const result=await page.evaluate(async()=>{
    window.workspace.forgetWorkspace(window.scope);
    window.finishEnvs({environments:[{id:'machine',name:'Late',online:true,lastSeen:null,info:{}}]});
    await new Promise(resolve=>setTimeout(resolve,20));
    return window.workspace.loadWorkspace(window.scope);
  });
  assert.deepEqual(result,{environments:[],sessions:{}});
});

test('cached imported transcripts survive disconnection and refresh on focus without overlapping requests', async t => {
  const { page } = await pageFor(t);
  await page.evaluate(async () => {
    await window.seed();
    const session = {...window.session('Imported chat'),driver:undefined,external:true};
    window.workspace.saveWorkspace(window.scope,{sessions:{machine:[session]},view:{envId:'machine',session}});
    await window.cache.saveMessages('machine','Imported chat',[{role:'assistant',text:'Imported saved answer',tools:[]}]);
    window.calls=0;window.fail=true;
    window.reads=async(env,method)=>{
      if(method!=='session.messages')return new Promise(()=>{});
      window.calls++;
      if(window.fail)throw Error('offline');
      await new Promise(r=>{window.finishRead=r;});
      return {messages:[{role:'assistant',text:'Fresh imported answer',tools:[]}]};
    };
    window.mount();
  });
  await page.getByText('Imported saved answer',{exact:true}).waitFor();
  assert.equal(await page.getByRole('alert').count(),0);
  await page.evaluate(()=>{window.fail=false;window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>window.calls===2&&typeof window.finishRead==='function');
  await page.evaluate(()=>window.finishRead());
  await page.getByText('Fresh imported answer',{exact:true}).waitFor();
  await page.waitForFunction(()=>window.calls===3);
  await page.evaluate(()=>window.finishRead());
});

test('resuming on HTTP clears the saved-workspace disconnect notice without waiting for WebSocket', async t => {
  const {page}=await pageFor(t);
  await page.evaluate(async()=>{
    await window.seed();window.failed=true;
    window.envs=async()=>{
      if(window.failed)throw Error('Failed to fetch');
      return {environments:[{id:'machine',name:'Recovered machine',online:true,lastSeen:null,info:{}}]};
    };
    window.mount();
  });
  await page.getByText('Saved workspace · reconnecting…',{exact:true}).waitFor();
  assert.equal(await page.locator('.sidebar .error').count(),0);
  await page.evaluate(()=>{window.failed=false;window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>!document.querySelector('.sidebar').textContent.includes('Saved workspace · reconnecting'));
  await page.locator('.sidebar').getByText('Recovered machine',{exact:true}).waitFor();
});
