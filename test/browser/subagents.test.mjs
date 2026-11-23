import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { join } from 'node:path';

let browser, page;
const isFocused = locator => locator.evaluate(element => element === document.activeElement);
const capture = (target, name) => process.env.HELM_TEST_SCREENSHOT_DIR && target.screenshot({path:join(process.env.HELM_TEST_SCREENSHOT_DIR,name)});
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Subagents } from './apps/web/src/session/Subagents';
    const root = createRoot(document.getElementById('root'));
    const listeners = new Set();
    const parent = { id:'parent', title:'Security review', cwd:'/project', engine:'codex', profileId:'codex-main', status:'working' };
    const child = { id:'child', title:'Review the vulnerability', cwd:'/project', engine:'claude', profileId:'claude-main', model:'opus', status:'blocked',
      delegation:{ parentId:'parent', task:'Review the vulnerability', requestedModel:'opus', depth:1, status:'blocked' } };
    const unrelated = { ...child, id:'unrelated', title:'Other thread task', delegation:{...child.delegation,parentId:'other-parent'} };
    const archived = { ...child, id:'archived', title:'Archived task', archived:true };
    const agents = [
      { id:'codex-main', label:'Codex personal', engine:'codex', auth:'authenticated', available:true, models:['gpt-6-astra'], modes:[{id:'ask',label:'Ask before acting'}] },
      { id:'claude-main', label:'Claude personal', engine:'claude', auth:'authenticated', available:true, defaultModel:'sonnet', defaultMode:'bypassPermissions', models:['opus','sonnet'], modes:[{id:'default',label:'Ask before acting'},{id:'bypassPermissions',label:'Bypass all checks'},{id:'plan',label:'Plan first'}] },
      { id:'claude-out', label:'Claude work', engine:'claude', auth:'unauthenticated', available:false, modes:[] },
    ];
    const client = {pendingActions:()=>[],resumeActions:async()=>[],input:(env,params)=>client.rpc(env,'session.input',params),
      on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      rpc: async (env, method, params) => {
        (window.calls ??= []).push({env,method,params});
        if(method === 'agent.list') return { agents };
        if(method === 'session.list') return { sessions: [...(window.includeChild ? [parent,child] : [parent]), unrelated, archived] };
        if(method === 'session.delegate') {
          const session = window.nextChild ?? child;
          window.includeChild = true;
          for(const fn of listeners) fn('local','session.update',{session});
          return { session };
        }
        if(method === 'session.delegation-result' && window.results?.[params.id]) return window.results[params.id];
        if(method === 'session.delegation-result') return window.childDone
          ? { session:child,status:'done',complete:true,output:'Review finished.' }
          : { session:child,status:'blocked',complete:false,output:'I need to inspect the changed files.',pending:{kind:'command',title:'Read the diff',requestId:'permission'} };
        if(method === 'session.events') return { events:[], pending:[{requestId:'permission',kind:'command',title:'Read the diff',detail:'git diff',options:[{id:'allow',role:'allow',label:'Allow'},{id:'deny',role:'deny',label:'Deny'}],defaultTo:'deny'}] };
        return { ok:true };
      }
    };
    window.sendSessionUpdate = (env, session) => listeners.forEach(fn=>fn(env,'session.update',{session}));
    window.unrelatedChild = unrelated;
    window.child = child;
    window.showSubagents = () => root.render(<Subagents client={client} env={{id:'local',name:'Laptop',online:true,info:{agentMessages:true}}} parent={parent}
      onClose={()=>root.render(null)} onOpen={(s)=>{window.opened=s.id}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  page = await browser.newPage();
  await page.setContent('<button id="launcher">Subagents</button><div id="root"></div>');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});
after(async () => { await browser?.close(); });


