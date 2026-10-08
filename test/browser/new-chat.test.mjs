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
    window.mount = () => {
      const envs = ['laptop','vm'].map(id => ({id,name:id,online:true,info:{}}));
      const session = {id:'native',title:'Current chat',cwd:'/work/current',engine:'claude',profileId:'claude',
        nativeCli:true,pty:true,shared:true,alive:true,status:'idle',turns:1,updatedAt:Date.now()};
      window.calls = [];
      const client = {token,relay:'http://helm-test',
        environments:async()=>({environments:envs}), on:()=>()=>{}, subscribe:()=>{}, watchLatency:()=>()=>{},
        openDirect:async()=>{}, route:async()=>null,
        rpc:async(env,method,params)=>{
          window.calls.push({env,method,params});
          if(method==='session.list') return {sessions:env==='laptop'?[session]:[]};
          if(method==='session.attach') return {pty:true,text:'Ready'};
          if(method==='session.messages') return {messages:[]};
          if(method==='fs.list') return {path:params.path==='~'?'/home/test':params.path,entries:[{name:'project',path:'/work/project',isDir:true}]};
          if(method==='project.list') return {projects:[]};
          if(method==='profile.list') return {profiles:[{id:'claude',engine:'claude',cmd:'claude'}]};
          if(method==='session.start') return {session:{...session,id:'fresh',cwd:params.cwd,nativeCli:false,pty:false}};
          return {};
        }};
      createRoot(document.getElementById('root')).render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}}/>);
    };
    window.visit = (selected, view) => {
      const state = {helm:1,selected,stack:[view],depth:1};
      history.pushState(state,'');
      dispatchEvent(new PopStateEvent('popstate',{state}));
    };
  `, resolveDir: process.cwd(), loader: 'tsx' }, plugins: [{name:'shell-export',setup(builder) {
    builder.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:await readFile(path,'utf8')+'\nexport { Shell };',loader:'tsx'}));
  }}], bundle:true,write:false,format:'iife',jsx:'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());

async function pageFor(t, saved) {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  t.after(()=>page.close());
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await page.route('http://helm-test/**',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm-test/');
  if(saved) await page.evaluate(saved=>localStorage.setItem('helm.last-folder:network:device',JSON.stringify(saved)),saved);
  await page.addScriptTag({content:script});
  await page.evaluate(()=>window.mount());
  await page.locator('.sidebar').waitFor();
  return page;
}

async function startPickedChat(page, expected) {
  await page.getByRole('combobox',{name:'Which CLI?'}).waitFor();
  await page.getByRole('option').filter({hasText:'Claude'}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.start'));
  const call = await page.evaluate(()=>window.calls.find(c=>c.method==='session.start'));
  assert.equal(call.env,expected.envId);
  assert.equal(call.params.cwd,expected.folder);
}

test('Ctrl+Shift+N starts in the active chat directory from a focused terminal',async t=>{
  const page=await pageFor(t,{envId:'vm',folder:'/old/folder'});
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Current chat');
  await page.getByRole('option').filter({hasText:'Current chat'}).click();
  const terminal=page.locator('.xterm-helper-textarea');
  await terminal.waitFor();
  await terminal.press('Control+Shift+n');
  await startPickedChat(page,{envId:'laptop',folder:'/work/current'});
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='session.input')),false);
});

test('Ctrl+Shift+N remembers a browsed directory and its machine after leaving it',async t=>{
  const page=await pageFor(t);
  await page.evaluate(()=>window.visit('vm',{kind:'new',path:'/work/browsed'}));
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('helm.last-folder:network:device'))?.folder==='/work/browsed');
  // A generic new-chat picker already open must switch to the contextual picker.
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('combobox',{name:'Which machine?'}).waitFor();
  await page.keyboard.press('Control+Shift+n');
  await page.getByRole('combobox',{name:'Which CLI?'}).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.visit('laptop',{kind:'app-settings'}));
  await page.keyboard.press('Control+Shift+n');
  await startPickedChat(page,{envId:'vm',folder:'/work/browsed'});
});

test('Ctrl+Shift+N restores the last directory on a fresh app open',async t=>{
  const page=await pageFor(t,{envId:'vm',folder:'/saved/project'});
  await page.keyboard.press('Control+Shift+n');
  await startPickedChat(page,{envId:'vm',folder:'/saved/project'});
});

test('Ctrl+Shift+N without any previous directory opens the normal picker',async t=>{
  const page=await pageFor(t);
  await page.keyboard.press('Control+Shift+n');
  await page.getByRole('combobox',{name:'Which machine?'}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Which CLI?'}).count(),0);
});

test('Ctrl+Shift+N remembers a folder chosen in the new-chat picker',async t=>{
  const page=await pageFor(t);
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('option').filter({hasText:'vm'}).click();
  await page.getByRole('option').filter({hasText:'project'}).click();
  await page.getByRole('combobox',{name:'Which CLI?'}).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+n');
  await startPickedChat(page,{envId:'vm',folder:'/work/project'});
});
