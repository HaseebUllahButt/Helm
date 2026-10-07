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
      import { clipboardImages } from './apps/web/src/session/image';
      window.clipboardImages = clipboardImages;
      window.calls=[]; window.fail=false;
      const client={on:()=>()=>{},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
        if(method==='session.messages')return {messages:[],status:'idle'};
        if(method==='session.pending')return {pending:[]};
        if(method==='session.input'){ window.calls.push({env,method,params}); if(window.fail)throw Error('upload failed'); }
        return {ok:true,pending:[]};
      }};
      const root=createRoot(document.getElementById('root'));
      root.render(<SessionView client={client} env={{id:'laptop',name:'Laptop',online:true}}
        session={{id:'native-image-test',engine:'claude',nativeChat:true,nativeCli:true,pty:true,status:'idle',cwd:'/project',title:'Native Claude'}}
        onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} />);
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
  await p.goto('http://helm.test/');await p.addScriptTag({content:script});await p.locator('textarea').waitFor();return p;
}
async function paste(p){ await p.evaluate(async()=>{
  const c=document.createElement('canvas');c.width=32;c.height=24;c.getContext('2d').fillRect(0,0,32,24);
  const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
  const dt=new DataTransfer();dt.items.add(new File([blob],'screen.png',{type:'image/png'}));
  document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));
});await p.locator('.attach-preview img').waitFor(); }
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
