import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { join } from 'node:path';

let browser, page;
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
    const client = {
      on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      rpc: async (env, method, params) => {
        (window.calls ??= []).push({env,method,params});
        if(method === 'agent.list') return { agents };
        if(method === 'session.list') return { sessions: [...(window.includeChild ? [parent,child] : [parent]), unrelated, archived] };
        if(method === 'session.delegate') {
          window.includeChild = true;
          for(const fn of listeners) fn('local','session.update',{session:child});
          return { session:child };
        }
        if(method === 'session.delegation-result') return window.childDone
          ? { session:child,status:'done',complete:true,output:'Review finished.' }
          : { session:child,status:'blocked',complete:false,output:'I need to inspect the changed files.',pending:{kind:'command',title:'Read the diff',requestId:'permission'} };
        if(method === 'session.events') return { events:[], pending:[{requestId:'permission',kind:'command',title:'Read the diff',detail:'git diff',options:[{id:'allow',role:'allow',label:'Allow'},{id:'deny',role:'deny',label:'Deny'}],defaultTo:'deny'}] };
        return { ok:true };
      }
    };
    window.sendSessionUpdate = (env, session) => listeners.forEach(fn=>fn(env,'session.update',{session}));
    window.unrelatedChild = unrelated;
    window.showSubagents = () => root.render(<Subagents client={client} env={{id:'local',name:'Laptop',online:true,info:{}}} parent={parent}
      onClose={()=>root.render(null)} onOpen={(s)=>{window.opened=s.id}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  page = await browser.newPage();
  await page.setContent('<button id="launcher">Subagents</button><div id="root"></div>');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});
after(async () => { await browser?.close(); });

