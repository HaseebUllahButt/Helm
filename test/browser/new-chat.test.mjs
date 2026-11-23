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
    window.mount = (ids = ['laptop','vm']) => {
      const envs = ids.map(id => ({id,name:id,online:true,info:{}}));
      const session = {id:'native',title:'Current chat',cwd:'/work/current',engine:'gemini',profileId:'claude',
        nativeCli:true,pty:true,shared:true,alive:true,status:'idle',turns:1,updatedAt:Date.now()};
      window.calls = [];
      const client = {pendingActions:()=>[],resumeActions:async()=>[],input:(env,params)=>client.rpc(env,'session.input',params),token,relay:'http://helm-test',
        environments:async()=>({environments:envs}), on:()=>()=>{}, subscribe:()=>{}, watchLatency:()=>()=>{},
        openDirect:async()=>{}, directStatus:()=>({state:'not requested'}), route:async()=>null,
        rpc:async(env,method,params)=>{
          window.calls.push({env,method,params});
          if(method==='session.list') return {sessions:env==='laptop'?[session]:[]};
          if(method==='session.events' && params.id==='fresh') return {session:{status:'idle'},events:[],pending:[],last:0};
          if(method==='session.events') return {session,events:[],pending:[],last:0};
          if(method==='session.watch') return {last:0};
          if(method==='model.list') return {models:[],modes:[]};
          if(method==='git.status') return {repo:true,files:[]};
          if(method==='fs.search') return {results:[]};
          if(method==='session.attach') return {pty:true,text:'Ready'};
          if(method==='session.messages') return {messages:[]};
          if(method==='fs.list') return params.path==='~'
            ? {path:'/home/test',entries:[{name:'project',path:'/work/project',isDir:true}]}
            : {path:params.path,entries:[{name:'existing',path:params.path+'/existing',isDir:true}]};
          if(method==='project.list') return {projects:[]};
          if(method==='profile.list') return {profiles:[{id:'claude',engine:'claude',cmd:'claude'}]};
          if(method==='session.start' && window.startGate) await window.startGate(params);
          if(method==='session.start') return {session:{...session,id:'fresh',cwd:params.quick?'/home/test/.helm/quick/fresh':params.cwd,quick:params.quick,nativeCli:false,pty:false}};
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

async function pageFor(t, machines) {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  t.after(()=>page.close());
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await page.route('http://helm-test/**',route=>route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>'}));
  await page.goto('http://helm-test/');
  await page.addScriptTag({content:script});
  await page.evaluate((machines)=>window.mount(machines),machines);
  await page.locator('.sidebar').waitFor();
  return page;
}

/** Open the new-chat box on the vm's folder step. */
async function folderStep(page) {
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('option').filter({hasText:'vm'}).click();
  const box=page.getByRole('combobox',{name:'Search folders on vm'});
  await box.waitFor();
  await page.getByRole('option').filter({hasText:'project'}).waitFor();
  return box;
}
const startCall = (page) => page.evaluate(()=>window.calls.find(c=>c.method==='session.start'));

test('a new chat opens at once while its agent starts, and what you send then goes in when it is up',async t=>{
  const page=await pageFor(t);
  await page.evaluate(()=>{ window.startGate=()=>new Promise((ok,fail)=>{ window.release=ok; window.refuse=fail; }); });
  await folderStep(page);
  await page.getByRole('option').filter({hasText:'project'}).click();
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  await page.keyboard.press('Enter');
  // The picker is gone and the chat is there, saying it is starting.
  await page.locator('.chip.working').filter({hasText:'starting'}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Search agents'}).count(),0);
  assert.match(await page.locator('.session-bar').innerText(),/project/);
  const box=page.getByRole('textbox',{name:/^Message /});
  await box.fill('hello there');
  await box.press('Enter');
  await page.locator('.turn.user').filter({hasText:'hello there'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='session.input')),false);
  await page.evaluate(()=>window.release());
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.input'));
  const input=await page.evaluate(()=>window.calls.find(c=>c.method==='session.input'));
  assert.deepEqual({env:input.env,id:input.params.id,data:input.params.data},{env:'vm',id:'fresh',data:'hello there'});
  await page.locator('.chip.working').filter({hasText:'starting'}).waitFor({state:'detached'});
  await page.locator('.main h1').filter({hasText:'Current chat'}).waitFor();
});

test('an agent that fails to start says why, keeps what you wrote, and can be tried again',async t=>{
  const page=await pageFor(t);
  await page.evaluate(()=>{ window.startGate=()=>new Promise((ok,fail)=>{ window.release=ok; window.refuse=fail; }); });
  await folderStep(page);
  await page.getByRole('option').filter({hasText:'project'}).click();
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  await page.keyboard.press('Enter');
  const box=page.getByRole('textbox',{name:/^Message /});
  await box.fill('keep me');
  await page.evaluate(()=>window.refuse(new Error('claude is not logged in')));
  await page.getByRole('alert').filter({hasText:'This account is signed out.'}).waitFor();
  assert.equal(await box.inputValue(),'keep me');
  await page.getByRole('button',{name:'Try again'}).click();
  await page.locator('.chip.working').filter({hasText:'starting'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='session.start').length),2);
  await page.evaluate(()=>window.release());
  await page.locator('.main h1').filter({hasText:'Current chat'}).waitFor();
  // Never sent, so it becomes the chat's own draft.
  assert.equal(await page.evaluate(()=>localStorage.getItem('helm-draft:vm:fresh')),'keep me');
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='session.input')),false);
});

test('reload restores a queued first message with the same start and delivery numbers', async t => {
  const page = await pageFor(t, ['laptop']);
  await page.evaluate(() => { window.startGate = () => new Promise(() => {}); });
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('option', { name: /No folder/ }).click();
  await page.getByRole('option', { name: /Claude/ }).first().click();
  const box = page.getByRole('textbox', { name: /Message/ });
  await box.fill('keep queued words');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  const held = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('helm.startingChat.v1:')))));
  assert.equal(held.message, 'keep queued words');
  await page.reload();
  await page.addScriptTag({ content: script });
  await page.evaluate(() => window.mount(['laptop']));
  await page.waitForFunction(() => window.calls.some(c => c.method === 'session.input'));
  const start = await startCall(page);
  assert.equal(start.params.startId, held.id);
  assert.equal(start.params.profileId, held.startParams.profileId);
  const send = await page.evaluate(() => window.calls.find(c => c.method === 'session.input'));
  assert.equal(send.params.data, 'keep queued words');
  await page.waitForFunction(() => !Object.keys(localStorage).some(k => k.startsWith('helm.startingChat.v1:')));
});
