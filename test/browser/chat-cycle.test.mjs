import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Shell } from './apps/web/src/App';
    const token = 'helm1.' + btoa(JSON.stringify({net:'network',sub:'device'})) + '.test';
    window.mount = (failLists) => {
      window.failLists = failLists ?? {};
      const envs = ['laptop','vm','offline'].map(id => ({id,name:id,online:id!=='offline',info:{}}));
      const base = {cwd:'/work/project',engine:'codex',profileId:'codex',driver:'codex',alive:true,status:'working',turns:1};
      const sessions = {
        laptop: [
          {...base,id:'same',title:'First',updatedAt:30},
          {...base,id:'terminal',title:'Second',updatedAt:20,driver:undefined,engine:'gemini',nativeCli:true,pty:true,shared:true},
          {...base,id:'idle',title:'Idle',status:'idle',updatedAt:100},
          {...base,id:'blocked',title:'Blocked',status:'blocked',updatedAt:100},
          {...base,id:'unknown',title:'Unknown',status:'unknown',updatedAt:100},
          {...base,id:'archived',title:'Archived',archived:true,updatedAt:100},
          {...base,id:'child',title:'Child',delegation:{parentId:'same'},updatedAt:100},
          {...base,id:'shell',title:'Shell',engine:'shell',updatedAt:100},
          {...base,id:'brain',title:'Brain',brain:true,updatedAt:100},
          {...base,id:'attention',title:'Attention',team:{working:1,blocked:1},updatedAt:100},
        ],
        vm: [{...base,id:'third',title:'Third',status:'starting',updatedAt:10}],
        offline: [{...base,id:'offline',title:'Offline',updatedAt:100}],
      };
      const listeners = new Set();
      window.calls = [];
      const client = {input:(env,params)=>client.rpc(env,'session.input',params),token,relay:'http://helm-test',
        environments:async()=>({environments:envs}),
        on:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},
        subscribe:()=>{},watchLatency:()=>()=>{},openDirect:async()=>{},route:async()=>null,
        rpc:async(env,method,params)=>{
          window.calls.push({env,method,params});
          if(method==='session.list' && window.failLists?.[env] > 0){window.failLists[env]--;throw new Error('timed out');}
          if(method==='session.list') return {sessions:sessions[env].map(s => ({...s}))};
          if(method==='session.attach') return {pty:true,text:'Ready'};
          if(method==='session.messages') return {messages:[]};
          if(method==='session.events') return {events:[],pending:[],last:0};
          if(method==='model.list') return {default:null,models:[]};
          if(method==='session.commands') return {commands:[{name:'status',description:'Show status'}]};
          if(method==='brain.snapshot') return {snapshot:{machines:{}}};
          return {};
        }};
      createRoot(document.getElementById('root')).render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}}/>);
    };
  `, resolveDir: process.cwd(), loader: 'tsx' }, plugins: [{ name: 'shell-export', setup(builder) {
    builder.onLoad({ filter: /\/App\.tsx$/ }, async ({ path }) => ({ contents: await readFile(path, 'utf8') + '\nexport { Shell };', loader: 'tsx' }));
  } }], bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

async function pageFor(t, failLists) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  t.after(() => assert.deepEqual(errors, []));
  await page.route('http://helm-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://helm-test/');
  await page.addScriptTag({ content: script });
  await page.evaluate(failLists => window.mount(failLists), failLists);
  await page.locator('.sidebar').waitFor();
  await page.waitForFunction(() => window.calls.some(c => c.env === 'vm' && c.method === 'session.list'));
  return page;
}

async function expectChat(page, envId, title) {
  await page.waitForFunction(({ envId, title }) => history.state?.selected === envId
    && history.state.stack.at(-1)?.session?.title === title, { envId, title }).catch(async error => {
      throw new Error(`${error.message}\n${JSON.stringify(await page.evaluate(() => ({ state: history.state, text: document.body.innerText })))}`);
    });
}

test('Ctrl+Tab walks Needs you by default and Running after Alt+2, across machines, both ways', async t => {
  const page = await pageFor(t);
  for (const title of ['Blocked', 'Attention', 'Blocked']) {
    await page.keyboard.press('Control+Tab');
    await expectChat(page, 'laptop', title);
  }
  await page.keyboard.press('Alt+2');
  await expectChat(page, 'laptop', 'First');
  for (const [env, title] of [['laptop', 'Second'], ['vm', 'Third'], ['laptop', 'First']]) {
    await page.keyboard.press('Control+Tab');
    await expectChat(page, env, title);
  }
  for (const [env, title] of [['vm', 'Third'], ['laptop', 'Second'], ['laptop', 'First']]) {
    await page.keyboard.press('Control+Shift+Tab');
    await expectChat(page, env, title);
  }
});

test('a chat list that fails right after a restart is asked for again, with no update needed', async t => {
  const page = await pageFor(t, { laptop: 3 });
  await page.waitForFunction(() => window.calls.filter(c => c.env === 'laptop' && c.method === 'session.list').length >= 4, null, { timeout: 12_000 });
  assert.equal(await page.evaluate(() => window.failLists.laptop), 0);
});
