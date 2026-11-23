import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

let browser, bundle;
const css = readFileSync('apps/web/src/styles.css', 'utf8').replace(/^@import[^;]+;/gm, '');
before(async () => {
  bundle = (await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Client} from './apps/web/src/client';
    import {TransferView} from './apps/web/src/Transfer';
    import {useSends} from './apps/web/src/send/store';
    const options = JSON.parse(localStorage.getItem('fixture.options') || '{}');
    const source = {id:'source',name:'Laptop',online:true,info:{}};
    const targets = [{machineId:'target',name:'VM',online:true,destination:'~/project',sentBefore:null}];
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
        if(method==='send.plan') return {path:params.path,name:'project',kind:'folder',git:{branch:'main',dirty:true},
          files:42000,bytes:2e9,envFiles:['.env'],left:[],estimate:true,targets,defaultTarget:'target'};
        if(method==='send.list') return {jobs};
        if(method==='send.status') return {job:jobs.find(job=>job.id===params.jobId)};
        if(method==='send.start') {
          const now=Date.now();
          const job={id:'job-'+(jobs.length+1),createdAt:now,updatedAt:now,finishedAt:null,
            source:{machineId:'source',name:source.name,path:params.path,kind:'folder'},
            target:{machineId:params.targetMachineId,name:'VM',path:'~/project'},
            again:false,phase:'preparing',bytes:{total:null,sent:0},files:{total:null,sent:0},
            rate:null,eta:null,changed:null,route:null,error:null,left:[]};
          jobs.unshift(job);save();
          if(options.delayed) await new Promise(resolve=>{release=resolve});
          if(options.lostAck)throw Error('Reply lost');
          return {job:jobs.find(item=>item.id===job.id)};
        }
        throw Error('Unexpected RPC '+method);
      }
    });
    function Fixture() {
      useSends(client,[source]);
      const [jobId,setJobId]=useState(history.state?.jobId);
      return <div className="shell"><section className="main showing">
        <TransferView client={client} source={source} envs={[source,{id:'target',name:'VM',online:true,info:{}}]} folder="~/project" jobId={jobId}
          onBack={()=>{}} onOpenSession={()=>{throw Error('Folder send started a session')}}
          onJob={job=>{setJobId(job.id);history.replaceState({jobId:job.id},'')}}/>
      </section></div>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' })).outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => { await browser?.close(); });
async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  await page.route('http://send-v2.test/**', route => route.fulfill({ contentType: 'text/html', body:
    `<html data-theme="graphite"><head><style>${css}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>` }));
  await page.addInitScript(options => { if (!localStorage.getItem('fixture.options')) localStorage.setItem('fixture.options', JSON.stringify(options)); }, options);
  await page.goto('http://send-v2.test/');
  page.cleanup = async () => { assert.deepEqual(page.errors, []); await context.close(); };
  return page;
}
async function begin(page) { await page.getByRole('button', { name: 'Send to VM', exact: true }).click(); await page.getByRole('status').filter({hasText:'Helm is preparing the send.'}).waitFor(); }
async function change(page, patch, emit = true) { await page.evaluate(({patch,emit}) => window.changes('job-1',patch,emit), {patch,emit}); }
const sendingPatch = { phase:'sending', bytes:{total:1000,sent:400}, files:{total:10,sent:4},rate:200,eta:3 };
const donePatch = { phase:'done',bytes:{total:1000,sent:1000}, files:{total:10,sent:10},finishedAt:Date.now(),eta:0 };
const progress = '4 of 10 files · 200 B/s · 3s left';

test('reload recovers a running send without starting it again', async () => {
  const page=await fixture();
  try {
    await begin(page);await change(page,sendingPatch);
    await page.getByText(progress,{exact:true}).waitFor();
    await page.reload();
    await page.getByText(progress,{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.method==='send.start').length),0);
    assert.ok(await page.evaluate(()=>window.calls.some(call=>call.method==='send.status'&&call.params.jobId==='job-1')));
    // Miss an event: the 2-second fallback must still finish the same job.
    await change(page,donePatch,false);
    await page.getByText('On VM in ~/project',{exact:true}).waitFor();
  } finally {await page.cleanup();}
});

test('a lost start reply finds the existing job instead of sending twice', async () => {
  const page=await fixture({delayed:true,lostAck:true});
  try {
    await begin(page);
    assert.equal(await page.getByRole('button',{name:'Send to VM',exact:true}).count(),0);
    await page.evaluate(()=>window.release());
    await page.getByRole('button',{name:'Cancel send',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.method==='send.start').length),1);
    await change(page,sendingPatch);
    await page.getByText(progress,{exact:true}).waitFor();
    // A stale event cannot move the job back.
    await page.evaluate(()=>window.emitJob({...window.jobs()[0],phase:'preparing',updatedAt:1}));
    await page.getByText(progress,{exact:true}).waitFor();
    assert.equal(await page.getByRole('status').filter({hasText:'Helm is preparing the send.'}).count(),0);
  } finally {await page.cleanup();}
});
