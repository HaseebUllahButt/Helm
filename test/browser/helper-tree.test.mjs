import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('remote leads stay visible, refresh, and keep their own helpers below them', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {Subagents} from './apps/web/src/session/Subagents';
    const root = createRoot(document.getElementById('root'));
    const listeners = new Set();
    const lead = (id,status,working=0) => ({id,title:id,engine:'codex',profileId:'same-account',status:'idle',
      team:{working,blocked:0,failed:0},delegation:{parentId:'parent',parentMachine:'local',status,task:'',depth:1}});
    let rows = [lead('finished','done'),lead('waiting','done',1),lead('working','working')];
    const nested = {id:'nested',title:'Nested helper',engine:'pi',status:'working',delegation:{parentId:'waiting',status:'working',depth:2}};
    let parent = {id:'parent',engine:'codex',status:'working',remoteHelpers:rows.map(s=>({id:s.id,machine:'away',status:s.delegation.status})).concat([{id:'removed',machine:'away',title:'Removed helper',status:'working'},{id:'offline',machine:'offline',title:'Offline helper',status:'working'}])};
    const client = {subscribe:id=>(window.subscribed??=[]).push(id),on:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
      rpc:async(machine,method)=>{
        if(machine==='offline') throw new Error('offline');
        if(method==='session.list') return {sessions:machine==='away'?[...rows,nested]:[]};
        if(method==='agent.list') return {agents:[]};
        return {};
      }};
    const render=()=>root.render(<Subagents client={client} env={{id:'local',name:'Here',online:true}} parent={parent} onClose={()=>{}} />);
    window.finish=()=>{rows=rows.map(s=>s.id==='working'?lead(s.id,'done'):s); listeners.forEach(fn=>fn('away','session.update',{session:rows[2]}));};
    window.addLead=()=>{rows.push(lead('new-lead','working'));parent={...parent,remoteHelpers:rows.map(s=>({id:s.id,machine:'away',status:s.delegation.status}))};render();};
    render();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('button', {name:'Waiting for its helpers, details', exact:true}).waitFor();
    await page.getByRole('button',{name:'Stopped, details',exact:true}).waitFor();
    assert.equal(await page.getByText('another machine is offline',{exact:true}).count(), 1);
    assert.ok((await page.evaluate(()=>window.subscribed)).includes('away'));
    const waiting = page.locator('li').filter({has:page.getByRole('button',{name:'Waiting for its helpers, details',exact:true})}).first();
    assert.equal(await waiting.locator('summary').count(), 0, 'no separate helper header');
    await waiting.getByRole('button').filter({hasText:'1 helper'}).click();
    await page.getByText('Nested helper',{exact:true}).waitFor({state:'visible'});
    await page.evaluate(()=>window.finish());
    await page.waitForFunction(()=>document.querySelectorAll('[aria-label="Done, details"]').length===2);
    await page.evaluate(()=>window.addLead());
    await page.getByText('new-lead',{exact:true}).waitFor();
  } finally { await browser.close(); }
});
