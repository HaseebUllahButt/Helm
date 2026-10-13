import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let browser, bundle;
const css = readFileSync('apps/web/src/styles.css', 'utf8').replace(/^@import[^;]+;/gm, '');
const sizes = [{ width: 390, height: 844 }, { width: 1280, height: 800 }];
before(async () => {
  bundle = (await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Client} from './apps/web/src/client';
    import {TransferView} from './apps/web/src/Transfer';
    import {SendActivity, SendNotice} from './apps/web/src/send/SendActivity';
    import {useSends} from './apps/web/src/send/store';
    const options = JSON.parse(localStorage.getItem('fixture.options') || '{}');
    const source = {id:'source',name:options.sourceName || 'Laptop',online:true,info:{}};
    const targets = [{machineId:'other',name:'Home PC',online:true,destination:'~/project',sentBefore:null},
      {machineId:'target',name:options.targetName || 'VM',online:!options.offline,destination:options.destination || '~/project',sentBefore:null}];
    let jobs = JSON.parse(localStorage.getItem('fixture.jobs') || '[]');
    const listeners = new Set();
    const save = () => localStorage.setItem('fixture.jobs',JSON.stringify(jobs));
    window.calls=[];
    window.emitJob = job => listeners.forEach(listener=>listener('source','send.update',{job}));
    window.jobs = () => jobs;
    window.changes = (id, patch, emit=true) => {
      const index=jobs.findIndex(job=>job.id===id);
      jobs[index]={...jobs[index],...patch,updatedAt:Date.now()+window.calls.length};save();
      if(emit)listeners.forEach(listener=>listener('source','send.update',{job:jobs[index]}));
    };
    let release;
    window.release = () => release?.();
    const client=Object.assign(Object.create(Client.prototype),{
      token:'send-v2-test',on:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},subscribe:()=>{},
      rpc:async(env,method,params)=>{
        window.calls.push({env,method,params});
        if(method==='agent.list') return {agents:[{id:'codex',label:'Codex',available:true}]};
        if(method==='transfer.preview') return {rootName:'project',preflight:{files:2,bytes:20,envFiles:params.includeEnv?['.env']:[],skipped:params.includeEnv?0:1,skippedEntries:[],warnings:[],requiresAcknowledgement:false}};
        if(method==='send.plan') {
          if(options.planFailure && !window.planRetried) {window.planRetried=true;throw Error('Unable to read');}
          return {path:params.path,name:params.path.split('/').pop(),kind:options.file?'file':'folder',
            git:options.file?null:{branch:'main',dirty:true},files:options.file?1:42000,bytes:2e9,envFiles:['.env'],
            left:[{path:'node_modules',why:'Dependencies stay here'}],estimate:true,
            targets:targets.map(target=>({...target,sentBefore:jobs.some(job=>job.phase==='done'&&job.target.machineId===target.machineId)
              ? {at:Date.now(),jobId:jobs[0]?.id}:null})),defaultTarget:options.defaultTarget||'target'};
        }
        if(method==='send.list') return {jobs};
        if(method==='send.status') return {job:jobs.find(job=>job.id===params.jobId)};
        if(method==='send.start') {
          const now=Date.now();
          const job={id:'job-'+(jobs.length+1),createdAt:now,updatedAt:now,finishedAt:null,
            source:{machineId:'source',name:source.name,path:params.path,kind:options.file?'file':'folder'},
            target:{machineId:params.targetMachineId,name:targets.find(t=>t.machineId===params.targetMachineId).name,path:params.destination || targets.find(t=>t.machineId===params.targetMachineId).destination},
            again:jobs.some(job=>job.phase==='done'),phase:'preparing',bytes:{total:null,sent:0},files:{total:null,sent:0},
            rate:null,eta:null,changed:null,route:null,error:null,left:[]};
          jobs.unshift(job);save();
          if(options.delayed) await new Promise(resolve=>{release=resolve});
          if(options.lostAck)throw Error('Reply lost');
          return {job:jobs.find(item=>item.id===job.id)};
        }
        if(method==='send.cancel') {
          if(options.cancelDelay)await new Promise(resolve=>{release=resolve});
          window.changes(params.jobId,{phase:options.cancelDone?'done':'cancelled',finishedAt:Date.now()});
          return {job:jobs.find(job=>job.id===params.jobId)};
        }
        if(method==='send.retry') {
          window.changes(params.jobId,{phase:'sending',error:null,finishedAt:null});
          return {job:jobs.find(job=>job.id===params.jobId)};
        }
        throw Error('Unexpected RPC '+method);
      }
    });
    function Fixture() {
      const activity=useSends(client,[source]);
      const [view,setView]=useState('send');
      const [jobId,setJobId]=useState(history.state?.jobId);
      window.reopen=()=>setView('send');
      return <div className="shell">
        <aside className={'sidebar'+(view==='home'?' showing':'')}><div className="bar"><h1>Helm</h1></div><div className="side-pad">
          <SendActivity jobs={activity.jobs} onOpen={job=>{setJobId(job.id);setView('send')}} />
        </div></aside>
        <section className={'main'+(view==='send'?' showing':'')}>
          {activity.notices.map(job=><SendNotice key={job.id} job={job} onOpen={()=>{setJobId(job.id);setView('send');activity.store.dismiss(job.id)}} onDismiss={()=>activity.store.dismiss(job.id)} />)}
          {view==='send'?<TransferView client={client} source={source} envs={[source,...targets.map(target=>({id:target.machineId,name:target.name,online:target.online,info:{}}))]} folder={options.path || (options.file?'~/video.mp4':'~/project')} jobId={jobId} session={options.task ? {id:'original',profileId:'codex'} : undefined}
            onBack={()=>setView('home')} onOpenSession={()=>{throw Error('Folder send started a session')}}
            onJob={job=>{setJobId(job.id);history.replaceState({jobId:job.id},'')}}
            onAgain={()=>{setJobId(undefined);history.replaceState({},'')}}
            onOpenFolder={(machineId,path)=>{window.openFolder={machineId,path}}}
            onStartChat={(machineId,path)=>{window.startChat={machineId,path}}}/>:<div className="pad">Home</div>}
        </section>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' })).outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => { await browser?.close(); });
async function fixture(size = sizes[0], options = {}) {
  const context = await browser.newContext({ viewport: size });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  await page.route('http://send-v2.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/fonts/')) return route.fulfill({ contentType: 'font/woff2', body: readFileSync('apps/web/public' + path) });
    return route.fulfill({ contentType: 'text/html', body:
      `<html data-theme="graphite"><head><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>` });
  });
  await page.addInitScript(options => { if (!localStorage.getItem('fixture.options')) localStorage.setItem('fixture.options', JSON.stringify(options)); }, options);
  await page.goto('http://send-v2.test/');
  page.cleanup = async () => { assert.deepEqual(page.errors, []); await context.close(); };
  return page;
}
async function shot(page, state) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${state} overflows`);
  assert.equal(await page.locator('.main.showing .scroll').evaluateAll(elements => elements.some(element => element.scrollWidth > element.clientWidth)), false, `${state} has horizontal scrolling`);
  if (process.env.HELM_TEST_SCREENSHOT_DIR) {
    mkdirSync(process.env.HELM_TEST_SCREENSHOT_DIR, { recursive: true });
    const { width, height } = page.viewportSize();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ animations: 'disabled', path: join(process.env.HELM_TEST_SCREENSHOT_DIR, `send-v2-${state}-${width}x${height}.png`) });
  }
}
async function begin(page, label = 'Send to VM') { await page.getByRole('button', { name: label, exact: true }).click(); await page.getByRole('status').filter({hasText:'Preparing…'}).waitFor(); }
async function change(page, patch, emit = true, id = 'job-1') { await page.evaluate(({id,patch,emit}) => window.changes(id,patch,emit), {id,patch,emit}); }
const sendingPatch = { phase:'sending', bytes:{total:1000,sent:400}, files:{total:10,sent:4},rate:200,eta:3 };
const donePatch = { phase:'done',bytes:{total:1000,sent:1000}, files:{total:10,sent:10},finishedAt:Date.now(),eta:0 };

for (const size of sizes) {
  test(`send plan → progress → receipt, exact destination actions at ${size.width}`, async () => {
    const page=await fixture(size);
    try {
      const action=page.getByRole('button',{name:'Send to VM',exact:true});
      await action.waitFor();
      await shot(page,'plan');
      const heading = await page.locator('.send-destination .section .send-path').boundingBox();
      const summary = await page.locator('.send-context').boundingBox();
      assert.equal(heading.x, summary.x, 'destination heading aligns with the summary');
      assert.equal(await page.getByRole('button',{name:'Send to Home PC',exact:true}).count(),0);
      await page.getByRole('checkbox').uncheck();
      await begin(page);
      assert.deepEqual(await page.evaluate(()=>window.calls.find(call=>call.method==='send.start')),{
        env:'source',method:'send.start',params:{path:'~/project',targetMachineId:'target',includeEnv:false}});
      await change(page,sendingPatch);
      await page.getByText('4 of 10 files · 200 B/s · 3s left',{exact:true}).waitFor();
      await shot(page,'progress');
      await change(page,{...sendingPatch,phase:'finishing',bytes:{total:1000,sent:1000},eta:null});
      await page.getByRole('status').filter({hasText:'Finishing…'}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Open folder there',exact:true}).count(),0);
      await change(page,donePatch);
      await page.getByText('On VM in ~/project',{exact:true}).waitFor();
      await page.getByText('project is on VM · View',{exact:true}).waitFor();
      await shot(page,'done');
      const note = await page.getByText('Files stay on Laptop.',{exact:true}).boundingBox();
      const open = await page.getByRole('button',{name:'Open folder there',exact:true}).boundingBox();
      assert.ok(open.y - (note.y + note.height) <= 20, 'receipt actions sit below the summary');
      await page.getByRole('button',{name:'Open folder there',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.openFolder),{machineId:'target',path:'~/project'});
      await page.getByRole('button',{name:'Start a chat there',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.startChat),{machineId:'target',path:'~/project'});
      assert.equal(await page.evaluate(()=>window.calls.some(call=>call.method==='session.start')),false);
    } finally {await page.cleanup();}
  });
  test(`send again uses the same folder and shows changed counts at ${size.width}`, async () => {
    const page=await fixture(size);
    try {
      await begin(page);await change(page,donePatch);
      await page.getByRole('button',{name:'Send again',exact:true}).click();
      await page.getByRole('button',{name:'Send again to VM',exact:true}).waitFor();
      await page.getByText('Only changes will be sent.',{exact:true}).waitFor();
      assert.equal(await page.getByText('About 42,000 files · 2.0 GB',{exact:true}).count(),0);
      await shot(page,'again-plan');
      await begin(page,'Send again to VM');
      await change(page,{...sendingPatch,bytes:{total:120,sent:48},files:{total:2,sent:1},rate:24,changed:{files:2,bytes:120}},true,'job-2');
      await page.getByText('2 changed files · 120 B',{exact:true}).waitFor();
      await shot(page,'again-progress');
      const starts=await page.evaluate(()=>window.calls.filter(call=>call.method==='send.start'));
      assert.equal(starts.length,2);
      const destinations=await page.evaluate(()=>window.jobs().map(job=>job.target.path));
      assert.deepEqual(destinations,['~/project','~/project']);
      await change(page,{...donePatch,bytes:{total:0,sent:0},files:{total:0,sent:0},changed:{files:0,bytes:0}},true,'job-2');
      await page.getByText('Already up to date.',{exact:true}).waitFor();
    } finally {await page.cleanup();}
  });
  test(`failure retries the existing job and cancel waits for acknowledgement at ${size.width}`, async () => {
    const page=await fixture(size,{cancelDelay:true});
    try {
      await begin(page);await change(page,{phase:'failed',error:'VM needs more free space.'});
      await page.getByText('VM needs more free space.',{exact:true}).waitFor();await shot(page,'failed');
      await page.getByRole('button',{name:'Retry',exact:true}).click();
      await page.getByRole('status').filter({hasText:'Sending…'}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.calls.find(call=>call.method==='send.retry')),{env:'source',method:'send.retry',params:{jobId:'job-1'}});
      await page.getByRole('button',{name:'Cancel send',exact:true}).click();
      await page.getByRole('button',{name:'Stopping…',exact:true}).waitFor();
      assert.equal(await page.getByRole('status').filter({hasText:'Cancelled'}).count(),0);
      await page.evaluate(()=>window.release());
      await page.getByRole('status').filter({hasText:'Cancelled'}).waitFor();await shot(page,'cancelled');
      await page.getByRole('button',{name:'Retry',exact:true}).click();
      await page.getByRole('status').filter({hasText:'Sending…'}).waitFor();
      assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.method==='send.start').length),1);
    } finally {await page.cleanup();}
  });
  test(`navigation, sidebar and reload recover a running send at ${size.width}`, async () => {
    const page=await fixture(size);
    try {
      await begin(page);await change(page,sendingPatch);
      await page.getByRole('button',{name:'Back',exact:true}).click();
      const activity=page.getByRole('button',{name:'project → VM 40% · 3s left',exact:true});
      await activity.waitFor();await shot(page,'sidebar');
      await activity.click();
      await page.getByText('4 of 10 files · 200 B/s · 3s left',{exact:true}).waitFor();
      await page.reload();
      await page.getByText('4 of 10 files · 200 B/s · 3s left',{exact:true}).waitFor();await shot(page,'reloaded');
      assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.method==='send.start').length),0);
      assert.ok(await page.evaluate(()=>window.calls.some(call=>call.method==='send.list')));
      assert.ok(await page.evaluate(()=>window.calls.some(call=>call.method==='send.status'&&call.params.jobId==='job-1')));
      // Miss an event: the 2-second fallback must still finish the same job.
      await change(page,donePatch,false);
      await page.getByText('On VM in ~/project',{exact:true}).waitFor();
      await page.getByText('project is on VM · View',{exact:true}).waitFor();
      await change(page,donePatch);
      assert.equal(await page.getByText('project is on VM · View',{exact:true}).count(),1);
    } finally {await page.cleanup();}
  });
}
test('single files, target changes, offline defaults and plan retry use the same flow', async () => {
  const page=await fixture(sizes[0],{file:true,planFailure:true});
  try {
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await page.getByRole('button',{name:'Send to VM',exact:true}).waitFor();
    await page.getByRole('checkbox').uncheck();
    await page.getByRole('button',{name:'Change',exact:true}).click();
    await page.getByRole('button',{name:'Home PC ~/project',exact:true}).click();
    assert.equal(await page.getByRole('checkbox').isChecked(),false);
    await begin(page,'Send to Home PC');await change(page,donePatch);
    await page.getByRole('button',{name:'Open folder there',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.openFolder),{machineId:'other',path:'~'});
    await shot(page,'file-done');
  } finally {await page.cleanup();}
  const offline=await fixture(sizes[0],{offline:true});
  try {
    await offline.getByText('VM is offline. Try again when it is back.',{exact:true}).waitFor();
    assert.equal(await offline.getByRole('button',{name:'Send to VM',exact:true}).isDisabled(),true);
    await shot(offline,'offline');
  } finally {await offline.cleanup();}
});
test('start shows preparing immediately and lost acknowledgement discovers the existing job', async () => {
  const page=await fixture(sizes[0],{delayed:true,lostAck:true});
  try {
    await begin(page);
    assert.equal(await page.getByRole('button',{name:'Send to VM',exact:true}).count(),0);
    await page.evaluate(()=>window.release());
    await page.getByRole('button',{name:'Cancel send',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.method==='send.start').length),1);
    await change(page,sendingPatch);
    await page.getByText('4 of 10 files · 200 B/s · 3s left',{exact:true}).waitFor();
    await page.evaluate(()=>window.emitJob({...window.jobs()[0],phase:'preparing',updatedAt:1}));
    await page.getByText('4 of 10 files · 200 B/s · 3s left',{exact:true}).waitFor();
    assert.equal(await page.getByRole('status').filter({hasText:'Preparing…'}).count(),0);
  } finally {await page.cleanup();}
});

test('a delayed start reply keeps navigation where the user left it', async () => {
  const page=await fixture(sizes[0],{delayed:true});
  try {
    await begin(page);
    await page.getByRole('button',{name:'Back',exact:true}).click();
    await page.evaluate(()=>window.release());
    await page.getByRole('button',{name:'project → VM Preparing…',exact:true}).waitFor();
    assert.equal(await page.locator('.main.showing').count(),0);
    await shot(page,'start-in-background');
  } finally {await page.cleanup();}
});
test('cancel finishing may acknowledge a completed send instead of cancellation', async () => {
  const page=await fixture(sizes[0],{cancelDone:true});
  try {
    await begin(page);await change(page,{...sendingPatch,phase:'finishing'});
    await page.getByRole('button',{name:'Cancel send',exact:true}).click();
    await page.getByText('On VM in ~/project',{exact:true}).waitFor();
    assert.equal(await page.getByRole('status').filter({hasText:'Cancelled'}).count(),0);
  } finally {await page.cleanup();}
});
for(const size of sizes) test(`long names and paths wrap at ${size.width}`,async()=>{
  const name='project-with-a-very-long-unbroken-name-'.repeat(4);
  const target='Long target machine name '+ 'VM'.repeat(35);
  const page=await fixture(size,{path:'~/work/'+name,sourceName:'Laptop with a long name '.repeat(8),targetName:target,destination:'~/'+name});
  try{
    await page.getByRole('button',{name:'Send to '+target,exact:true}).waitFor();
    await shot(page,'long-plan');
    await page.locator('.main .scroll').evaluate(element=>{element.scrollTop=element.scrollHeight});await shot(page,'long-plan-bottom');
    await begin(page,'Send to '+target);await change(page,sendingPatch);await shot(page,'long-progress');
    await change(page,donePatch);await page.getByRole('button',{name:'Open folder there',exact:true}).waitFor();await shot(page,'long-done');
    await page.locator('.main .scroll').evaluate(element=>{element.scrollTop=element.scrollHeight});await shot(page,'long-done-bottom');
  }finally{await page.cleanup();}
});
test('a remembered non-VM default is used without a machine picker',async()=>{
  const page=await fixture(sizes[0],{defaultTarget:'other'});
  try{await begin(page,'Send to Home PC');assert.equal(await page.evaluate(()=>window.calls.find(call=>call.method==='send.start').params.targetMachineId),'other');}
  finally{await page.cleanup();}
});

test('a completion discovered after reload announces a previously running job once',async()=>{
  const page=await fixture(sizes[0]);
  try{
    await begin(page);await page.getByRole('button',{name:'Back',exact:true}).click();
    await change(page,donePatch,false);
    await page.reload();
    await page.getByText('project is on VM · View',{exact:true}).waitFor();
    await page.reload();
    await page.getByText('On VM in ~/project',{exact:true}).waitFor();
    assert.equal(await page.getByText('project is on VM · View',{exact:true}).count(),0);
  }finally{await page.cleanup();}
});

test('task options and files-only conversion preserve the chosen target and environment choice',async()=>{
  const page=await fixture(sizes[0]);
  try{
    await page.getByRole('button',{name:'Send to VM',exact:true}).waitFor();
    await page.getByRole('checkbox').uncheck();
    await page.getByRole('button',{name:'Change',exact:true}).click();
    await page.getByRole('button',{name:'Home PC ~/project',exact:true}).click();
    await page.getByText('Options',{exact:true}).click();
    await page.getByRole('button',{name:'Send a task with these files',exact:true}).click();
    await page.getByRole('button',{name:'Send task to Home PC',exact:true}).waitFor();
    await page.getByText('Agent and destination options',{exact:true}).click();
    assert.equal(await page.getByLabel('Include .env files').isChecked(),false);
    // The mode checkbox navigates to a different component; click avoids checking a removed input.
    await page.getByRole('checkbox',{name:'Send a task with this project',exact:false}).click();
    await page.getByRole('button',{name:'Send to Home PC',exact:true}).waitFor();
    assert.equal(await page.getByRole('checkbox').isChecked(),false);
    assert.equal(await page.evaluate(()=>window.calls.some(call=>call.method==='send.start'||call.method==='task.send')),false);
  }finally{await page.cleanup();}
});


test('Send files only exits task mode into the durable engine without grants', async () => {
  const page = await fixture(sizes[0], {task:true});
  try {
    await page.getByRole('button',{name:'Send files only',exact:true}).click();
    await page.getByRole('button',{name:'Send to VM',exact:true}).waitFor();
    await begin(page);
    const calls = await page.evaluate(()=>window.calls);
    assert.ok(calls.some(call=>call.method==='send.plan'));
    assert.ok(calls.some(call=>call.method==='send.start'));
    assert.equal(calls.some(call=>['transfer.invite','transfer.send','task.send'].includes(call.method)),false);
    assert.equal('destination' in calls.find(call=>call.method==='send.start').params,false);
  } finally {await page.cleanup();}
});

test('an older target warning stays visible on its completion receipt', async () => {
  const page = await fixture(sizes[0]);
  try {
    await begin(page);
    await change(page,{...donePatch,error:'Older target: atomic publication is unavailable.'});
    await page.getByRole('button',{name:'Open folder there',exact:true}).waitFor();
    await page.getByRole('status').filter({hasText:'Older target: atomic publication is unavailable.'}).waitFor();
  } finally {await page.cleanup();}
});