test('subagents fit a phone, open only the selected task, trap focus, stop a task and restore the launcher', async () => {
  await page.setViewportSize({width:390,height:844});
  // The parent already has one helper task, waiting on an approval.
  await page.evaluate(()=>{ window.includeChild = true; });
  await page.locator('#launcher').focus();
  await page.evaluate(()=>window.showSubagents());
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
  const newTask = page.getByRole('button',{name:'New task'});
  await newTask.waitFor();
  assert.equal(await page.getByLabel('Task', {exact:true}).count(), 0, 'with tasks listed the launch form stays folded');
  assert.ok((await newTask.boundingBox()).height >= 44);
  await capture(page, 'subagents-phone-list-collapsed.png');
  await newTask.click();
  assert.equal(await isFocused(page.getByLabel('Task', {exact:true})), true);
  await capture(page, 'subagents-phone-launch-collapsed.png');
  await page.getByRole('button', {name:/^Agent account:/}).click();
  await page.getByRole('listbox', {name:/^Agent account on/}).waitFor();
  await capture(page, 'subagents-phone-launch-expanded.png');
  await page.getByRole('button',{name:'Cancel'}).click();
  assert.equal(await isFocused(page.getByRole('button',{name:'New task'})), true);
  const toggle = page.getByRole('button',{name:'Needs approval, details'});
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.delegation-detail').count(), 0, 'rows stay compact until selected');
  assert.ok((await toggle.boundingBox()).height >= 44);
  assert.ok((await page.locator('.delegation-task').boundingBox()).height >= 44);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.getByText('Read the diff', {exact:true}).waitFor();
  await page.getByRole('button',{name:'Stop helper'}).click();
  await page.getByRole('status').filter({hasText:'Helm sent the stop request.'}).waitFor();
  assert.ok(await page.evaluate(()=>window.calls.some((c)=>c.method==='session.interrupt'&&c.params.id==='child')));
  assert.ok(await page.locator('.delegation-body').evaluate(body => body.scrollWidth <= body.clientWidth), 'nothing scrolls sideways on a phone');
  await capture(page, 'subagents-phone.png');
  for(let i=0;i<15;i++) {
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate((el)=>el.contains(document.activeElement)),true);
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.equal(await page.locator('#launcher').evaluate((el)=>el===document.activeElement),true);
});

test('a failed task moves to Failed, says why first, and retries with the same account, model, effort and task', async () => {
  await page.evaluate(() => window.showSubagents());
  await page.getByRole('button',{name:'Needs approval, details'}).waitFor();
  await page.evaluate(() => {
    window.results = { child:{ session:window.child, status:'error', complete:true, output:'', error:'CLI crashed' } };
    window.sendSessionUpdate('local', {...window.child, effort:'high', status:'error', delegation:{...window.child.delegation, status:'error'}});
  });
  await page.locator('.delegation-group.group-failed .delegation-branch').waitFor();
  assert.equal(await page.locator('.delegation-group:is(.group-needs, .group-working)').count(), 0);
  await page.getByRole('button',{name:'Failed, details'}).click();
  await page.locator('.delegation-failure').getByText('CLI crashed', {exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Stop helper'}).count(), 0);
  const before = await page.evaluate(() => window.calls.filter((call)=>call.method==='session.delegate').length);
  await page.evaluate(() => {
    window.nextChild = {...window.child, id:'retry', status:'starting', delegation:{...window.child.delegation, status:'starting'}};
    window.results.retry = { session:window.nextChild, status:'working', complete:false, output:'' };
  });
  await page.getByRole('button',{name:'Retry task'}).click();
  await page.locator('.delegation-group.group-working .delegation-branch.selected').waitFor();
  const retried = await page.evaluate(() => JSON.parse(JSON.stringify(window.calls.filter((call)=>call.method==='session.delegate'))));
  assert.equal(retried.length, before + 1);
  assert.deepEqual(retried.at(-1).params, {id:'parent',profileId:'claude-main',model:'opus',effort:'high',task:'Review the vulnerability'});
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.task), 'retry');
  await page.getByText('The agent has not replied yet.', {exact:true}).waitFor();
  await page.getByRole('button',{name:'Stop helper'}).waitFor();
  assert.equal(await page.locator('.delegation-detail').count(), 1, 'only the selected task is expanded');
  await page.evaluate(() => window.sendSessionUpdate('local', {...window.nextChild, status:'working', delegation:{...window.nextChild.delegation,status:'working'}}));
  const workingToggle = page.getByRole('button', {name:'Working, details'});
  await workingToggle.waitFor();
  assert.ok((await workingToggle.boundingBox()).height >= 44, 'working tasks retain a full touch target');
  await page.evaluate(() => { window.nextChild = undefined; window.results = undefined; });
  await page.getByRole('button', { name:'Close helpers' }).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
});

