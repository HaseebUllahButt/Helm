import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script, css;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {DrivenSession} from './apps/web/src/session/DrivenSession';
    import {MODES} from './packages/connect/src/modes.js';
    window.calls=[]; window.opened=[];
    const listeners=new Set();
    let seq=2;
    const options={models:['model-a','model-b','model-c','model-d','model-e','model-f','model-g'],
      more:['model-x','model-y'],
      labels:{'model-a':'Model A','model-b':'Model B','model-c':'Model C','model-d':'Model D','model-e':'Model E','model-f':'Model F','model-g':'Model G','model-x':'Model X','model-y':'Model Y'},
      default:'model-a',efforts:['low','medium','high'],modes:MODES.claude,favs:['model-y','model-c'],effortFavs:[],
      prefs:{default:'model-a',approved:[]},defaults:{effort:'low'}};
    const child={id:'kid-1',title:'Write the tests',engine:'claude',profileId:'claude',status:'idle',cwd:'/project',delegation:{parentId:'chat',status:'completed'}};
    const child2={...child,id:'kid-2',title:'Check the docs'};
    const client={pendingActions:()=>[],resumeActions:async()=>[],on:(l)=>{listeners.add(l);return()=>listeners.delete(l)},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
      if(method==='model.list') return options;
      if(method==='session.events') return {session:window.current,events:[{seq:1,at:Date.now(),type:'turn.start',turnId:'t1',text:'go'},{seq:2,at:Date.now(),type:'status',status:'working'}],pending:[],last:2,status:'working'};
      if(method==='session.watch') return {last:seq};
      if(method==='session.unwatch') return {};
      if(method==='session.list') return {sessions:params?.parentId ? [child,child2] : []};
      if(method==='session.commands') return {commands:[]};
      if(method==='usage.limits') return {accounts:[]};
      if(method==='git.status') return {repo:false};
      if(method==='agent.list') return {agents:[]};
      if(method==='schedule.list') return {schedules:[]};
      if(['session.model','session.effort','session.mode','session.speed'].includes(method)){
        window.calls.push({method,params});
        const kind=method.split('.')[1];return {session:{...window.current,[kind]:params[kind]}};
      }
      return {};
    }};
    function Chat(){
      const [session,setSession]=useState({id:'chat',engine:'claude',driver:'claude',profileId:'claude',model:'model-a',effort:'low',
        mode:'default',title:'Keys',status:'working',cwd:'/project'});
      window.current=session;
      return <DrivenSession client={client} env={{id:'laptop',name:'Laptop',online:true}} session={session}
        onSession={setSession} onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onOpenSession={(s)=>window.opened.push(s.id)}/>;
    }
    createRoot(document.getElementById('root')).render(<Chat/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

async function open(t) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6000);
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div class="session" id="root"></div>' }));
  await page.goto('http://helm.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await page.locator('button[title^="model:"]').waitFor();
  await page.locator('button[title^="thinking:"]').waitFor();
  return page;
}
const picked = (page, method) => page.evaluate(m => window.calls.filter(c => c.method === m).map(c => Object.values(c.params)[1]), method);

test('Ctrl+Shift+M steps favorites first, then the short list, never the long tail', async t => {
  const page = await open(t);
  // Ring: Model C (favorite), Model Y (favorite, from the long tail), then A, B, D..G.
  for (let i = 0; i < 4; i++) {
    const before = await page.evaluate(() => window.current.model);
    await page.keyboard.press('Meta+Shift+M');
    await page.waitForFunction(b => window.current.model !== b, before);
  }
  assert.deepEqual(await picked(page, 'session.model'), ['model-b', 'model-d', 'model-e', 'model-f']);
  for (let i = 0; i < 5; i++) {
    const before = await page.evaluate(() => window.current.model);
    await page.keyboard.press('Control+Shift+M');
    await page.waitForFunction(b => window.current.model !== b, before);
  }
  assert.deepEqual((await picked(page, 'session.model')).slice(4), ['model-g', 'model-c', 'model-y', 'model-a', 'model-b']);
});

test('Ctrl+Shift+A opens and closes the agents panel; arrows and Enter open a child chat', async t => {
  const page = await open(t);
  await page.keyboard.press('Control+Shift+A');
  const panel = page.getByRole('dialog', { name: 'Agents' });
  await panel.waitFor();
  // A sheet is up: the other chat keys leave the chat alone.
  await page.keyboard.press('Control+Shift+Y');
  assert.deepEqual(await picked(page, 'session.effort'), []);
  await page.keyboard.press('Control+Shift+A');
  await panel.waitFor({ state: 'hidden' });

  await page.keyboard.press('Control+Shift+A');
  await page.locator('button.delegation-task').first().waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.querySelector('b')?.textContent), 'Check the docs');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.querySelector('b')?.textContent), 'Write the tests', 'the list wraps');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.opened.length === 1);
  assert.deepEqual(await page.evaluate(() => window.opened), ['kid-1']);
  await panel.waitFor({ state: 'hidden' });
});
