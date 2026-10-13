import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

let browser, script;
const css=readFileSync('apps/web/src/styles.css','utf8').replace(/^@import[^;]+;/gm,'');
before(async()=>{
  script=(await build({stdin:{contents:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {Shell} from './apps/web/src/App';
    import {Client} from './apps/web/src/client';
    const source={id:'source',name:'Laptop',online:true,info:{}};
    const target={id:'target',name:'VM',online:true,info:{}};
    const managed={id:'managed',title:'Build project',cwd:'~/dev/project',engine:'codex',profileId:'codex',driver:true,status:'idle',alive:true,turns:1};
    const external={...managed,id:'external',title:'External chat',external:true};
    const terminal={...managed,id:'terminal',title:'Terminal',engine:'shell',driver:false};
    window.sessions={managed,external,terminal};
    let jobs=JSON.parse(localStorage.getItem('jobs')||'[]');
    const listeners=new Set();window.calls=[];
    window.finish=()=>{jobs=jobs.map(job=>({...job,phase:'done',updatedAt:Date.now(),finishedAt:Date.now(),files:{total:5,sent:5},bytes:{total:20,sent:20}}));
      localStorage.setItem('jobs',JSON.stringify(jobs));listeners.forEach(fn=>fn('source','send.update',{job:jobs[0]}));};
    const client=Object.assign(Object.create(Client.prototype),{
      token:'helm1.'+btoa(JSON.stringify({net:'send-test',sub:'fixture'}))+'.test',relay:'http://send-shell.test',
      environments:async()=>({environments:[source,target]}),openDirect:async()=>{},route:async()=>null,watchLatency:()=>()=>{},subscribe:()=>{},
      on:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
      rpc:async(env,method,params)=>{
        window.calls.push({env,method,params});
        if(method==='send.list')return {jobs:env==='source'?jobs:[]};
        if(method==='send.status')return {job:jobs.find(job=>job.id===params.jobId)};
        if(method==='send.plan')return {path:params.path,name:params.path.split('/').pop(),kind:params.path.endsWith('.zip')?'file':'folder',git:null,files:5,bytes:20,
          envFiles:[],left:[],targets:[{machineId:'target',name:'VM',online:true,destination:'~/project',sentBefore:jobs.some(job=>job.phase==='done')?{at:Date.now(),jobId:'job'}:null}],defaultTarget:'target'};
        if(method==='send.start'){
          const now=Date.now();const job={id:'job',createdAt:now,updatedAt:now,finishedAt:null,
            source:{machineId:'source',name:'Laptop',path:params.path,kind:'folder'},target:{machineId:'target',name:'VM',path:params.destination ?? '~/project'},
            again:false,phase:'sending',bytes:{total:20,sent:10},files:{total:5,sent:2},rate:10,eta:1,changed:null,route:null,error:null,left:[]};
          jobs=[job];localStorage.setItem('jobs',JSON.stringify(jobs));return {job};}
        if(method==='fs.list')return {path:params.path==='~'?'~':params.path,entries:[{name:'project',path:'~/dev/project',isRepo:true}]};
        if(method==='project.list')return {projects:[{path:'~/dev/project',title:'project'}]};
        if(method==='session.list')return {sessions:env==='source'?Object.values(window.sessions):[]};
        if(method==='session.events')return {session:window.sessions[params.id],events:[],pending:[],last:0};
        if(method==='session.watch')return {last:0};
        if(method==='model.list')return {models:[],modes:[]};
        if(method==='git.status')return {repo:false,files:[]};
        if(method==='session.messages')return {messages:[]};
        if(method==='session.attach')return {pty:true,text:''};
        if(method==='profile.list')return {profiles:[{id:'codex',engine:'codex',cmd:'codex'}]};
        if(method==='agent.list')return {agents:[{id:'codex',label:'Codex',available:true}]};
        if(method==='transfer.preview')return {rootName:'project',preflight:{files:5,bytes:20,envFiles:[],skipped:0,skippedEntries:[],warnings:[],requiresAcknowledgement:false}};
        return {};
      }
    });
    window.visit=(view,selected='source')=>{const state={helm:1,selected,stack:[{kind:'env'},view],depth:1};history.pushState(state,'');dispatchEvent(new PopStateEvent('popstate',{state}));};
    createRoot(document.getElementById('root')).render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}}/>);
  `,resolveDir:process.cwd(),loader:'tsx'},plugins:[{name:'shell-export',setup(builder){builder.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:await readFile(path,'utf8')+'\nexport { Shell };',loader:'tsx'}));}}],bundle:true,write:false,format:'iife',jsx:'automatic'})).outputFiles[0].text;
  browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());
async function pageFor(size) {
  const context=await browser.newContext({viewport:size});const page=await context.newPage();page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://send-shell.test/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/bundle.js')return route.fulfill({contentType:'application/javascript',body:script});
    if(path==='/favicon.svg'||path==='/icon.svg')return route.fulfill({contentType:'image/svg+xml',body:readFileSync('apps/web/public'+path)});
    if(path.startsWith('/fonts/'))return route.fulfill({contentType:'font/woff2',body:readFileSync('apps/web/public'+path)});
    return route.fulfill({contentType:'text/html',body:`<html><head><style>${css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`});
  });
  await page.goto('http://send-shell.test/');await page.locator('.sidebar').waitFor();
  page.cleanup=async()=>{assert.deepEqual(errors,[]);await context.close();};return page;
}
async function home(page){await page.evaluate(()=>window.visit({kind:'env'}));await page.getByRole('button',{name:'Send a project',exact:true}).waitFor();}
async function confirmed(page,path='~/dev/project'){
  await page.locator('.main').getByRole('button',{name:'Send to VM',exact:true}).waitFor();
  assert.equal(await page.locator('.send-context').getByText(path,{exact:true}).count(),1);
}
async function shot(page,state){
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,state+' overflows');
  assert.equal(await page.locator('.main.showing .scroll').evaluateAll(elements=>elements.some(element=>element.scrollWidth>element.clientWidth)),false,state+' has horizontal scrolling');
  if(process.env.HELM_TEST_SCREENSHOT_DIR){mkdirSync(process.env.HELM_TEST_SCREENSHOT_DIR,{recursive:true});const size=page.viewportSize();
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({animations:'disabled',path:join(process.env.HELM_TEST_SCREENSHOT_DIR,`send-shell-${state}-${size.width}x${size.height}.png`)});}
}
for(const size of [{width:390,height:844},{width:1280,height:800}]){
  test(`machine, project, browser and chat send entry points at ${size.width}`,async()=>{
    const page=await pageFor(size);
    try{
      await home(page);
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox',{name:'Search threads, machines, actions',exact:true}).fill('Send a project from Laptop');
      await page.getByRole('option').filter({hasText:'Send a project from Laptop'}).click();
      await page.locator('.main').getByRole('button',{name:'project',exact:true}).click();await confirmed(page);
      await home(page);
      await page.getByRole('button',{name:'Send a project',exact:true}).click();
      await page.locator('.main').getByRole('button',{name:'project',exact:true}).click();await confirmed(page);await shot(page,'plan');
      await home(page);await page.getByRole('button',{name:'actions for project',exact:true}).click();
      await page.locator('.main .menu').getByRole('button',{name:'Send to VM',exact:true}).click();await confirmed(page);
      await page.evaluate(()=>window.visit({kind:'browse',path:'~/dev/project'}));
      await page.getByRole('button',{name:'Send this folder',exact:true}).click();await confirmed(page);
      await page.evaluate(()=>window.visit({kind:'transfer-browse'}));
      await page.getByText('Use a file or folder path',{exact:true}).click();
      await page.getByRole('textbox',{name:'File or folder on this machine',exact:true}).fill('~/archive.zip');
      await page.getByRole('button',{name:'Use this path',exact:true}).click();await confirmed(page,'~/archive.zip');
      for(const id of ['managed','external','terminal']){
        await page.evaluate(id=>window.visit({kind:'session',session:window.sessions[id]}),id);
        await page.locator('.main').getByRole('button',{name:'more',exact:true}).click();
        await page.locator('.main .menu').getByRole('button',{name:'Send folder',exact:true}).click();await confirmed(page);
      }
      await page.evaluate(()=>window.visit({kind:'session',session:window.sessions.managed}));
      await page.locator('.main').getByRole('button',{name:'more',exact:true}).click();
      await page.locator('.main .menu').getByRole('button',{name:'Send to another machine',exact:true}).click();
      await page.getByRole('button',{name:'Send task to VM',exact:true}).waitFor();
      await page.getByRole('button',{name:'Send files only',exact:true}).click();await confirmed(page);
      assert.equal(await page.evaluate(()=>window.calls.some(call=>call.method==='task.send'||call.method==='send.start')),false);
    }finally{await page.cleanup();}
  });
  test(`real Shell reload preserves the send, sidebar receipt and deliberate folder/chat actions at ${size.width}`,async()=>{
    const page=await pageFor(size);
    try{
      await page.evaluate(()=>window.visit({kind:'transfer',cwd:'~/dev/project'}));await confirmed(page);
      await page.locator('.main').getByRole('button',{name:'Send to VM',exact:true}).click();
      await page.getByText('2 of 5 files · 10 B/s · 1s left',{exact:true}).waitFor();
      await page.reload();
      await page.getByText('2 of 5 files · 10 B/s · 1s left',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.method==='send.start').length),0);
      await home(page);await shot(page,'background');
      if(size.width===390)await page.getByRole('button',{name:'Sending to VM · View',exact:true}).click();
      else await page.locator('.sidebar').getByRole('button',{name:'project → VM 50% · 1s left',exact:true}).click();
      await page.evaluate(()=>window.finish());await page.getByText('On VM in ~/project',{exact:true}).waitFor();await shot(page,'receipt');
      await page.getByRole('button',{name:'Open folder there',exact:true}).click();
      await page.getByRole('button',{name:'Add this project',exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>history.state.selected),'target');
      assert.equal(await page.evaluate(()=>history.state.stack.at(-1).path),'~/project');
      assert.equal(await page.evaluate(()=>window.calls.some(call=>call.method==='session.start')),false);
      await page.evaluate(()=>window.visit({kind:'transfer',cwd:'~/dev/project',jobId:'job'}));
      await page.getByRole('button',{name:'Start a chat there',exact:true}).click();
      assert.equal(await page.evaluate(()=>history.state.selected),'target');
      assert.equal(await page.evaluate(()=>history.state.stack.at(-1).cwd),'~/project');
      await home(page);await page.getByRole('button',{name:'actions for project',exact:true}).click();
      await page.locator('.main .menu').getByRole('button',{name:'Send again to VM',exact:true}).click();
      await page.getByRole('button',{name:'Send again to VM',exact:true}).waitFor();
    }finally{await page.cleanup();}
  });
}