test('main task click opens the full child conversation and Back returns to its parent', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    const env = { id:'navigation-test', name:'Laptop', online:true, info:{} };
    const parent = { id:'parent', title:'Parent chat', cwd:'/project', engine:'codex', profileId:'codex', status:'idle', driver:true };
    const child = { ...parent, id:'child', title:'Inspect child conversation',
      delegation:{parentId:parent.id, task:'Inspect the implementation', status:'done'} };
    const client = {
      on: () => () => {}, subscribe: () => {},
      rpc: async (env, method, params) => {
        (window.calls ??= []).push({env,method,params});
        if (method === 'model.list') return { models:[], modes:[] };
        if (method === 'agent.list') return { agents:[] };
        if (method === 'session.list') return { sessions:[child] };
        if (method === 'session.watch') return { last:5 };
        if (method === 'session.events') {
          if (params.id === 'parent' && params.limit === 1 && window.failParent) throw Error('Parent temporarily unavailable');
          const session = params.id === 'child' ? child : parent;
          const events = [
            {seq:1, at:1, type:'turn.start', turnId:'turn', text:session.id + ' original request'},
            {seq:2, at:2, type:'item.start', turnId:'turn', id:'reply', kind:'text'},
            {seq:3, at:3, type:'item.delta', id:'reply', text:session.id + ' full conversation response'},
            {seq:4, at:4, type:'item.end', id:'reply'},
            {seq:5, at:5, type:'turn.end', turnId:'turn', status:'ok'},
          ];
          return {session, events:events.filter(e=>e.seq>(params.since ?? 0)), pending:[], last:5, firstSeq:1, logFirst:1};
        }
        return {ok:true};
      },
    };
    function Chat() {
      const [session, setSession] = useState(parent);
      return <DrivenSession key={session.id} client={client} env={env} session={session}
        onBack={()=>{window.backToList = true}} onClosed={()=>{}} onArchived={()=>{}}
        onSession={setSession} onOpenSession={setSession} />;
    }
    createRoot(document.getElementById('root')).render(<Chat />);
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic' });
  for (const width of [1280, 390]) {
    const view = await browser.newPage({ viewport:{width,height:844} });
    view.setDefaultTimeout(10_000);
    try {
      await view.route('http://helm-subagent-test/**', r => r.fulfill({contentType:'text/html',body:'<div class="session" id="root"></div>'}));
      await view.goto('http://helm-subagent-test/');
      await view.addStyleTag({ content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'') });
      await view.addScriptTag({ content:bundle.outputFiles[0].text });
      await view.getByText('parent full conversation response', {exact:true}).waitFor();
      if (width === 390) await view.getByRole('button', {name:'more',exact:true}).click();
      await view.getByRole('button', {name:'Subagents',exact:true}).click();
      await view.getByRole('button', {name:/Inspect child conversation/}).click();
      await view.getByRole('heading', {name:'Inspect child conversation',exact:true}).waitFor();
      await view.getByRole('dialog', {name:'Subagents'}).waitFor({state:'detached'});
      await view.locator('.turn.user .bubble').filter({hasText:'child original request'}).waitFor();
      await view.getByText('child full conversation response', {exact:true}).waitFor();
      assert.equal(await view.getByText('parent full conversation response', {exact:true}).count(), 0);
      await view.getByPlaceholder('Message Codex…').fill('Continue the child task');
      await view.getByRole('button', {name:'send',exact:true}).click();
      await view.waitForFunction(() => window.calls.some(c=>c.method==='session.input'&&c.params.id==='child'));
      assert.equal(await view.evaluate(() => window.calls.some(c=>c.method==='session.delegation-result')), false);
      await view.evaluate(() => { window.failParent = true; });
      await view.getByRole('button', {name:'Back to parent thread',exact:true}).click();
      await view.getByRole('alert').filter({hasText:'Parent temporarily unavailable'}).waitFor();
      assert.equal(await view.getByRole('heading', {name:'Inspect child conversation',exact:true}).count(), 1);
      await view.evaluate(() => { window.failParent = false; });
      await view.getByRole('button', {name:'Back to parent thread',exact:true}).click();
      await view.getByRole('heading', {name:'Parent chat',exact:true}).waitFor();
      await view.getByText('parent full conversation response', {exact:true}).waitFor();
      assert.equal(await view.getByRole('dialog', {name:'Subagents'}).count(), 0);
      assert.equal(await view.evaluate(() => window.backToList), undefined);
      await view.getByRole('button', {name:'Back',exact:true}).click();
      assert.equal(await view.evaluate(() => window.backToList), true);
    } finally { await view.close(); }
  }
});

test('account and model choices create a linked child and expose its approval', async () => {
  await page.locator('#launcher').focus();
  await page.evaluate(() => window.showSubagents());
  await page.getByLabel('CLI account').selectOption('claude-main');
  assert.equal(await page.getByLabel('Subagent permissions').locator('option[value="plan"]').count(), 0);
  assert.equal(await page.getByLabel('Subagent permissions').locator('option[value="bypassPermissions"]').count(), 1);
  assert.equal(await page.locator('option[value="claude-out"]').isDisabled(), true);
  await page.getByLabel('Subagent model').fill('opus');
  await page.getByLabel('Task', {exact:true}).fill('Review the vulnerability');
  await page.getByRole('button', {name:'Start subagent'}).click();
  await page.getByText('Read the diff', {exact:true}).waitFor();
  assert.deepEqual(await page.locator('.sheet-actions button').allTextContents(), ['Deny', 'Allow'], 'safe visual order must also be the keyboard order');
  const request = await page.evaluate(() => JSON.parse(JSON.stringify(window.calls.find((c)=>c.method==='session.delegate'))));
  assert.deepEqual(request.params, {id:'parent',profileId:'claude-main',model:'opus',task:'Review the vulnerability'});
  assert.equal(await page.getByText('claude-main · opus', {exact:true}).count(),1);
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.HELM_TEST_SCREENSHOT_DIR,'subagents-desktop.png')});
  assert.equal(await page.getByRole('button',{name:'Open child thread →'}).count(), 0);
  assert.ok(await page.evaluate(()=>window.calls.some((c)=>c.method==='session.list'&&c.params.parentId==='parent')));
  await page.getByRole('button',{name:'Deny',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.calls.some((c)=>c.method==='session.answer'&&c.params.id==='child'&&c.params.decision.option==='deny')));
  await page.getByLabel('Message subagent').fill('Keep the security checks intact');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.calls.some((c)=>c.method==='session.delegation-message'&&c.params.parentId==='parent'&&c.params.id==='child'&&c.params.data==='Keep the security checks intact')));
  assert.equal(await page.evaluate(()=>window.opened),undefined);
  await page.getByRole('button',{name:'Close subagents'}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
});

