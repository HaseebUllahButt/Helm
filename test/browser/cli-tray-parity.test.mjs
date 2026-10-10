import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script, css;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {DrivenSession} from './apps/web/src/session/DrivenSession';
    import {MODES} from './packages/connect/src/modes.js';
    window.calls=[];
    const engine=window.engine;
    const options={models:['model-a','model-b'],labels:{'model-a':'Model A','model-b':'Model B'},default:'model-a',
      efforts:['low','high'],modes:MODES[engine] || [],favs:[],effortFavs:[],prefs:{default:'model-a',approved:[]},
      defaults:{effort:'low'},...(engine==='codex' ? {speeds:['fast']} : {})};
    const client={on:()=>()=>{},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
      if(method==='model.list') return options;
      if(method==='session.events') return {session:window.current,events:[],pending:[],last:0};
      if(method==='session.watch') return {last:0};
      if(method==='session.list') return {sessions:[]};
      if(method==='session.commands') return {commands:[]};
      if(method==='usage.limits') return {accounts:[]};
      if(method==='git.status') return {repo:false};
      if(method==='agent.list') return {agents:[]};
      if(['session.model','session.effort','session.mode','session.speed'].includes(method)){
        window.calls.push({method,params});
        const kind=method.split('.')[1];return {session:{...window.current,[kind]:params[kind]}};
      }
      if(method==='picker.prefs'){window.calls.push({method,params});return {ok:true};}
      if(method==='model.prefs'){window.calls.push({method,params});return {prefs:{default:params.default,approved:params.approved}};}
      if(method==='profile.defaults'){window.calls.push({method,params});return {defaults:params};}
      throw Error('Missing fixture for '+method);
    }};
    function Chat(){
      const [session,setSession]=useState({id:'tray-'+engine,engine,driver:engine,nativeCodex:window.nativeCodex,
        profileId:engine+'-account',model:'model-a',effort:'low',mode:options.modes[0]?.id,
        title:'CLI tray',status:'idle',cwd:'/project'});
      window.current=session;
      return <DrivenSession client={client} env={{id:'laptop',name:'Laptop',online:true}} session={session}
        onSession={setSession} onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}}/>;
    }
    createRoot(document.getElementById('root')).render(<Chat/>);
  `, resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic'});
  script=bundle.outputFiles[0].text;
  css=(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'');
  browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
});
after(async()=>browser?.close());

for(const engine of ['claude','codex','opencode','opencode2','devin','grok','cursor','pi','omp','rovo','agy','antigravity']){
  test(`${engine} chat uses shared model, thinking and permission tray with account preferences`,async t=>{
    const page=await browser.newPage({viewport:{width:390,height:844}});t.after(()=>page.close());page.setDefaultTimeout(6000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://helm.test/**',r=>r.fulfill({contentType:'text/html',body:'<div class="session" id="root"></div>'}));
    await page.goto('http://helm.test/');await page.addStyleTag({content:css});
    await page.evaluate(engine=>{window.engine=engine;window.nativeCodex=engine==='codex'},engine);
    await page.addScriptTag({content:script});
    await page.locator('button[title^="model:"]').click();
    await page.getByRole('checkbox',{name:'Favorite Model B',exact:true}).check();
    await page.getByRole('button',{name:'Use Model B by default for new chats',exact:true}).click();
    await page.getByRole('button',{name:'Model B is the default for new chats',exact:true}).waitFor();
    assert.equal(await page.getByRole('option',{name:'Model A',exact:true}).getAttribute('aria-selected'),'true');
    await page.getByRole('option',{name:'Model B',exact:true}).click();
    await page.waitForFunction(()=>window.current.model==='model-b');
    await page.getByRole('button',{name:'thinking: low',exact:true}).click();
    await page.getByRole('checkbox',{name:'Favorite high',exact:true}).check();
    await page.getByRole('button',{name:'Use high by default for new chats',exact:true}).click();
    await page.getByRole('button',{name:'high is the default for new chats',exact:true}).waitFor();
    await page.getByRole('option',{name:'high',exact:true}).click();
    await page.waitForFunction(()=>window.current.effort==='high');
    const modes=await page.evaluate(()=>window.current.mode);
    if(modes){
      await page.locator('button[title^="permissions:"]').click();
      const choice=page.getByRole('option').nth(1);
      await choice.click();
      // Dangerous selections retain the shared two-tap confirmation.
      if(await choice.count())await choice.click();
      await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.mode'));
    } else assert.equal(await page.locator('button[title^="permissions:"]').count(),0);
    if(engine==='codex'){
      await page.getByRole('button',{name:'speed: normal',exact:true}).click();
      await page.getByRole('option',{name:/^Fast/}).click();
      await page.getByRole('button',{name:'speed: Fast',exact:true}).waitFor();
    }
    const calls=await page.evaluate(()=>window.calls);
    for(const call of calls.filter(c=>['model.prefs','profile.defaults'].includes(c.method)))assert.equal(call.params.profileId,engine+'-account');
    assert.deepEqual(calls.find(c=>c.method==='picker.prefs').params.favs,{[engine]:['model-b']});
    assert.deepEqual(calls.filter(c=>c.method==='picker.prefs')[1].params.favs,{[engine+'-effort']:[JSON.stringify(['model-b','high'])]});
    assert.equal(await page.locator('textarea').count(),1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
  });
}
