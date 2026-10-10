import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, bundle, styles;
before(async () => {
  bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {DrivenSession} from './apps/web/src/session/DrivenSession';
    const env={id:'team-test',name:'Laptop',online:true,info:{}};
    const parent={id:'parent',title:'Parent chat',cwd:'/project',engine:'claude',profileId:'claude',driver:'claude',status:'idle',team:{working:1,blocked:0,failed:0}};
    const worker={...parent,id:'worker',title:'Working helper',team:undefined,delegation:{parentId:'parent',status:'working'}};
    const child={...parent,id:'child',title:'Choose the cache',team:undefined,status:'blocked',ask:{kind:'question',text:'Which cache?',requestId:'delegated-question'},delegation:{parentId:'worker',status:'blocked'}};
    const permission=(id,parentId,question=false)=>({requestId:id,parentId,kind:question?'question':'command',title:question?'Which cache?':'Approve unrelated command',detail:'pwd',defaultTo:'deny',
      questions:question?[{id:'cache',question:'Which cache?',options:[{label:'Use disk cache'},{label:'Scan again'}]}]:undefined,
      options:question?[]:[{id:'allow',role:'allow',label:'Allow'},{id:'deny',role:'deny',label:'Deny'}]});
    const native=permission('native-question','spawn-card',true);
    const unrelated=permission('unrelated',undefined);
    const client={on:()=>()=>{},subscribe:()=>{},rpc:async(env,method,params)=>{
      (window.calls??=[]).push({method,params});
      if(method==='session.list')return {sessions:[parent,worker,child]};
      if(method==='model.list')return {models:[],modes:[]};
      if(method==='session.watch')return {last:0};
      if(method==='session.events') {
        const isParent=params.id==='parent';
        const events=isParent?[
          {seq:1,at:1,type:'turn.start',turnId:'turn',text:'Review the project'},
          {seq:2,at:2,type:'item.start',id:'spawn-card',kind:'subagent',turnId:'turn',name:'Explore',agent:{status:'running'}},
          {seq:3,at:3,type:'turn.done',turnId:'turn',status:'ok'}
        ]:[];
        return {session:isParent?parent:child,events:params.since?[]:events,pending:window.answered?[]:isParent?[unrelated,native]:[unrelated,permission('delegated-question',undefined,true)],last:isParent?3:0};
      }
      if(method==='session.answer')window.answered=true;
      return {ok:true};
    }};
    function Chat(){const [session,setSession]=useState(parent);return <DrivenSession client={client} env={env} session={session} onSession={setSession}
      onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onOpenSession={s=>{window.opened=s.id;setSession(s)}}/>;}
    createRoot(document.getElementById('root')).render(<Chat/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  styles=(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'');
  browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());
async function pageFor(t,width=390){
  const page=await browser.newPage({viewport:{width,height:844}});t.after(()=>page.close());
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => t.diagnostic(error.stack));
  await page.route('http://helm-team-test/**',route=>route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><div class="session" id="root"></div>'}));
  await page.goto('http://helm-team-test/');await page.addStyleTag({content:styles});await page.addScriptTag({content:bundle.outputFiles[0].text});return page;
}
test('an idle parent stays working while a helper runs, and a nested question opens its exact conversation',async t=>{
  const page=await pageFor(t);
  await page.locator('.session-bar .chip.working').waitFor();
  const link=page.getByRole('group',{name:'Subagents waiting for you'}).getByRole('button',{name:/Choose the cache/});
  await link.click();
  await page.locator('.sheet.question').waitFor();
  assert.equal(await page.evaluate(()=>window.opened),'child');
  await page.getByRole('radio',{name:/Use disk cache/}).click();
  await page.waitForFunction(()=>window.calls.some(call=>call.method==='session.answer'));
  const answer=await page.evaluate(()=>window.calls.find(call=>call.method==='session.answer'));
  assert.equal(answer.params.id,'child');assert.equal(answer.params.requestId,'delegated-question');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});
test('clicking a native subagent question selects that request instead of the first unrelated approval',async t=>{
  const page=await pageFor(t,1280);
  await page.locator('.sheet.command').waitFor();
  await page.locator('.subagent-request').click();
  await page.locator('.sheet.question').waitFor();
  await page.getByRole('radio',{name:/Use disk cache/}).click();
  await page.waitForFunction(()=>window.calls.some(call=>call.method==='session.answer'));
  const answer=await page.evaluate(()=>window.calls.find(call=>call.method==='session.answer'));
  assert.equal(answer.params.id,'parent');assert.equal(answer.params.requestId,'native-question');
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.method==='session.answer').length),1);
});
