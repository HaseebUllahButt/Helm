import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

test('agent exchanges show both sides, reply links and earlier history on phone and desktop',async()=>{
  const bundle=await build({stdin:{contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {AgentMessages} from './apps/web/src/session/AgentMessages';
    const listeners=new Set();
    const from={env:'local',id:'reviewer',title:'Review tests',engine:'claude'};
    const to={env:'local',id:'coder',title:'Fix login',engine:'codex'};
    const question={id:'question',from,to,text:'Does the login test pass?',at:1000,status:'delivered'};
    const reply={id:'reply',from:to,to:from,text:'Yes, 14 tests passed.',replyTo:'question',at:2000,status:'delivered'};
    const client={on:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},rpc:async(env,method,p)=>{
      (window.calls??=[]).push({env,method,p});
      return p.before?{messages:[question],next:null}:{messages:[reply],next:'older'};
    }};
    window.update=()=>listeners.forEach(fn=>fn('local','agent.message',{sessionIds:['coder']}));
    createRoot(document.getElementById('root')).render(<AgentMessages client={client} envId="local" parent={{id:'parent'}} children={[{id:'coder'},{id:'reviewer'}]}/>);
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic'});
  const browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
  try {
    for(const width of [390,1280]) {
      const page=await browser.newPage({viewport:{width,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
      await page.addScriptTag({content:bundle.outputFiles[0].text});
      await page.getByRole('button',{name:'Messages between agents'}).click();
      await page.getByText('Yes, 14 tests passed.').waitFor();
      assert.match(await page.locator('body').innerText(),/Fix login \(codex\) → Review tests \(claude\)/);
      await page.getByRole('button',{name:'Earlier messages'}).click();
      await page.locator('.agent-exchange-list > li').filter({hasText:'Review tests (claude) → Fix login (codex)'}).waitFor();
      await page.getByText('In reply to',{exact:true}).click();
      assert.equal(await page.getByText('Does the login test pass?',{exact:true}).count(),2);
      await page.evaluate(()=>window.update());
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.deepEqual(errors,[]);
      await page.close();
    }
  }finally{await browser.close();}
});
