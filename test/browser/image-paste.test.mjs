import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
let browser, script;
before(async () => {
  const result = await build({
    stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { SessionView } from './apps/web/src/App';
      import { DrivenSession } from './apps/web/src/session/DrivenSession';
      import { QueueEdit } from './apps/web/src/session/QueueEdit';
      import { clipboardImages } from './apps/web/src/session/image';
      window.clipboardImages = clipboardImages;
      window.calls=[]; window.fail=false;
      const client={on:()=>()=>{},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
        if(method==='session.messages')return {messages:[],status:'idle'};
        if(method==='session.pending')return {pending:[]};
        if(method==='session.events')return {events:[],pending:[],last:0,session:{status:'idle'}};
        if(method==='model.list')return {models:[],default:null};
        if(method==='session.input'){
          window.calls.push({env,method,params});
          if(window.fail)throw Error('upload failed');
          if(window.hold)return new Promise(resolve=>window.resolveSend=resolve);
        }
        return {ok:true,pending:[]};
      }};
      const root=createRoot(document.getElementById('root'));
      window.showDriven=(env='laptop',id='driven-image-test')=>root.render(<DrivenSession key={env+':'+id} client={client} env={{id:env,name:'Laptop',online:true}}
        session={{id,engine:'codex',driver:'codex',status:'idle',cwd:'/project',title:'Codex'}}
        onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} />);
      window.showQueue=()=>root.render(<QueueEdit turn={{id:'queued',text:'Queued'}} onCancel={()=>{}}
        onSave={(text,attachments)=>window.saved={text,attachments}} />);
      window.showNative=(env='laptop',id='native-image-test')=>root.render(<SessionView key={env+':'+id} client={client} env={{id:env,name:'Laptop',online:true}}
        session={{id,engine:'claude',nativeChat:true,nativeCli:true,pty:true,status:'idle',cwd:'/project',title:'Native Claude'}}
        onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} />);
      window.showNative();
    `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic',
    plugins:[{name:'test-session-view',setup(b){ b.onLoad({filter:/\/App\.tsx$/}, async a=>({contents:await readFile(a.path,'utf8')+'\nexport { SessionView };',loader:'tsx'})); }}],
  });
  script=result.outputFiles[0].text;
  browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());
async function pageFor(t){
  const p=await browser.newPage();t.after(()=>p.close()); p.on("pageerror", e=>t.diagnostic(e.message));
  await p.route('http://helm.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await p.goto('http://helm.test/');await p.addScriptTag({content:script});await p.locator('textarea').waitFor();
  await p.waitForFunction(()=>!document.querySelector('.attach-status'));return p;
}
async function paste(p, count=1){
  await p.waitForFunction(()=>!document.querySelector('.attach-status'));
  await p.evaluate(async count=>{
  const c=document.createElement('canvas');c.width=32;c.height=24;c.getContext('2d').fillRect(0,0,32,24);
  const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
  const dt=new DataTransfer();
  for(let i=0;i<count;i++)dt.items.add(new File([blob],`screen-${i}.png`,{type:'image/png'}));
  document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
},count);await p.locator('.attach-preview img').first().waitFor(); }
async function reload(p,mode){
  await p.reload();await p.addScriptTag({content:script});
  if(mode==='Driven')await p.evaluate(()=>window.showDriven());
  await p.locator('textarea').waitFor();
  await p.waitForFunction(()=>!document.querySelector('.attach-status'));
}
for(const mode of ['Native','Driven']){
  test(`${mode} draft images survive reload, removals and failed sends; successful sends clear them`,async t=>{
    const p=await pageFor(t);if(mode==='Driven')await p.evaluate(()=>window.showDriven());
    await paste(p,9);
    await p.waitForFunction(()=>document.querySelector('textarea').value.includes('[Image #9]'));
    const sources=await p.locator('.attach-preview img').evaluateAll(images=>images.map(image=>image.src));
    await reload(p,mode);
    await p.waitForFunction(()=>document.querySelectorAll('.attach-preview').length===9);
    assert.deepEqual(await p.locator('.attach-preview img').evaluateAll(images=>images.map(image=>image.src)),sources);
    assert.match(await p.locator('textarea').inputValue(),/Image #9/);
    await p.getByRole('button',{name:'remove Image #2',exact:true}).click();
    await p.waitForFunction(()=>document.querySelectorAll('.attach-preview').length===8);
    await reload(p,mode);
    await p.waitForFunction(()=>document.querySelectorAll('.attach-preview').length===8);
    assert.doesNotMatch(await p.locator('textarea').inputValue(),/Image #9/);
    await p.evaluate(()=>window.fail=true);
    await p.getByRole('button',{name:'send',exact:true}).click();
    await p.getByRole('alert').waitFor();
    await reload(p,mode);
    await p.waitForFunction(()=>document.querySelectorAll('.attach-preview').length===8);
    await p.getByRole('button',{name:'send',exact:true}).click();
    await p.waitForFunction(()=>window.calls.length===1&&!document.querySelector('.attach-preview'));
    await reload(p,mode);
    assert.equal(await p.locator('.attach-preview').count(),0);
    assert.equal(await p.locator('textarea').inputValue(),'');
  });
  test(`${mode} draft images stay with their machine and chat`,async t=>{
    const p=await pageFor(t);if(mode==='Driven')await p.evaluate(()=>window.showDriven());
    await paste(p);
    await p.waitForFunction(()=>document.querySelector('textarea').value.includes('[Image #1]'));
    for(const [env,id] of [['other-machine',mode==='Driven'?'driven-image-test':'native-image-test'],['laptop','other-chat']]){
      await p.evaluate(({mode,env,id})=>window[`show${mode}`](env,id),{mode,env,id});
      await p.waitForFunction(()=>!document.querySelector('.attach-preview')&&!document.querySelector('.attach-status'));
      assert.equal(await p.locator('textarea').inputValue(),'');
    }
    await p.evaluate(mode=>window[`show${mode}`](),mode);
    await p.waitForFunction(()=>document.querySelectorAll('.attach-preview').length===1);
  });
  test(`${mode} reload during an unconfirmed send keeps the image draft`,async t=>{
    const p=await pageFor(t);if(mode==='Driven')await p.evaluate(()=>window.showDriven());
    await paste(p);await p.evaluate(()=>window.hold=true);
    await p.getByRole('button',{name:'send',exact:true}).click();
    await p.waitForFunction(()=>window.calls.length===1);
    await reload(p,mode);
    await p.waitForFunction(()=>document.querySelectorAll('.attach-preview').length===1);
    assert.match(await p.locator('textarea').inputValue(),/Image #1/);
  });
}
test('native image batches and later additions send all images beyond the old caps',async t=>{
  const p=await pageFor(t);await paste(p,9);
  await p.waitForFunction(()=>document.querySelectorAll('.attach-preview').length===9);
  await paste(p,2);
  await p.waitForFunction(()=>document.querySelectorAll('.attach-preview').length===11);
  await p.getByRole('button',{name:'send',exact:true}).click();
  await p.waitForFunction(()=>window.calls.length===1);
  assert.equal(await p.evaluate(()=>window.calls[0].params.attachments.length),11);
});
for(const mode of ['Driven','Queue'])test(`${mode} messages keep more than four images across additions`,async t=>{
  const p=await pageFor(t);await p.evaluate(mode=>window[`show${mode}`](),mode);
  await paste(p,9);
  await p.waitForFunction(()=>document.querySelectorAll('.attach-preview').length===9);
  await paste(p,2);
  await p.waitForFunction(()=>document.querySelectorAll('.attach-preview').length===11);
  await p.getByRole('button',{name:mode==='Queue'?'Save':'send',exact:true}).click();
  await p.waitForFunction(mode=>mode==='Queue'?!!window.saved:window.calls.length===1,mode);
  assert.equal(await p.evaluate(mode=>mode==='Queue'?window.saved.attachments.length:window.calls[0].params.attachments.length,mode),11);
});
test('native Claude paste prepares a preview and sends image bytes to the thread host',async t=>{
  const p=await pageFor(t);await paste(p);
  await p.getByRole('button',{name:'send',exact:true}).click();
  await p.waitForFunction(()=>window.calls.length===1);
  const call=await p.evaluate(()=>window.calls[0]);assert.equal(call.env,'laptop');
  assert.equal(call.params.attachments.length,1);assert.equal(call.params.attachments[0].mime,'image/jpeg');
  assert.ok(Buffer.from(call.params.attachments[0].data,'base64').length>100);
  await p.waitForFunction(()=>!document.querySelector('.attach-preview'));
});
test('failed native image sends preserve the preview and draft for retry',async t=>{
  const p=await pageFor(t);await paste(p);await p.evaluate(()=>window.fail=true);
  await p.getByRole('button',{name:'send',exact:true}).click();await p.getByRole('alert').waitFor();
  assert.match(await p.getByRole('alert').innerText(),/upload failed/);
  assert.equal(await p.locator('.attach-preview').count(),1);assert.match(await p.locator('textarea').inputValue(),/Image #1/);
});
test('clipboard file items work when the clipboard file list is empty, without duplicating normal files',async t=>{
  const p=await pageFor(t);const counts=await p.evaluate(()=>{
    const file=new File(['x'],'s.png',{type:'image/png'});const items=[{kind:'file',getAsFile:()=>file}];
    return [window.clipboardImages({files:[],items}).length,window.clipboardImages({files:[file],items}).length];
  });assert.deepEqual(counts,[1,1]);
});
