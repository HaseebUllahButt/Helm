import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
let browser, script, css;
before(async () => {
  const result = await build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {SessionView} from './apps/web/src/session/SessionView';
    window.calls=[]; const listeners=new Set();
    window.messages=Array.from({length:200},(_,i)=>({sourceId:'m'+i,at:new Date(1700000000000+i*1000).toISOString(),
      role:i%2?'assistant':'user',text:'Message '+i+'. '+ 'Some readable words. '.repeat(20),tools:[]}));
    const client={pendingActions:()=>[],resumeActions:async()=>[],on:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},subscribe(){},
      rpc:async(env,method,params={})=>{
        window.calls.push({method,params});
        if(method==='session.messages') {
          const messages=window.messages.slice(-params.limit);
          if(window.visual) messages.splice(params.limit>=200?10:0,0,{role:'assistant',text:'',tools:[],visual:{ref:'old',title:'Old picture',height:10,bytes:0}});
          return {messages,hasMore:window.messages.length>params.limit,status:'idle'};
        }
        if(method==='model.list')return {models:[],modes:[],nativeControls:[],favs:[],prefs:{approved:[]}};
        if(method==='usage.limits')return {accounts:[]};
        if(method==='session.commands')return {commands:[]};
        if(method==='session.events')return {events:[],last:0,pending:[]};
        if(method==='session.pending')return {pending:[]};
        return {ok:true};
      }};
    window.append=()=>{
      window.messages.push({sourceId:'m200',at:'2026-11-04',role:'assistant',text:'New reply',tools:[]});
      listeners.forEach(fn=>fn('machine','session.transcript',{id:'native'}));
    };
    createRoot(document.getElementById('root')).render(<SessionView client={client} env={{id:'machine',name:'Machine',online:true}}
      session={{id:'native',engine:'claude',profileId:'native',nativeCli:true,nativeChat:true,pty:true,status:'idle',cwd:'/work',title:'Native'}}
      onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} />);
  `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = result.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(() => browser?.close());
async function open(t, visual = false) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  t.after(() => page.close());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('http://native.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root" style="height:100vh;display:flex;flex-direction:column;min-height:0"></div>' }));
  await page.goto('http://native.test/');
  await page.evaluate(value => window.visual = value, visual);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => document.querySelectorAll('.timeline-row').length >= 40);
  return page;
}

test('native history loads on request, keeps older messages through live refresh and preserves the reading position', async t => {
  const page = await open(t, true);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.method === 'session.messages').length), 1);
  while (await page.locator('.timeline-row').count() < 201) {
    const before = await page.locator('.timeline-row').count();
    await page.getByRole('button', { name: 'Earlier in this chat', exact: true }).click();
    await page.waitForFunction(n => document.querySelectorAll('.timeline-row').length > n, before);
  }
  await page.locator('.chat').evaluate(el => el.scrollTop = el.scrollHeight / 2);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const top = await page.locator('.chat').evaluate(el => el.scrollTop);
  await page.evaluate(() => window.append());
  await page.waitForFunction(() => document.querySelectorAll('.timeline-row').length === 202);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.method === 'session.messages').at(-1).params.limit), 40);
  assert.ok(Math.abs(await page.locator('.chat').evaluate(el => el.scrollTop) - top) < 2);
  assert.equal(await page.getByRole('button', { name: 'Earlier in this chat', exact: true }).count(), 0);
  assert.ok(await page.locator('.turn').count() < 45);
});
