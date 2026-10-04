import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('managed agent conversation exposes Send task in its menu', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    const session = {id:'thread',title:'Build feature',cwd:'/project',engine:'codex',profileId:'codex',status:'idle',driver:true};
    const client = {
      on:()=>()=>{}, subscribe:()=>{},
      rpc:async(_env,method)=>{
        if(method==='model.list') return {models:[],modes:[]};
        if(method==='session.events') return {session,events:[],pending:[],last:0};
        if(method==='session.list') return {sessions:[]};
        return {ok:true};
      }
    };
    createRoot(document.getElementById('root')).render(<DrivenSession client={client}
      env={{id:'source',name:'Laptop',online:true,info:{}}} session={session}
      onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}}
      onSendTask={()=>{window.sendTaskClicked=true}} />);
  `, resolveDir:process.cwd(),loader:'tsx' },bundle:true,write:false,format:'iife',jsx:'automatic'});
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    const page = await browser.newPage();
    await page.route('http://helm-task-test/**', (route) => route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
    await page.goto('http://helm-task-test/');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.getByRole('button',{name:'more',exact:true}).click();
    await page.getByRole('button',{name:'Send task to another machine',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.sendTaskClicked),true);
  } finally {await browser.close();}
});

test('Send task includes env, keeps a retry identity, and opens the destination thread', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { TransferView } from './apps/web/src/Transfer';
    const source = {id:'source',name:'Laptop',online:true,info:{}};
    const target = {id:'target',name:'VM',online:true,info:{}};
    const session = {id:'original',cwd:'/project',profileId:'codex',engine:'codex',title:'Build feature'};
    const preflight = {files:2,bytes:20,envFiles:['.env'],skipped:0,skippedEntries:[],warnings:[],requiresAcknowledgement:false};
    window.attempts = [];
    const client = {
      transferPreview:async(_env,_folder,includeEnv)=>{
        window.previewEnv = includeEnv;
        return {rootName:'project',preflight};
      },
      rpc:async(env,method,params)=>{
        if(method==='agent.list') return {agents:[{id:'codex',label:'Codex',available:true}]};
        if(method==='session.events') return {session:{id:'remote',cwd:'/destination'}};
        if(method!=='task.send') throw new Error('Unexpected method '+method);
        window.attempts.push(params);
        if(window.attempts.length===1) throw new Error('Reply lost; retry the task');
        return {sent:true,status:'running',targetMachineId:'target',targetName:'VM',route:'direct',preflight,
          receipt:{sessionId:'remote',folder:'/destination',files:2,bytes:20}};
      }
    };
    createRoot(document.getElementById('root')).render(<TransferView client={client} source={source}
      envs={[source,target]} folder='/project' session={session} onBack={()=>{}}
      onOpenSession={(env,session)=>{window.opened={env,session};}} />);
  `, resolveDir:process.cwd(),loader:'tsx' },bundle:true,write:false,format:'iife',jsx:'automatic'});
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.getByRole('button',{name:'Send task to VM',exact:true}).click();
    await page.getByText('Reply lost; retry the task',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Include .env files').isChecked(),true);
    assert.equal(await page.getByLabel('Instructions for continuing').isDisabled(),true);
    await page.getByRole('button',{name:'Retry to VM',exact:true}).click();
    await page.getByText('Running on VM',{exact:true}).waitFor();
    const attempts = await page.evaluate(()=>window.attempts);
    assert.equal(attempts.length,2);
    assert.deepEqual(attempts[0],attempts[1]);
    assert.equal(attempts[0].includeEnv,true);
    assert.equal(attempts[0].sessionId,'original');
    await page.getByRole('button',{name:'Open task there',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.opened),{env:'target',session:{id:'remote',cwd:'/destination'}});
  } finally {await browser.close();}
});

test('Send Project shows origin before sending and in the receipt, including setup failures', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { TransferView } from './apps/web/src/Transfer';
    const root = createRoot(document.getElementById('root'));
    const remote = 'git@github.com:owner/project.git';
    const preflight = {files:1,bytes:10,envFiles:[],skipped:0,skippedEntries:[],warnings:[],requiresAcknowledgement:false};
    const source = {id:'source',name:'Laptop',online:true,info:{}};
    const target = {id:'target',name:'VM',online:true,info:{}};
    const client = {
      transferPreview:async()=>({rootName:'project',git:{remote},preflight}),
      transferInvite:async()=>({grant:'test'}),
      transferSend:async(_env,params)=>{
        window.sent = params;
        return {sent:true,targetMachineId:'target',targetName:'VM',preflight,receipt:{
          folder:'/project',files:1,bytes:10,readiness:{status:'unverified',checks:[]},
          repository:{remote,configured:window.configured,error:'Origin could not be configured; add it on the target before pulling.'}
        }};
      }
    };
    window.show = configured => {
      window.configured = configured;
      root.render(<TransferView key={String(configured)} client={client} source={source} envs={[source,target]}
        folder='/project' onBack={()=>{}} onOpenSession={()=>{}} />);
    };
  `, resolveDir:process.cwd(),loader:'tsx' },bundle:true,write:false,format:'iife',jsx:'automatic'});
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    for (const configured of [true,false]) {
      await page.evaluate(configured=>window.show(configured),configured);
      await page.getByLabel('Git origin',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('Git origin',{exact:true}).inputValue(),'git@github.com:owner/project.git');
      await page.getByRole('button',{name:'Send to VM',exact:true}).click();
      await page.getByText('Arrived on VM',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('Git origin',{exact:true}).inputValue(),'git@github.com:owner/project.git');
      assert.equal((await page.evaluate(()=>window.sent)).folder,'/project');
      await page.getByText(configured
        ? 'Origin is configured. Fetch or pull here using this machine’s GitHub login.'
        : 'Origin could not be configured; add it on the target before pulling.',{exact:true}).waitFor();
    }
  } finally {await browser.close();}
});
