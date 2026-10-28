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
    window.emit=(events)=>{const stamped=events.map(e=>({seq:++seq,at:Date.now(),...e}));
      for(const l of listeners)l('laptop','session.event',{id:'chat',events:stamped});};
    const options={models:['model-a','model-b','model-c','model-d','model-e','model-f','model-g'],
      more:['model-x','model-y'],
      labels:{'model-a':'Model A','model-b':'Model B','model-c':'Model C','model-d':'Model D','model-e':'Model E','model-f':'Model F','model-g':'Model G','model-x':'Model X','model-y':'Model Y'},
      default:'model-a',efforts:['low','medium','high'],modes:MODES.claude,favs:['model-y','model-c'],effortFavs:[],
      prefs:{default:'model-a',approved:[]},defaults:{effort:'low'}};
    const child={id:'kid-1',title:'Write the tests',engine:'claude',profileId:'claude',status:'idle',cwd:'/project',delegation:{parentId:'chat',status:'completed'}};
    const child2={...child,id:'kid-2',title:'Check the docs'};
    const client={pendingActions:()=>[],resumeActions:async()=>[],input:(env,params)=>client.rpc(env,'session.input',params),on:(l)=>{listeners.add(l);return()=>listeners.delete(l)},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
      if(method==='model.list') return options;
      if(method==='session.events') return {session:window.current,events:[{seq:1,at:Date.now(),type:'turn.start',turnId:'t1',text:'go'},{seq:2,at:Date.now(),type:'status',status:'idle'}],pending:[],last:2,status:'idle'};
      if(method==='session.watch') return {last:seq};
      if(method==='session.unwatch') return {};
      if(method==='session.list') return {sessions:params?.parentId ? [child,child2] : []};
      if(method==='session.commands') return {commands:[]};
      if(method==='usage.limits') return {accounts:[]};
      if(method==='git.status') return {repo:false};
      if(method==='agent.list') return {agents:[]};
      if(method==='schedule.list') return {schedules:[]};
      if(method==='session.input'){window.calls.push({method,params});return {ok:true};}
      if(['session.model','session.effort','session.mode','session.speed'].includes(method)){
        window.calls.push({method,params});
        const kind=method.split('.')[1];return {session:{...window.current,[kind]:params[kind]}};
      }
      return {};
    }};
    function Chat(){
      const [session,setSession]=useState({id:'chat',engine:'claude',driver:'claude',profileId:'claude',model:'model-a',effort:'low',
        mode:'default',title:'Keys',status:'idle',cwd:'/project'});
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

async function open(t, viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport });
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

const CONTEXT = "## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 28.3k / 383k (7%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n| System prompt | 2.1k | 0.5% |\n| System tools | 23.8k | 6.2% |\n| System tools (deferred) | 29.8k | 7.8% |\n| Memory files | 87 | 0.0% |\n| Skills | 2.3k | 0.6% |\n| Free space | 321.7k | 84.0% |\n| Autocompact buffer | 33k | 8.6% |\n\n### Memory Files\n\n| Type | Path | Tokens |\n|------|------|--------|\n| User | /home/haseeb/.claude-personal/CLAUDE.md | 87 |\n\n### Skills\n\n| Skill | Source | Tokens |\n|-------|--------|--------|\n| bowser-computer-use | User | ~110 |\n| dataviz | Built-in | ~480 |\n| artifact-design | Built-in | ~70 |\n| artifact-diagramming | Built-in | ~70 |\n| update-config | Built-in | ~240 |\n| keybindings-help | Built-in | ~80 |\n| code-review | Built-in | ~340 |\n| simplify | Built-in | ~60 |\n| fewer-permission-prompts | Built-in | ~60 |\n| loop | Built-in | ~120 |\n| claude-api | Built-in | ~360 |\n| workflow-authoring | Built-in | ~80 |\n| run | Built-in | ~120 |\n| plugin-authoring | Built-in | ~90 |\n| init | Built-in | ~20 |\n| security-review | Built-in | ~30 |\n\n\n";

test('a bare /model opens the model picker instead of going to the CLI', async t => {
  const page = await open(t, { width: 390, height: 844 });
  const composer = page.locator('textarea').first();
  await composer.fill('/model');
  await composer.press('Escape');
  await composer.press('Enter');
  await page.getByRole('listbox', { name: 'model' }).waitFor();
  assert.equal(await composer.inputValue(), '', 'the command is used up');
  assert.deepEqual(await page.evaluate(() => window.calls.filter(c => c.method === 'session.input')), []);
  // With a name it is still the CLI's own command.
  await page.getByRole('button', { name: 'close' }).click();
  await composer.fill('/model model-b');
  await composer.press('Enter');
  await page.waitForFunction(() => window.calls.some(c => c.method === 'session.input'));
  assert.equal(await page.evaluate(() => window.calls.find(c => c.method === 'session.input').params.data), '/model model-b');
});

test("Claude's /context answer is a usage bar with the long lists folded", async t => {
  const page = await open(t, { width: 390, height: 844 });
  await page.evaluate((text) => window.emit([
    { type: 'turn.start', turnId: 'c1', text: '/context' },
    { type: 'item.start', id: 'c1#answer', turnId: 'c1', kind: 'text' },
    { type: 'item.delta', id: 'c1#answer', text },
    { type: 'item.done', id: 'c1#answer', status: 'ok' },
    { type: 'turn.done', turnId: 'c1', status: 'ok' },
  ]), CONTEXT);
  const card = page.locator('.ctxcard');
  await card.waitFor();
  assert.match(await card.locator('.ctx-total').innerText(), /28\.3k of 383k · 7%/);
  assert.equal(await card.locator('.ctx-bar i').count(), 4, 'the parts with a share, and the reserve');
  assert.equal(await card.locator('details.ctx-more').count(), 2);
  assert.equal(await card.locator('table').first().isVisible(), false, 'lists stay folded');
  if (process.env.HELM_SHOT) await card.screenshot({ path: process.env.HELM_SHOT });
});
