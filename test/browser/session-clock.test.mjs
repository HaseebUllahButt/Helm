import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('the working clock updates without redrawing the chat or losing a draft', async t => {
  const bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {DrivenSession} from './apps/web/src/session/DrivenSession';
    let seq=3; const listeners=new Set(); window.calls=[]; window.composerRenders=0; window.chatRenders=0; window.transcriptRenders=0;
    const initial={id:'stream-test',engine:'claude',driver:'claude',profileId:'claude',model:'a',status:'working',cwd:'/project',title:'Stream'};
    window.other=()=>{for(const f of listeners)f('machine','session.update',{session:{...initial,id:'other',title:'Other chat',updatedAt:Date.now()}})}; window.emit=(events)=>{const stamped=events.map(e=>({seq:++seq,at:Date.now(),...e}));for(const f of listeners)f('machine','session.event',{id:initial.id,events:stamped});};
    const client={on:f=>{listeners.add(f);return()=>listeners.delete(f)},subscribe:()=>()=>{},input:async(e,p)=>window.calls.push({method:'session.input',params:p}),rpc:async(e,m,p)=>{
      if(m==='session.watch')return {last:seq,status:initial.status};
      if(m==='session.events')return {session:initial,pending:[],last:3,events:[
        {seq:1,at:Date.now()-60000,type:'turn.start',turnId:'t',text:'Continue'},
        {seq:2,at:Date.now(),type:'status',status:'working'},
        {seq:3,at:Date.now(),type:'item.start',id:'answer',kind:'text',turnId:'t'}]};
      if(m==='model.list')return {models:['a','b'],labels:{a:'Model A',b:'Model B'},default:'a'};
      if(m==='session.commands')return {commands:[{name:'review'}]};
      if(m==='session.list')return {sessions:[]};
      if(m==='git.status')return {repo:false};
      if(m==='usage.limits')return {accounts:[]};
      window.calls.push({method:m,params:p});return {};
    }};
    function App(){const [session,setSession]=useState(initial);return <DrivenSession client={client} env={{id:'machine',name:'Machine',online:true}} session={session} onSession={setSession} onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}}/>}
    createRoot(document.getElementById('root')).render(<App/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    plugins: [{ name: 'count-real-composer-renders', setup(b) {
      b.onLoad({filter:/\/session\/(DrivenSession|Transcript)\.tsx$/,}, async args => ({loader:'tsx',contents:(await readFile(args.path,'utf8')).replace('  const { log, error:', '  window.chatRenders++; const { log, error:').replace('  const requestKey =', '  window.transcriptRenders++; const requestKey =')}));
      b.onLoad({ filter: /\/session\/Composer\.tsx$/ }, async args => ({ loader: 'tsx', contents:
        (await readFile(args.path, 'utf8')).replace('const [keys, setKeys]', 'window.composerRenders++; const [keys, setKeys]') }));
    } }],
  });
  const browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(6000);
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.route('http://helm.test/**', r=>r.fulfill({contentType:'text/html',body:'<div class="main showing"><div class="session" id="root"></div></div>'}));
  await page.goto('http://helm.test/');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const box=page.locator('textarea[data-composer]');
  await page.locator('button[title="model: a"]').waitFor();
  await page.getByText('working 1m',{exact:true}).waitFor();
  await box.fill('Keep this draft');
  await page.locator('.turn.user').waitFor();
  await page.waitForTimeout(500);
  const renders=await page.evaluate(async()=>{
    window.composerRenders=0; window.chatRenders=0; window.transcriptRenders=0;
    const start=performance.now();
    for(let i=0;i<110;i++){
      window.other();
      const box=document.querySelector('textarea[data-composer]');
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(box, 'Keep this draft '+i);
      box.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,100));
    }
    return {ms:performance.now()-start,chat:window.chatRenders,transcript:window.transcriptRenders,composer:window.composerRenders};
  });
  console.log('11 seconds of typing and other chat updates:', renders);
  assert.equal(await box.inputValue(),'Keep this draft 109');
  assert.equal(renders.chat,0,'the header clock must not redraw the chat');
  assert.equal(renders.transcript,0,'typing and other chats must not redraw the transcript');
  await page.evaluate(()=>window.emit([{type:'item.delta',id:'answer',text:'Visible streamed words'}]));
  await page.getByText('Visible streamed words',{exact:true}).waitFor();
  await page.evaluate(async()=>{for(let i=0;i<25;i++){
    window.emit([{type:'item.delta',id:'answer',text:' more words'}]);
    await new Promise(r=>setTimeout(r,100));
  }});
  await page.locator('.chip.working').filter({hasText:'tok/s'}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('.chip.working')?.textContent.includes('tok/s'),{timeout:5000});
  await page.getByRole('button',{name:'model: a',exact:true}).click();
  await page.getByRole('option',{name:'Model B',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.emit([{type:'permission.request',requestId:'approval-now',kind:'command',title:'Run a check',options:[{id:'allow',role:'allow',label:'Allow'}]}]));
  await page.getByText('Run a check',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.answer'&&c.params.requestId==='approval-now'));
  await page.evaluate(()=>window.emit([{type:'permission.resolved',requestId:'approval-now'},{type:'turn.done',turnId:'t',status:'ok'},{type:'status',status:'idle'}]));
  await page.getByRole('button',{name:'send',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.input'&&c.params.data==='Keep this draft 109'));
  assert.deepEqual(errors,[]);
});
