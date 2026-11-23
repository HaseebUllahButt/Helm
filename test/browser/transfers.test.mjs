import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
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
    const client = {pendingActions:()=>[],resumeActions:async()=>[],
      transferPreview:async(_env,_folder,includeEnv)=>{
        window.previewEnv = includeEnv;
        return {rootName:'project',preflight};
      },
      rpc:async(env,method,params)=>{
        if(method==='agent.list') return {agents:[{id:'codex',label:'Codex',available:true}]};
        if(method==='session.events') return {session:{id:'remote',cwd:'/destination'}};
        if(method==='task.status') return {return:{status:'returned'}};
        if(method!=='task.send') throw new Error('Unexpected method '+method);
        window.attempts.push(params);
        if(window.attempts.length===1) throw new Error('Reply lost; retry the task');
        if(window.attempts.length===2) return {sent:false,status:'copying',targetName:'VM',preflight,
          progress:{phase:'sending',folder:'/destination',bytes:400,total:1000,files:{total:10,sent:4},rate:200,eta:3,jobId:'durable-task-job'}};
        return {sent:true,status:'running',targetMachineId:'target',targetName:'VM',route:'direct',preflight,
          receipt:{sessionId:'remote',folder:'/destination',files:2,bytes:20}};
      }
    };
    let root = createRoot(document.getElementById('root'));
    const mount = () => root.render(<TransferView client={client} source={source}
      envs={[source,target]} folder='/project' session={session} onBack={()=>{}}
      onOpenSession={(env,session)=>{window.opened={env,session};}} />);
    window.reopenTransfer = () => { root.unmount(); root = createRoot(document.getElementById('root')); mount(); };
    mount();
  `, resolveDir:process.cwd(),loader:'tsx' },bundle:true,write:false,format:'iife',jsx:'automatic'});
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    const page = await browser.newPage();
    await page.route('http://helm-transfer.test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://helm-transfer.test/');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.getByRole('button',{name:'Send task to VM',exact:true}).click();
    await page.getByText('Reply lost; retry the task',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Include .env files').isChecked(),true);
    assert.equal(await page.getByLabel('Include .env files').isDisabled(),true);
    assert.equal(await page.getByLabel('Instructions for continuing').isDisabled(),true);
    await page.evaluate(() => window.reopenTransfer());
    await page.getByRole('button', { name: 'Forget saved send', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => window.attempts.length), 1, 'closing recovery does not send anything');
    await page.getByRole('button',{name:'Retry to VM',exact:true}).click();
    await page.getByText('Helm is copying files to VM: 40% of 1000 B · 200 B/s',{exact:true}).waitFor();
    await page.getByText('Running on VM',{exact:true}).waitFor();
    const attempts = await page.evaluate(()=>window.attempts);
    assert.equal(attempts.length,3);
    assert.deepEqual(attempts[0],attempts[1]);
    assert.deepEqual(attempts[1],attempts[2]);
    assert.equal(attempts[0].includeEnv,true);
    assert.equal(attempts[0].allowSkipped,true);
    await page.getByText('Task returned here',{exact:true}).waitFor();
    assert.equal(attempts[0].sessionId,'original');
    await page.getByRole('button',{name:'Open task there',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.opened),{env:'target',session:{id:'remote',cwd:'/destination'}});
  } finally {await browser.close();}
});
