import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script, css;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Shell} from './apps/web/src/App';
    const params=new URL(location.href).searchParams;
    const engine=params.get('engine');
    const paged=params.has('history'), live=params.has('live');
    const token='helm1.'+btoa(JSON.stringify({net:'network',sub:'device'}))+'.test';
    const now=Date.now(), cwd='/work/shared';
    const pane={id:'pane:w1:p1',paneId:'w1:p1',engine,cwd,title:'Outside terminal',alive:true,status:'idle',adopted:true,updatedAt:now};
    const found={engine,id:'outside-'+engine,account:engine,cwd,title:'Saved outside '+engine,updatedAt:now,active:live,serviceActive:live};
    const histories=paged?Array.from({length:65},(_,i)=>({...found,id:'history-'+i,title:'Outside history '+i,updatedAt:now-i})): [found];
    let opened=null;
    window.calls=[];
    const client={token,relay:'http://helm.test',on:()=>()=>{},subscribe:()=>{},watchLatency:()=>()=>{},
      openDirect:async()=>{},route:async()=>null,environments:async()=>({environments:[{id:'laptop',name:'Laptop',online:true,info:{}}]}),
      rpc:async(env,method,params)=>{
        window.calls.push({method,params});
        if(method==='session.list')return {sessions:[pane,...(opened?[opened]:[])]};
        if(method==='session.inventory'){const rows=histories.filter(s=>!params.query||s.title.toLowerCase().includes(params.query.toLowerCase()));return {recent:rows.slice(0,params.limit??40),hasMore:rows.length>(params.limit??40)};}
        if(method==='session.resume'){const saved=histories.find(s=>s.id===params.id)??found;return {session:opened={...saved,id:'managed-'+engine,driver:engine,engineSessionId:saved.id,profileId:engine,external:true,externalActive:live,externalService:live,status:live?'working':'idle',turns:1}};}
        if(method==='session.events')return {session:opened,events:[
          {seq:1,type:'turn.start',turnId:'t',text:'Previous question'},
          {seq:2,type:'item.start',turnId:'t',id:'a',kind:'text'},
          {seq:3,type:'item.delta',id:'a',text:'Saved outside answer'},
          {seq:4,type:'turn.done',turnId:'t',status:'ok'}],pending:[],last:4};
        if(method==='session.watch')return {last:4};
        if(method==='model.list')return {models:['model-a','model-b'],efforts:['low','high'],modes:engine==='pi'?[]:[{id:'default',label:'Ask first',short:'ask'}],default:null,defaultMode:null};
        if(method==='session.model')return {session:opened={...opened,model:params.model}};
        if(method==='project.list')return {projects:[]};
        if(method==='git.status')return {repo:false};
        if(method==='usage.limits')return {accounts:[]};
        if(method==='session.commands')return {commands:[]};
        return {};
      }};
    createRoot(document.getElementById('root')).render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}}/>);
    window.machine=()=>{const state={helm:1,selected:'laptop',stack:[{kind:'env'}],depth:1};history.pushState(state,'');dispatchEvent(new PopStateEvent('popstate',{state}));};
  `, resolveDir: process.cwd(), loader: 'tsx' }, plugins: [{ name: 'export-shell', setup(b) {
    b.onLoad({ filter: /\/App\.tsx$/ }, async ({ path }) => ({ contents: await readFile(path, 'utf8')+'\nexport {Shell};', loader:'tsx' }));
  }}], bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script=bundle.outputFiles[0].text;
  css=(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'');
  browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());

for(const engine of ['claude','codex','opencode','opencode2','pi']) for(const width of [390,1280]) test(`${engine}: a terminal in the same folder leaves saved history reachable, with its tray at ${width}px`,async t=>{
  const page=await browser.newPage({viewport:{width,height:844}});t.after(()=>page.close());page.setDefaultTimeout(6000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://helm.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm.test/?engine='+engine);await page.addStyleTag({content:css});await page.addScriptTag({content:script});
  await page.locator('.sidebar').waitFor();await page.evaluate(()=>window.machine());
  await page.getByText('Saved outside '+engine,{exact:true}).first().click();
  await page.getByText('Saved outside answer',{exact:true}).waitFor();
  await page.getByRole('button',{name:'model: model',exact:true}).click();
  await page.getByRole('option',{name:'model-b',exact:true}).click();
  await page.getByRole('button',{name:['claude','codex'].includes(engine)?'model: b':'model: model-b',exact:true}).waitFor();
  await page.getByRole('button',{name:/^thinking:/}).waitFor();
  assert.equal(await page.locator('.xterm-host').count(),0);
  assert.equal(await page.locator('textarea').count(),1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const calls=await page.evaluate(()=>window.calls);
  assert.equal(calls.find(c=>c.method==='session.resume').params.id,'outside-'+engine);
  assert.equal(calls.find(c=>c.method==='session.model').params.id,'managed-'+engine);
  assert.deepEqual(errors,[]);
});

for(const width of [390,1280]) test(`older outside chats load on request and search reaches beyond the first page at ${width}px`,async t=>{
  const page=await browser.newPage({viewport:{width,height:844}});t.after(()=>page.close());page.setDefaultTimeout(6000);
  await page.route('http://helm.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm.test/?engine=opencode2&history=1');await page.addStyleTag({content:css});await page.addScriptTag({content:script});
  await page.locator('.sidebar').waitFor();await page.evaluate(()=>window.machine());
  await page.getByRole('button',{name:'Load older chats',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.inventory'&&c.params.limit===80));
  await page.getByRole('button',{name:'Load older chats',exact:true}).waitFor({state:'detached'});
  await page.getByPlaceholder('search Laptop').fill('Outside history 64');
  await page.getByText('Outside history 64',{exact:true}).first().click();
  await page.getByText('Saved outside answer',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.find(c=>c.method==='session.resume').params.id),'history-64');
});

test('a V2 service chat opens as a live monitor without a shared-service takeover button',async t=>{
  const page=await browser.newPage({viewport:{width:390,height:844}});t.after(()=>page.close());page.setDefaultTimeout(6000);
  await page.route('http://helm.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm.test/?engine=opencode2&live=1');await page.addStyleTag({content:css});await page.addScriptTag({content:script});
  await page.locator('.sidebar').waitFor();await page.evaluate(()=>window.machine());
  assert.equal(await page.locator('.sidebar .chip').getByText('idle',{exact:true}).count(),0, 'a live service chat must not also say idle');
  await page.getByText('Saved outside opencode2',{exact:true}).first().click();
  await page.getByText('Running in OpenCode 2',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Take control',exact:true}).count(),0);
  assert.ok(await page.getByText('Wait for the current step to finish, then send here.',{exact:true}).isVisible());
});
