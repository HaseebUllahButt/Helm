import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('model choice paints before a slow reply, retains its catalog, and rolls back on rejection', async t => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    window.requests = []; window.catalogs = 0; window.listeners = [];
    const initial = {id:'latency',engine:'codex',driver:'codex',profileId:'test',model:'a',status:'idle',cwd:'/project',title:'Test'};
    const client = {pendingActions:()=>[],resumeActions:async()=>[],on:f=>{window.listeners.push(f);return ()=>{window.listeners=window.listeners.filter(x=>x!==f)}},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
      if(method==='session.events')return {events:[],pending:[],last:0,session:{status:'idle'}};
      if(method==='model.list') {
        if(++window.catalogs>1)return new Promise(resolve=>{window.finishCatalog=resolve});
        return {models:['a','b','c'],labels:{a:'Model A',b:'Model B',c:'Model C'},default:'a'};
      }
      if(method==='session.model')return new Promise((resolve,reject)=>window.requests.push({params,resolve,reject}));
      return {ok:true,pending:[],sessions:[]};
    }};
    function App(){const [session,setSession]=useState(initial);
      window.update = patch => window.listeners.forEach(f=>f('machine','session.update',{session:{...initial,...patch}}));
      return <DrivenSession client={client} env={{id:'machine',name:'Machine',online:true}} session={session}
        onSession={setSession} onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}}/>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `, resolveDir:process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic' });
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  t.after(()=>browser.close());
  const page=await browser.newPage(); page.setDefaultTimeout(5000);
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://helm.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm.test/'); await page.addScriptTag({content:bundle.outputFiles[0].text});
  const chip=()=>page.locator('button[title^="model:"]');
  await chip().click(); await page.getByRole('option',{name:'Model B',exact:true}).click();
  await page.waitForFunction(()=>window.requests.length===1);
  assert.equal(await chip().getAttribute('title'),'model: b');
  assert.equal(await chip().getAttribute('aria-busy'),'true');
  // Unrelated pushes must not erase the pending choice.
  await page.evaluate(()=>window.update({title:'Live update'}));
  assert.equal(await chip().getAttribute('title'),'model: b');
  await page.evaluate(()=>window.requests[0].resolve({session:{id:'latency',engine:'codex',driver:'codex',profileId:'test',model:'b',status:'idle',cwd:'/project'}}));
  await page.waitForFunction(()=>window.catalogs===2);
  assert.equal(await chip().getAttribute('aria-busy'),null);
  await chip().click(); await page.getByRole('option',{name:'Model C',exact:true}).click();
  await page.waitForFunction(()=>window.requests.length===2);
  assert.equal(await chip().getAttribute('title'),'model: c');
  await page.evaluate(()=>window.requests[1].reject(new Error('Model unavailable')));
  await page.getByText('This account cannot use this model. Select another model.',{exact:true}).waitFor();
  assert.equal(await chip().getAttribute('title'),'model: b');
  assert.equal(await chip().getAttribute('aria-busy'),null);
  assert.deepEqual(errors,[]);
});