test('subagents fit a phone, trap focus, stop a task and restore the launcher', async () => {
  await page.setViewportSize({width:390,height:844});
  await page.locator('#launcher').focus();
  await page.evaluate(()=>window.showSubagents());
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
  await page.getByRole('button',{name:'Result and controls',exact:true}).click();
  await page.getByRole('button',{name:'Stop subagent'}).click();
  assert.ok(await page.evaluate(()=>window.calls.some((c)=>c.method==='session.interrupt'&&c.params.id==='child')));
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.HELM_TEST_SCREENSHOT_DIR,'subagents-phone.png')});
  for(let i=0;i<15;i++) {
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate((el)=>el.contains(document.activeElement)),true);
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.equal(await page.locator('#launcher').evaluate((el)=>el===document.activeElement),true);
});

test('only this parent and machine contribute tasks, including live updates', async () => {
  await page.evaluate(() => window.showSubagents());
  await page.getByRole('button', { name:/Review the vulnerability/ }).waitFor();
  assert.equal(await page.getByText('Other thread task', {exact:true}).count(), 0);
  assert.equal(await page.getByText('Archived task', {exact:true}).count(), 0);
  await page.evaluate(() => {
    window.sendSessionUpdate('local', window.unrelatedChild);
    window.sendSessionUpdate('other-machine', {...window.unrelatedChild, title:'Other machine task', delegation:{parentId:'parent'}});
  });
  assert.equal(await page.locator('.delegation-branch').count(), 1);
  await page.evaluate(() => { window.childDone = true; });
  await page.getByRole('button', { name:'Result and controls',exact:true }).click();
  await page.getByRole('button', { name:'Hide finished task' }).click();
  assert.equal(await page.locator('.delegation-branch').count(), 0);
  assert.ok(await page.evaluate(() => window.calls.some(c=>c.method==='session.archive'&&c.params.id==='child'&&c.params.archived)));
  await page.getByRole('button', { name:'Close subagents' }).click();
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
    const client = {relay:'http://helm-history-test',subscribe:()=>{},on:()=>()=>{},watchLatency:()=>()=>{},
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
      await view.goto('http://helm-history-test/');
      await view.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
      await view.addScriptTag({content:bundle.outputFiles[0].text});
      await view.locator('.sidebar').getByRole('textbox').fill('Parent history chat');
      await view.locator('.sidebar .rt-text').getByText('Parent history chat',{exact:true}).click();
      const heading = title=>view.locator('.session-bar h1').filter({hasText:new RegExp('^'+title+'$')});
      await heading('Parent history chat').waitFor();
      const openChild = async title=>{
        if(width===390) await view.getByRole('button',{name:'more',exact:true}).click();
        await view.getByRole('button',{name:'Subagents',exact:true}).click();
        await view.getByRole('button',{name:new RegExp(title)}).click();
        await heading(title).waitFor();
      };
      const parentDepth = await view.evaluate(()=>history.state.depth);
      await openChild('Child history chat');
      await openChild('Grandchild history chat');
      await view.getByRole('button',{name:'Back to parent thread',exact:true}).click();
      await heading('Child history chat').waitFor();
      await view.getByRole('button',{name:'Back to parent thread',exact:true}).click();
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
