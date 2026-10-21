import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// The search box (Ctrl/Cmd+K) finds chats by what was said in them: every
// online machine is asked `session.search` once typing pauses, its answers
// sit under "Said in chats" with the words that matched, and a tap opens the chat.
let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Shell } from './apps/web/src/App';
    const token = 'helm1.' + btoa(JSON.stringify({net:'network',sub:'device'})) + '.test';
    window.mount = () => {
      const envs = [{id:'laptop',name:'laptop',online:true,info:{}},{id:'vm',name:'vm',online:true,info:{}},{id:'pc',name:'pc',online:false,info:{}}];
      window.calls = [];
      const client = {token,relay:'http://helm-test',
        environments:async()=>({environments:envs}), on:()=>()=>{}, subscribe:()=>{}, watchLatency:()=>()=>{},
        openDirect:async()=>{}, route:async()=>null, usage:async()=>({totals:{},daily:[],groups:[],accounts:[],scan:{},at:Date.now()}),
        rpc:async(env,method,params)=>{
          window.calls.push({env,method,params});
          if(method==='session.list') return {sessions:env==='laptop'?[{id:'pie1',title:'Lemon pie',cwd:'/work/pie',engine:'claude',profileId:'claude',driver:'claude',alive:true,status:'idle',turns:3,updatedAt:Date.now()-3600000}]:[]};
          if(method==='session.search'){
            if(env==='laptop') return {results:!/lemon/.test(params.query)?[]:[
              {id:'pie1',title:'Lemon pie',cwd:'/work/pie',quick:false,engine:'claude',archived:false,who:'you',snippet:'make the lemon pie shorter',at:200,updatedAt:200},
              {id:'tart9',title:'Weekend baking',cwd:'/work/tarts',quick:false,engine:'claude',archived:true,who:'agent',snippet:'…a lemon tart needs less sugar than a pie…',at:300,updatedAt:300},
            ]};
            if(env==='vm') { await new Promise(r=>setTimeout(r,50)); throw new Error('vm is slow'); }
            return {results:[]};
          }
          if(method==='session.events') return {session:null,events:[],pending:[],last:0};
          if(method==='model.list') return {models:[],modes:[]};
          if(method==='profile.list') return {profiles:[{id:'claude',engine:'claude',cmd:'claude'}]};
          if(method==='project.list') return {projects:[]};
          return {};
        }};
      createRoot(document.getElementById('root')).render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}}/>);
    };
  `, resolveDir: process.cwd(), loader: 'tsx' }, plugins: [{name:'shell-export',setup(builder) {
    builder.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:await readFile(path,'utf8')+'\nexport { Shell };',loader:'tsx'}));
  }}], bundle:true,write:false,format:'iife',jsx:'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());

async function pageFor(t, viewport = {width:390,height:844}) {
  const ctx = await browser.newContext({viewport});
  const page = await ctx.newPage();
  t.after(()=>page.close());
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await page.route('http://helm-test/**',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm-test/');
  await page.addScriptTag({content:script});
  await page.evaluate(()=>window.mount());
  await page.locator('.sidebar').waitFor();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.list'));
  return page;
}

const searches = (page) => page.evaluate(()=>window.calls.filter(c=>c.method==='session.search').map(c=>[c.env,c.params.query]));

test('typed words are looked for in chats on every online machine, after a pause, and shown with what matched', async t => {
  const page = await pageFor(t);
  await page.keyboard.press('Control+k');
  const input = page.locator('.palette-input');
  await input.waitFor();
  await input.pressSequentially('lemon', { delay: 30 });
  await page.getByText('Said in chats').waitFor();
  const text = await page.locator('.palette-list').innerText();
  assert.match(text, /Lemon pie/);
  assert.match(text, /Weekend baking/);
  assert.match(text, /Agent: …a lemon tart needs less sugar/);
  assert.match(text, /archived/);
  // The title match already lists "Lemon pie" under Threads: it is not repeated under Said in chats.
  assert.equal((text.match(/Lemon pie/g) ?? []).length, 1, text);
  const asked = await searches(page);
  assert.deepEqual([...new Set(asked.map(([env]) => env))].sort(), ['laptop', 'vm'], 'the offline machine is not asked');
  assert.ok(asked.every(([, q]) => q === 'lemon'), `one search for the whole word, not one per letter: ${JSON.stringify(asked)}`);
});

test('one letter asks nothing; Enter on a found chat opens it', async t => {
  const page = await pageFor(t);
  await page.keyboard.press('Control+k');
  const input = page.locator('.palette-input');
  await input.waitFor();
  await input.pressSequentially('l');
  await page.waitForTimeout(400);
  assert.deepEqual(await searches(page), []);
  await input.pressSequentially('emon tart');
  await page.getByText('Weekend baking').waitFor();
  // Newest words first: the tart chat (at 300) sits above the pie chat (at 200).
  const rows = await page.locator('.palette-row .palette-title').allInnerTexts();
  assert.deepEqual(rows, ['Weekend baking', 'Lemon pie']);
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>history.state?.stack?.at(-1)?.session?.id === 'tart9', null, {timeout: 3000});
  assert.equal(await page.locator('.palette-box').count(), 0, 'the box closed');
});

test('while the machines are looking, the box says so instead of "No matches"', async t => {
  const page = await pageFor(t);
  await page.keyboard.press('Control+k');
  const input = page.locator('.palette-input');
  await input.waitFor();
  await input.pressSequentially('zz');
  await page.getByText('Helm is searching your chats.').waitFor();
  await page.getByText('No matches').waitFor();
});
