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
    const client={on:(l)=>{listeners.add(l);return()=>listeners.delete(l)},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
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
const picked = (page, method) => page.evaluate(m => window.calls.filter(c => c.method === m).map(c => Object.values(c.params)[1]), method);

test('Ctrl+Shift+Y steps the thinking level from the composer and wraps', async t => {
  const page = await open(t);
  const composer = page.locator('textarea').first();
  await composer.focus();
  for (const level of ['medium', 'high', 'low']) {
    await page.keyboard.press('Control+Shift+Y');
    await page.getByRole('button', { name: `thinking: ${level}`, exact: true }).waitFor();
  }
  assert.deepEqual(await picked(page, 'session.effort'), ['medium', 'high', 'low']);
  assert.equal(await composer.evaluate(el => el === document.activeElement), true, 'typing carries on where it was');
});

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

test('the model sheet takes the keyboard: type to search, arrows, Enter, Esc', async t => {
  const page = await open(t);
  await page.locator('textarea').first().focus();
  await page.locator('button[title^="model:"]').click();
  const search = page.getByRole('textbox', { name: 'Search model' });
  await search.waitFor();
  assert.equal(await search.evaluate(el => el === document.activeElement), true);
  await page.keyboard.type('model x');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.current.model === 'model-x');
  await search.waitFor({ state: 'hidden' });

  await page.locator('button[title^="model:"]').click();
  await search.waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Model Y');
  // A letter typed on a row goes to the search box.
  await page.keyboard.type('g');
  assert.equal(await search.inputValue(), 'g');
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.current.model), 'model-x');

  // Short lists have no box; the arrows and Enter still work.
  await page.locator('button[title^="thinking:"]').click();
  await page.getByRole('listbox', { name: 'thinking' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'low');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.current.effort === 'medium');
});

test('tok/s shows beside working while text streams, and goes when it stops', async t => {
  const page = await open(t, { width: 390, height: 844 });
  const chip = page.locator('.session-bar .chip.working');
  await chip.waitFor();
  assert.match(await chip.textContent(), /^working$/);
  await page.evaluate(() => window.emit([{ type: 'item.start', id: 'msg#0', kind: 'text', turnId: 't1' }]));
  // 400 characters a second for three seconds: about 100 tokens a second.
  await page.evaluate(async () => {
    for (let i = 0; i < 30; i++) {
      window.emit([{ type: 'item.delta', id: 'msg#0', text: 'x'.repeat(40) }]);
      await new Promise(r => setTimeout(r, 100));
    }
  });
  const text = await chip.textContent();
  const rate = Number(/· (\d+) tok\/s$/.exec(text)?.[1]);
  assert.ok(rate >= 70 && rate <= 130, `a sensible rate, got "${text}"`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'fits a phone');
  const shot = process.env.HELM_SHOT_DIR;
  if (shot) await page.screenshot({ path: `${shot}/tok-s-phone.png`, clip: { x: 0, y: 0, width: 390, height: 120 } });
  // A tool running is not writing.
  await page.waitForFunction(() => /^working$/.test(document.querySelector('.session-bar .chip.working')?.textContent ?? ''), null, { timeout: 5000 });
});