test('Shell back history leaves parent and child chats without cycling between them', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Shell } from './apps/web/src/App';
    const env = {id:'history-test',name:'Laptop',online:true,info:{}};
    const parent = {id:'parent',title:'Parent history chat',cwd:'/project',engine:'codex',profileId:'codex',
      driver:'codex',status:'idle',turns:1,hasInput:true,updatedAt:Date.now()};
    const child = {...parent,id:'child',title:'Child history chat',delegation:{parentId:'parent',task:'Child task',status:'done'}};
    const grandchild = {...child,id:'grandchild',title:'Grandchild history chat',delegation:{parentId:'child',task:'Nested task',status:'done'}};
    const sessions = [parent,child,grandchild];
    const client = {pendingActions:()=>[],resumeActions:async()=>[],input:(env,params)=>client.rpc(env,'session.input',params),relay:'http://helm-history-test',subscribe:()=>{},on:()=>()=>{},watchLatency:()=>()=>{},
      openDirect:async()=>{},route:async()=>null,environments:async()=>({environments:[env]}),
      rpc:async(env,method,p={})=>{
        if(method==='session.list') return {sessions:p.parentId?sessions.filter(s=>s.delegation?.parentId===p.parentId):[parent]};
        if(method==='model.list') return {models:[],modes:[]};
        if(method==='agent.list') return {agents:[]};
        if(method==='session.events') return {session:sessions.find(s=>s.id===p.id),events:[],pending:[],last:0};
        return {};
      }};
    createRoot(document.getElementById('root')).render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}} />);
  `, resolveDir:process.cwd(),loader:'tsx' }, plugins:[{name:'export-shell',setup(b){
    b.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:await readFile(path,'utf8')+'\nexport { Shell };',loader:'tsx'}));
  }}],bundle:true,write:false,format:'iife',jsx:'automatic'});
  for (const width of [1280,390]) {
    const view = await browser.newPage({viewport:{width,height:844}});
    view.setDefaultTimeout(10_000);
    try {
      await view.route('http://helm-history-test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
      await view.goto('http://helm-history-test/#open=history-test/parent');
      await view.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
      await view.addScriptTag({content:bundle.outputFiles[0].text});
      const heading = title=>view.locator('.session-bar h1').filter({hasText:new RegExp('^'+title+'$')});
      await heading('Parent history chat').waitFor();
      const openChild = async title=>{
        await view.locator('.session-bar').getByRole('button',{name:'Agents',exact:true}).click();
        await view.getByRole('dialog',{name:'Agents',exact:true}).waitFor();
        const task = view.getByRole('button',{name:new RegExp(title)});
        const expands = await task.getAttribute('aria-expanded') !== null;
        await task.click();
        if (expands) {
          await task.locator('..').getByRole('button',{name:'Done, details',exact:true}).click();
          await view.getByRole('button',{name:'Open chat',exact:true}).click();
        }
        await heading(title).waitFor();
      };
      const parentDepth = await view.evaluate(()=>history.state.depth);
      await openChild('Child history chat');
      await openChild('Grandchild history chat');
      await view.getByRole('button',{name:'Back to main chat',exact:true}).click();
      await heading('Child history chat').waitFor();
      await view.getByRole('button',{name:'Back to main chat',exact:true}).click();
      await heading('Parent history chat').waitFor();
      assert.equal(await view.evaluate(()=>history.state.depth),parentDepth,'returning pops history instead of appending the parent');
      await openChild('Child history chat');
      await view.goBack();
      await heading('Parent history chat').waitFor();
      await view.getByRole('button',{name:'Back',exact:true}).click();
      await view.locator('.session-bar').waitFor({state:'detached'});
      assert.equal(await view.evaluate(()=>history.state.depth),parentDepth-1);
    } finally { await view.close(); }
  }
});
