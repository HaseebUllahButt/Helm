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
    const client = {input:(env,params)=>client.rpc(env,'session.input',params),
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

test('the parent picker is ready before model discovery; helper defaults and overrides stay separate', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Subagents } from './apps/web/src/session/Subagents';
    const root = createRoot(document.getElementById('root'));
    const parent = {id:'parent',title:'Dispatch',cwd:'/project',engine:'codex',profileId:'parent-account',model:'parent-model',status:'working'};
    let defaults = {}, favorites = ['helper-model'], generation = 0;
    const catalog = () => ({default:'normal-model',models:['parent-model','helper-model','normal-model','m1','m2','m3','m4'],
      labels:{'parent-model':'Parent Model','helper-model':'Helper Model'},favs:favorites,efforts:['low','high'],effort:'low',
      defaults:{effort:'low',mode:'ask'},subagentDefaults:defaults,modes:[{id:'ask',label:'Ask before acting'}]});
    let first = true;
    const client = {input:(env,params)=>client.rpc(env,'session.input',params),on:()=>()=>{},rpc:async(env,method,params)=>{
      (window.calls ??= []).push({method,params});
      if(method==='session.list') return {sessions:[]};
      if(method==='agent.list') return {agents:[
        {id:'other',engine:'claude',account:'a1',label:'Other account',available:true,auth:'authenticated',modes:[],shown:true},
        {id:'other-alias',engine:'claude',account:'a1',label:'Other alias',available:true,auth:'authenticated',modes:[],shown:false},
        {id:'hidden-one',engine:'grok',account:'a3',label:'Hidden account',available:true,auth:'authenticated',modes:[],shown:false},
        {id:'parent-plain',engine:'codex',account:'a2',label:'Parent plain alias',available:true,auth:'authenticated',modes:[],shown:true},
        {id:'parent-account',engine:'codex',account:'a2',label:'Parent account',available:true,auth:'authenticated',modes:[{id:'ask',label:'Ask before acting'}],defaults:{effort:'low',mode:'ask'},subagentDefaults:defaults,shown:false}
      ]};
      if(method==='model.list') {
        if(first) {first=false; return new Promise(resolve=>window.releaseCatalog=()=>resolve({...catalog(),refreshing:true,models:['parent-model']}));}
        return catalog();
      }
      if(method==='profile.defaults') {
        if(window.failSave) throw new Error('Could not save helper default');
        defaults={...defaults};
        for(const key of ['model','effort','mode']) if(key in params) {if(params[key]) defaults[key]=params[key]; else delete defaults[key];}
        return {subagentDefaults:defaults};
      }
      if(method==='picker.prefs') {favorites=params.favs.codex;return {ok:true};}
      if(method==='session.delegate') return {session:{...parent,id:'child',model:params.model||defaults.model||parent.model,
        delegation:{parentId:'parent',task:params.task,status:'done'},status:'idle'}};
      if(method==='session.delegation-result') return {complete:true,status:'done',output:'Finished.'};
      return {ok:true};
    }};
    window.mount=()=>root.render(<Subagents key={++generation} client={client} env={{id:'dispatch-test',name:'Laptop',online:true,info:{}}}
      parent={parent} onClose={()=>root.render(null)} />);
    window.mount();
  `, resolveDir:process.cwd(),loader:'tsx' },bundle:true,write:false,format:'iife',jsx:'automatic'});
  for (const width of [1280,390]) {
    const view = await browser.newPage({viewport:{width,height:844}});
    view.setDefaultTimeout(10_000);
    try {
      await view.route('http://helm-dispatch-test/**', route => route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
      await view.goto('http://helm-dispatch-test/');
      await view.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
      await view.addScriptTag({content:bundle.outputFiles[0].text});
      await view.getByRole('button',{name:'New task'}).click();
      await view.getByRole('button',{name:'Agent account: Parent account'}).waitFor();
      await view.getByLabel('Task',{exact:true}).fill('Inspect this task');
      assert.equal(await view.evaluate(()=>window.calls.find(c=>c.method==='agent.list').params.models),false);
      assert.equal(await view.getByRole('button',{name:'Start helper'}).isEnabled(),true);
      // Only what new chats offer here, with this chat's own alias in place of its account's usual row.
      await view.getByRole('button',{name:'Agent account: Parent account'}).click();
      assert.deepEqual(await view.getByRole('option').evaluateAll(rows=>rows.map(row=>row.textContent.split(' · ')[0])),
        ['Other account','Parent account']);
      await view.getByRole('button',{name:'close',exact:true}).click();
      assert.equal(await view.evaluate(()=>window.calls.filter(c=>c.method==='session.delegate').length),0);
      await view.evaluate(()=>window.releaseCatalog());
      await view.getByRole('button',{name:/^model:/}).click();
      // Model names only, the machine's default for the account already chosen.
      await view.getByRole('option',{name:'normal-model',exact:true}).waitFor();
      assert.equal(await view.getByRole('option',{name:'normal-model',exact:true}).getAttribute('aria-selected'),'true');
      assert.equal(await view.getByRole('option',{name:/Default on|Inherit/}).count(),0);
      await view.getByRole('button',{name:'close',exact:true}).click();
      await view.getByRole('button',{name:/^thinking:/}).waitFor();
      await view.getByRole('button',{name:/^model:/}).click();
      await view.getByRole('checkbox',{name:'Favorite Helper Model'}).waitFor();
      await view.getByRole('checkbox',{name:'Favorite Helper Model'}).uncheck();
      await view.getByRole('checkbox',{name:'Favorite Helper Model'}).check();
      await view.getByRole('button',{name:'Use Helper Model by default for subagents'}).click();
      await view.getByRole('button',{name:'Helper Model is the default for subagents'}).waitFor();
      assert.equal(await view.evaluate(()=>window.calls.filter(c=>c.method==='model.prefs').length),0);
      assert.equal(await view.evaluate(()=>window.calls.filter(c=>c.method==='session.delegate').length),0);
      await view.getByLabel('Search model').fill('Helper');
      await view.getByRole('option',{name:'Helper Model',exact:true}).waitFor();
      await view.getByLabel('Search model').fill('');
      await capture(view, 'dispatch-models-'+width+'.png');
      assert.ok(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await view.getByRole('button',{name:'Close helpers'}).click();
      await view.evaluate(()=>window.mount());
      await view.getByRole('button',{name:'New task'}).click();
      await view.getByRole('button',{name:'model: model'}).waitFor();
      await view.getByRole('button',{name:/^model:/}).click();
      await view.getByRole('button',{name:'Helper Model is the default for subagents'}).waitFor();
      await view.evaluate(()=>{window.failSave=true;});
      await view.getByRole('button',{name:'Use normal-model by default for subagents'}).click();
      await view.getByRole('alert').filter({hasText:'Could not save helper default'}).waitFor();
      await view.getByRole('button',{name:'Helper Model is the default for subagents'}).waitFor();
      await view.evaluate(()=>{window.failSave=false;});
      await view.getByRole('button',{name:'Use normal-model by default for subagents'}).click();
      await view.getByRole('button',{name:'normal-model is the default for subagents'}).waitFor();
      await view.getByRole('button',{name:'Use Helper Model by default for subagents'}).click();
      await view.getByRole('button',{name:'Helper Model is the default for subagents'}).waitFor();
      await view.getByRole('option',{name:'normal-model',exact:true}).click();
      await view.getByRole('button',{name:/^thinking:/}).click();
      await view.getByRole('button',{name:'Use high by default for subagents'}).click();
      await view.getByRole('button',{name:'high is the default for subagents'}).waitFor();
      await view.getByRole('button',{name:'close',exact:true}).click();
      await view.getByLabel('Task',{exact:true}).fill('Launch on the machine default');
      await view.getByRole('button',{name:'Start helper'}).click();
      assert.deepEqual(await view.evaluate(()=>JSON.parse(JSON.stringify(window.calls.find(c=>c.method==='session.delegate').params))),
        {id:'parent',profileId:'parent-account',model:'normal-model',task:'Launch on the machine default'});
    } finally { await view.close(); }
  }
});

test('main task click opens the full child conversation and Back returns to its parent', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    const env = { id:'navigation-test', name:'Laptop', online:true, info:{} };
    const parent = { id:'parent', title:'Parent chat', cwd:'/project', engine:'codex', profileId:'codex', status:'idle', driver:true };
    const child = { ...parent, id:'child', title:'Inspect child conversation',
      delegation:{parentId:parent.id, task:'Inspect the implementation', status:'done'} };
    const client = {input:(env,params)=>client.rpc(env,'session.input',params),
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
      await view.getByRole('button', {name:'Agents',exact:true}).click();
      await view.getByRole('dialog', {name:'Agents',exact:true}).waitFor();
      await view.getByRole('button', {name:/Inspect child conversation/}).click();
      await view.getByRole('heading', {name:'Inspect child conversation',exact:true}).waitFor();
      await view.getByRole('dialog', {name:'Helpers'}).waitFor({state:'detached'});
      await view.locator('.turn.user .bubble').filter({hasText:'child original request'}).waitFor();
      await view.getByText('child full conversation response', {exact:true}).waitFor();
      assert.equal(await view.getByText('parent full conversation response', {exact:true}).count(), 0);
      await view.getByLabel('Message Codex', {exact:true}).fill('Continue the child task');
      await view.getByRole('button', {name:'send',exact:true}).click();
      await view.waitForFunction(() => window.calls.some(c=>c.method==='session.input'&&c.params.id==='child'));
      assert.equal(await view.evaluate(() => window.calls.some(c=>c.method==='session.delegation-result')), false);
      await view.evaluate(() => { window.failParent = true; });
      await view.getByRole('button', {name:'Back to main chat',exact:true}).click();
      await view.getByRole('alert').filter({hasText:'Parent temporarily unavailable'}).waitFor();
      assert.equal(await view.getByRole('heading', {name:'Inspect child conversation',exact:true}).count(), 1);
      await view.evaluate(() => { window.failParent = false; });
      await view.getByRole('button', {name:'Back to main chat',exact:true}).click();
      await view.getByRole('heading', {name:'Parent chat',exact:true}).waitFor();
      await view.getByText('parent full conversation response', {exact:true}).waitFor();
      assert.equal(await view.getByRole('dialog', {name:'Helpers'}).count(), 0);
      assert.equal(await view.evaluate(() => window.backToList), undefined);
      await view.getByRole('button', {name:'Back',exact:true}).click();
      assert.equal(await view.evaluate(() => window.backToList), true);
    } finally { await view.close(); }
  }
});

test('desktop and phone headers open unified details with accessible Git navigation', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    const env = { id:'header-test', name:'Laptop', online:true, info:{} };
    const parent = { id:'parent', title:'Header layout chat', cwd:'/project', engine:'codex', profileId:'codex', status:'idle', driver:true, delegations:['a','b'] };
    const client = {input:(env,params)=>client.rpc(env,'session.input',params),
      on: () => () => {}, subscribe: () => {},
      rpc: async (env, method, params) => {
        if (method === 'model.list') return { models:[], modes:[] };
        if (method === 'agent.list') return { agents:[] };
        if (method === 'session.list') return { sessions:[] };
        if (method === 'session.watch') return { last:0 };
        if (method === 'session.events') return { session:parent, events:[], pending:[], last:0 };
        if (method === 'git.status') return { repo:true, root:'/project', branch:'main', head:{commit:'abc'},
          files:[{path:'a.ts',status:'M',add:1,del:0},{path:'b.ts',status:'M',add:2,del:1}] };
        if (method === 'git.graph') return { repo:true, commits:[], worktrees:[] };
        if (method === 'git.pr') return { pr:null };
        return { ok:true };
      },
    };
    function Chat() {
      const [session, setSession] = useState(parent);
      return <DrivenSession client={client} env={env} session={session} onBack={()=>{}} onClosed={()=>{}}
        onArchived={()=>{}} onSession={setSession} onOpenSession={setSession} />;
    }
    createRoot(document.getElementById('root')).render(<Chat />);
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic' });
  for (const {width, phone} of [{width:1280,phone:false}, {width:390,phone:false}, {width:390,phone:true}]) {
    const view = await browser.newPage({ viewport:{width,height:844}, hasTouch:phone, isMobile:phone });
    view.setDefaultTimeout(10_000);
    try {
      await view.route('http://helm-header-test/**', route => route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width, initial-scale=1"><div class="session" id="root"></div>'}));
      await view.goto('http://helm-header-test/');
      await view.addStyleTag({ content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'') });
      await view.addScriptTag({ content:bundle.outputFiles[0].text });
      const bar = view.locator('.session-bar');
      // Git has its own button, with the number of changed files on it.
      const details = bar.getByRole('button', {name:'Git: 2 changed files',exact:true});
      await details.waitFor();
      assert.equal(await details.locator('.cbadge').textContent(), '2');
      await capture(bar, `session-header-${phone ? 'phone' : 'desktop'}-${width}.png`);
      assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await details.click();
      // Git opens straight onto its own screen (4b09f8d), not a details tab.
      const dialog = view.getByRole('dialog', {name:'Git',exact:true});
      await dialog.getByRole('tab', {name:/^Changes/}).waitFor();
      await dialog.getByRole('tab', {name:'Graph',exact:true}).click();
      await dialog.getByRole('tabpanel', {name:'Graph',exact:true}).waitFor();
      assert.deepEqual(await dialog.getByRole('tab').evaluateAll(tabs => tabs.map(tab => [tab.textContent.trim(), tab.getAttribute('aria-selected'),
        !tab.hasAttribute('aria-controls') || !!document.getElementById(tab.getAttribute('aria-controls'))])),
        [['Graph', 'true', true], ['Changes 2', 'false', true], ['Files', 'false', true], ['Build checks', 'false', true]], 'every tab points only at a panel that exists');
      await dialog.getByRole('tab', {name:'Graph',exact:true}).press('ArrowRight');
      await dialog.getByRole('tabpanel', {name:/^Changes/}).waitFor();
      assert.equal(await view.getByRole('dialog').count(), 1);
      await view.screenshot({ path:`/tmp/helm-git-dialog-${phone ? 'phone' : 'desktop'}-${width}.png` });
      await capture(view, `thread-details-${width}.png`);
      await dialog.getByRole('button', {name:'Back to chat'}).click();
      await dialog.waitFor({ state:'detached' });
      assert.equal(await bar.getByRole('button', {name:'Prompt cache',exact:true}).count(), 0);
    } finally { await view.close(); }
  }
});

test('launch options stay folded until asked for, then create a linked child and expose its approval', async () => {
  await page.locator('#launcher').focus();
  await page.evaluate(() => window.showSubagents());
  // The task form is a folded bar until asked for, even in an empty panel.
  const newTask = page.getByRole('button', {name:'New task'});
  await newTask.waitFor();
  assert.equal(await page.getByLabel('Task', {exact:true}).count(), 0);
  await newTask.click();
  const taskBox = page.getByLabel('Task', {exact:true});
  await taskBox.waitFor();
  assert.equal(await isFocused(taskBox), true, 'opening it goes straight to the task');
  // The message box's own chips: account, then model and permissions.
  const accountChip = page.getByRole('button', {name:/^Agent account:/});
  await page.getByRole('button', {name:'Agent account: Codex personal'}).waitFor();
  assert.equal(await page.getByRole('listbox').count(), 0, 'no sheet is open until a chip is tapped');
  await capture(page, 'subagents-desktop-launch-collapsed.png');
  await accountChip.click();
  const accounts = page.getByRole('listbox', {name:'Agent account on Laptop'});
  await accounts.waitFor();
  await accounts.getByRole('option', {name:/Claude work/}).filter({hasText:'signed out'}).waitFor();
  assert.equal(await accounts.locator('.moderow .mark').count(), await accounts.getByRole('option').count(), 'each account shows its CLI logo');
  await capture(page, 'subagents-desktop-accounts.png');
  await accounts.getByRole('option', {name:/Claude personal/}).click();
  await page.getByRole('button', {name:'Agent account: Claude personal'}).waitFor();
  await page.getByRole('button', {name:/^permissions:/}).click();
  const perms = page.getByRole('listbox', {name:'permissions'});
  assert.equal(await perms.getByRole('option', {name:/Plan first/}).count(), 0);
  assert.equal(await perms.getByRole('option', {name:/Bypass all checks/}).count(), 1);
  await page.getByRole('button', {name:/^model:/}).click();
  const models = page.getByRole('listbox', {name:'model'});
  await models.getByRole('option', {name:/^opus/}).click();
  await page.getByRole('button', {name:'model: opus'}).waitFor();
  await capture(page, 'subagents-launch.png');
  assert.equal(await page.getByRole('button', {name:'Cancel'}).count(), 1, 'Cancel always shows in the task form');
  await taskBox.fill('Review the vulnerability');
  const startsBeforeComposition = await page.evaluate(() => window.calls.filter((call) => call.method === 'session.delegate').length);
  await taskBox.dispatchEvent('keydown', {key:'Enter',ctrlKey:true,isComposing:true});
  assert.equal(await page.evaluate(() => window.calls.filter((call) => call.method === 'session.delegate').length), startsBeforeComposition);
  await page.getByRole('button', {name:'Start helper'}).click();
  await page.getByText('Read the diff', {exact:true}).waitFor();
  assert.equal(await page.getByLabel('Task', {exact:true}).count(), 0, 'the launch form folds once the task starts');
  await page.getByRole('button', {name:'New task'}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.task), 'child', 'focus lands on the new task');
  const toggle = page.getByRole('button', {name:'Needs approval, details'});
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('.delegation-group.active .delegation-branch').count(), 1);
  assert.deepEqual(await page.locator('.sheet-actions button').allTextContents(), ['Deny', 'Allow'], 'safe visual order must also be the keyboard order');
  const request = await page.evaluate(() => JSON.parse(JSON.stringify(window.calls.find((c)=>c.method==='session.delegate'))));
  assert.deepEqual(request.params, {id:'parent',profileId:'claude-main',model:'opus',task:'Review the vulnerability'});
  assert.equal(await page.getByText('claude-main · opus', {exact:true}).count(),1);
  await capture(page, 'subagents-desktop.png');
  await toggle.click();
  await page.locator('.delegation-detail').waitFor({state:'detached'});
  await capture(page, 'subagents-desktop-list-collapsed.png');
  await toggle.click();
  await page.getByText('Read the diff', {exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>window.calls.some((c)=>c.method==='session.list'&&c.params.parentId==='parent')));
  await page.getByRole('button',{name:'Deny',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.calls.some((c)=>c.method==='session.answer'&&c.params.id==='child'&&c.params.decision.option==='deny')));
  await page.getByLabel('Message helper').fill('Keep the security checks intact');
  const messagesBeforeComposition = await page.evaluate(() => window.calls.filter((call) => call.method === 'session.agent-send').length);
  await page.getByLabel('Message helper').dispatchEvent('keydown', {key:'Enter',metaKey:true,isComposing:true});
  assert.equal(await page.evaluate(() => window.calls.filter((call) => call.method === 'session.agent-send').length), messagesBeforeComposition);
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Helm sent the message.'}).waitFor();
  assert.ok(await page.evaluate(()=>window.calls.some((c)=>c.method==='session.agent-send'&&c.params.id==='parent'&&c.params.to.id==='child'&&c.params.asUser===true&&c.params.text==='Keep the security checks intact')));
  assert.equal(await page.evaluate(()=>window.opened),undefined);
  await page.getByRole('button',{name:'Open chat',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.opened),'child');
  await page.getByRole('button',{name:'Close helpers'}).click();
  await page.getByRole('dialog').waitFor({state:'detached'});
});

test('subagents fit a phone, open only the selected task, trap focus, stop a task and restore the launcher', async () => {
  await page.setViewportSize({width:390,height:844});
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

test('a failed task moves to Finished and retries with the same account, model, effort and task', async () => {
  await page.evaluate(() => window.showSubagents());
  await page.getByRole('button',{name:'Needs approval, details'}).waitFor();
  await page.evaluate(() => {
    window.results = { child:{ session:window.child, status:'error', complete:true, output:'', error:'CLI crashed' } };
    window.sendSessionUpdate('local', {...window.child, effort:'high', status:'error', delegation:{...window.child.delegation, status:'error'}});
  });
  await page.locator('.delegation-group.finished .delegation-branch').waitFor();
  assert.equal(await page.locator('.delegation-group.active').count(), 0);
  await page.getByRole('button',{name:'Failed, details'}).click();
  await page.getByText('CLI crashed', {exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Stop helper'}).count(), 0);
  const before = await page.evaluate(() => window.calls.filter((call)=>call.method==='session.delegate').length);
  await page.evaluate(() => {
    window.nextChild = {...window.child, id:'retry', status:'starting', delegation:{...window.child.delegation, status:'starting'}};
    window.results.retry = { session:window.nextChild, status:'working', complete:false, output:'' };
  });
  await page.getByRole('button',{name:'Retry task'}).click();
  await page.locator('.delegation-group.active .delegation-branch.selected').waitFor();
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
  await page.getByRole('button', { name:'Needs approval, details' }).click();
  await page.getByRole('button', { name:'Hide task' }).click();
  await page.getByText('This chat has no helper tasks.', {exact:true}).waitFor();
  assert.equal(await page.locator('.delegation-branch').count(), 0);
  assert.equal(await isFocused(page.getByRole('button',{name:'New task'})), true);
  assert.ok(await page.evaluate(() => window.calls.some(c=>c.method==='session.archive'&&c.params.id==='child'&&c.params.archived)));
  await page.getByRole('button', { name:'Close helpers' }).click();
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
    const client = {input:(env,params)=>client.rpc(env,'session.input',params),relay:'http://helm-history-test',subscribe:()=>{},on:()=>()=>{},watchLatency:()=>()=>{},
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
      await view.locator('.sidebar').getByRole('button',{name:'Search chats, machines, and folders'}).click();
      const palette = view.getByRole('dialog',{name:'Search and actions'});
      await palette.getByRole('combobox').fill('Parent history chat');
      await palette.getByRole('option',{name:/Parent history chat/}).click();
      const heading = title=>view.locator('.session-bar h1').filter({hasText:new RegExp('^'+title+'$')});
      await heading('Parent history chat').waitFor();
      const openChild = async title=>{
        await view.locator('.session-bar').getByRole('button',{name:'Agents',exact:true}).click();
        await view.getByRole('dialog',{name:'Agents',exact:true}).waitFor();
        await view.getByRole('button',{name:new RegExp(title)}).click();
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

test('a CLI\'s own subagents show beside delegated tasks, looking the same', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    const env = { id:'native-test', name:'Laptop', online:true, info:{} };
    const native = (id, status, title, last) => ({ id, native:true, title, agentType:'general-purpose', model:'claude-opus-test',
      status, startedAt:1, updatedAt:2, branch: id === 'a1' ? 'worktree-agent-a1' : null, toolUseId:'toolu_'+id, last });
    const parent = { id:'parent', title:'Native parent', cwd:'/project', engine:'claude', profileId:'claude', status:'idle', driver:true,
      team:{ working:1, blocked:1, failed:0 },
      nativeCards:[native('a1','working','Map the code','Grep: needle'), native('a2','done','Write the summary','All tests pass.'),
        native('a3','blocked','Edit the config','Edit: config.js')] };
    const child = { ...parent, id:'child', title:'Delegated review', nativeCards:undefined, team:undefined,
      delegation:{ parentId:'parent', task:'Delegated review', status:'done' } };
    const client = {input:(env,params)=>client.rpc(env,'session.input',params),
      on: () => () => {}, subscribe: () => {},
      rpc: async (env, method, params) => {
        (window.calls ??= []).push({env,method,params});
        if (method === 'model.list') return { models:[], modes:[] };
        if (method === 'agent.list') return { agents:[] };
        if (method === 'session.list') return { sessions:[child] };
        if (method === 'session.watch') return { last:0 };
        if (method === 'session.events') return { session:parent, events:[], pending:[], last:0 };
        if (method === 'session.native-agent') return { agent:{ ...parent.nativeCards.find(a=>a.id===params.agentId),
          result:'**All tests pass.** Two files changed.', activity:['Read: /project/a.js','Bash: Run the tests','All tests pass.'],
          task:'Write the summary of the change', worktree:null } };
        return { ok:true };
      },
    };
    function Chat() {
      const [session, setSession] = useState(parent);
      return <DrivenSession client={client} env={env} session={session} onBack={()=>{}} onClosed={()=>{}}
        onArchived={()=>{}} onSession={setSession} onOpenSession={(s)=>{ window.opened = s.id; }} />;
    }
    createRoot(document.getElementById('root')).render(<Chat />);
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic' });
  for (const width of [1280, 390]) {
    const view = await browser.newPage({ viewport:{width,height:844} });
    view.setDefaultTimeout(10_000);
    try {
      await view.route('http://helm-native-test/**', r => r.fulfill({contentType:'text/html',body:'<div class="session" id="root"></div>'}));
      await view.goto('http://helm-native-test/');
      await view.addStyleTag({ content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'') });
      await view.addScriptTag({ content:bundle.outputFiles[0].text });
      // One delegated task and three native subagents, counted together.
      const launcher = view.getByRole('button', {name:'Agents',exact:true});
      await launcher.locator('.cbadge').filter({hasText:/^4$/}).waitFor();
      await view.locator('.chip.working').waitFor();
      await launcher.click();
      await view.getByRole('dialog', {name:'Agents',exact:true}).waitFor();
      const active = view.locator('.delegation-group.active');
      const finished = view.locator('.delegation-group.finished');
      await active.getByRole('heading').filter({hasText:'2'}).waitFor();
      await finished.getByRole('heading').filter({hasText:'2'}).waitFor();
      // Nothing marks them apart from Helm's own helpers.
      assert.equal(await view.locator('.native-badge').count(), 0);
      // The chat says one waits on an approval: one card, first, saying so.
      assert.deepEqual(await active.locator('.delegation-status').allInnerTexts(), ['Needs approval', 'Working']);
      await active.getByRole('button', {name:'Needs approval, details'}).click();
      await view.locator('#task-detail-native-a3').getByText('Approve the request in the chat.', {exact:true}).waitFor();
      await active.getByRole('button', {name:'Needs approval, details'}).click();
      assert.match(await active.locator('.delegation-task small').nth(1).innerText(), /general-purpose · claude-opus-test · worktree-agent-a1/i);
      assert.equal(await finished.locator('.delegation-branch').count(), 2);
      // Expanding reads its result and steps; nothing offers to steer it.
      await view.getByRole('button', {name:/Write the summary/}).click();
      const detail = view.locator('#task-detail-native-a2');
      await detail.locator('.delegation-output strong').filter({hasText:'All tests pass.'}).waitFor();
      await detail.getByText('Write the summary of the change', {exact:true}).waitFor();
      await detail.locator('summary').filter({hasText:'Recent activity'}).click();
      await detail.getByText('Bash: Run the tests', {exact:true}).waitFor();
      assert.equal(await detail.getByRole('button').count(), 0);
      assert.equal(await detail.locator('textarea').count(), 0);
      assert.ok(await view.evaluate(() => window.calls.some(c => c.method === 'session.native-agent' && c.params.id === 'parent' && c.params.agentId === 'a2')));
      assert.equal(await view.evaluate(() => window.calls.some(c => c.method === 'session.delegation-result' && String(c.params.id).startsWith('a'))), false);
      assert.equal(await view.evaluate(() => window.opened), undefined);
      await capture(view, `native-subagents-${width}.png`);
    } finally { await view.close(); }
  }
});

test('a terminal thread lists its CLI\'s subagents without a task form', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Subagents } from './apps/web/src/session/Subagents';
    const parent = { id:'term', title:'Terminal Claude', cwd:'/project', engine:'claude', status:'idle', nativeCli:true, nativeChat:true,
      nativeCards:[{ id:'b1', native:true, title:'Check the docs', agentType:'Explore', model:null, status:'interrupted',
        startedAt:1, updatedAt:2, branch:null, toolUseId:null, last:'Read: README.md' }] };
    const client = {input:(env,params)=>client.rpc(env,'session.input',params),
      on: () => () => {},
      rpc: async (env, method, params) => {
        (window.calls ??= []).push({env,method,params});
        if (method === 'session.list') return { sessions:[] };
        if (method === 'session.native-agent') return { agent:{ ...parent.nativeCards[0], result:'', activity:[], task:'Check the docs', worktree:null } };
        return { ok:true };
      },
    };
    createRoot(document.getElementById('root')).render(<Subagents nativeOnly client={client} env={{id:'local',name:'Laptop',online:true,info:{agentMessages:true}}}
      parent={parent} onClose={()=>{ window.closed = true; }} />);
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic' });
  const view = await browser.newPage({ viewport:{width:390,height:844} });
  view.setDefaultTimeout(10_000);
  try {
    await view.setContent('<div id="root"></div>');
    await view.addStyleTag({ content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'') });
    await view.addScriptTag({ content:bundle.outputFiles[0].text });
    const dialog = view.getByRole('dialog', {name:'Helpers'});
    await dialog.locator('.delegation-group.finished .delegation-branch').waitFor();
    await dialog.getByRole('button', {name:'Stopped, details'}).click();
    await dialog.getByText('The agent finished without a written reply.', {exact:true}).waitFor();
    assert.equal(await dialog.getByRole('button', {name:/New task/}).count(), 0);
    assert.equal(await dialog.locator('form').count(), 0);
    assert.equal(await view.evaluate(() => window.calls.some(c => c.method === 'agent.list')), false);
  } finally { await view.close(); }
});

test('a CLI\'s subagent opens as a chat of its whole conversation', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Subagents } from './apps/web/src/session/Subagents';
    import { NativeAgentView } from './apps/web/src/session/NativeAgentView';
    const env = { id:'local', name:'Laptop', online:true, info:{} };
    const card = { id:'c1', native:true, title:'Map the code', agentType:'Explore', model:'claude-opus-test', status:'working',
      startedAt:1, updatedAt:2, branch:null, toolUseId:null, last:'Grep: needle' };
    const parent = { id:'parent', title:'Fix the login bug', cwd:'/project', engine:'claude', status:'working', nativeCards:[card] };
    let reads = 0;
    const events = () => {
      const out = [
        { seq:1, type:'turn.start', turnId:'native-1', text:'Find where the login form is checked.' },
        { seq:2, type:'item.start', turnId:'native-1', id:'native-2', kind:'text' },
        { seq:3, type:'item.delta', turnId:'native-1', id:'native-2', text:'Looking through the **form code**.' },
        { seq:4, type:'item.done', turnId:'native-1', id:'native-2', status:'ok' },
        { seq:5, type:'item.start', turnId:'native-1', id:'native-3', kind:'tool', name:'Grep', input:'needle' },
        { seq:6, type:'item.done', turnId:'native-1', id:'native-3', status:'ok' },
      ];
      if (reads > 1) out.push(
        { seq:7, type:'item.start', turnId:'native-1', id:'native-4', kind:'text' },
        { seq:8, type:'item.delta', turnId:'native-1', id:'native-4', text:'It is checked in auth.js line 40.' },
        { seq:9, type:'item.done', turnId:'native-1', id:'native-4', status:'ok' },
        { seq:10, type:'turn.done', turnId:'native-1', status:'ok' });
      return out;
    };
    const client = {input:(env,params)=>client.rpc(env,'session.input',params),
      on: () => () => {},
      rpc: async (envId, method, params) => {
        (window.calls ??= []).push({ method, params });
        if (method === 'session.list') return { sessions:[] };
        if (method === 'session.native-agent') {
          reads++;
          const status = reads > 1 ? 'done' : 'working';
          return { agent:{ ...card, status, updatedAt:reads, result:'', activity:[], task:'', worktree:null }, events:events(), more:false };
        }
        return { ok:true };
      },
    };
    function App() {
      const [open, setOpen] = useState(null);
      return open ? <div className="main showing" style={{display:'flex',flexDirection:'column',height:'100vh'}}><NativeAgentView client={client} env={env} parent={parent} agent={open} onBack={() => setOpen(null)} /></div>
        : <Subagents nativeOnly client={client} env={env} parent={parent} onClose={()=>{}} onOpenNative={setOpen} />;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic' });
  for (const width of [1280, 390]) {
    const view = await browser.newPage({ viewport:{width,height:844} });
    view.setDefaultTimeout(10_000);
    try {
      await view.setContent('<div id="root"></div>');
      await view.addStyleTag({ content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'') });
      await view.addScriptTag({ content:bundle.outputFiles[0].text });
      // Its title opens it, the way a Helm task's title opens that chat.
      await view.getByRole('button', {name:/Map the code/}).click();
      await view.getByRole('heading', {name:'Map the code'}).waitFor();
      await view.getByText('Find where the login form is checked.').waitFor();
      await view.locator('strong').filter({hasText:'form code'}).waitFor();
      assert.ok(await view.evaluate(() => window.calls.some(c => c.method === 'session.native-agent' && c.params.full === true && c.params.agentId === 'c1')));
      // Still working, so it is read again until it settles.
      await view.getByText('It is checked in auth.js line 40.').waitFor();
      await view.locator('.sub').filter({hasText:/^Finished · Explore · claude-opus-test$/}).waitFor();
      // Its parent cannot pass messages on: no composer, and a line saying where to steer it.
      assert.equal(await view.locator('textarea').count(), 0);
      await view.locator('.native-foot').filter({hasText:'Fix the login bug'}).waitFor();
      await capture(view, `native-chat-${width}.png`);
      await view.getByRole('button', {name:'Back', exact:true}).click();
      await view.getByRole('button', {name:/Map the code/}).waitFor();
    } finally { await view.close(); }
  }
});

test('a subagent whose parent can pass messages on takes one from its chat', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NativeAgentView } from './apps/web/src/session/NativeAgentView';
    const env = { id:'local', name:'Laptop', online:true, info:{} };
    const card = { id:'kid', native:true, engine:'codex', title:'audit flow', agentType:'Dewey', model:'gpt-test', status:'done',
      startedAt:1, updatedAt:2, branch:null, toolUseId:'spawn1', last:'Saves twice.', canMessage:true };
    const parent = { id:'parent', title:'Fix intake', cwd:'/project', engine:'codex', status:'idle', driver:'codex', nativeCards:[card] };
    let sent = '';
    const client = {input:(env,params)=>client.rpc(env,'session.input',params),
      on: () => () => {},
      rpc: async (envId, method, params) => {
        (window.calls ??= []).push({ method, params });
        if (method === 'session.native-message') { sent = params.data; return { ok:true }; }
        if (method === 'session.native-agent') {
          const events = [
            { seq:1, type:'turn.start', turnId:'native-1', text:'New task from the main chat.' },
            { seq:2, type:'item.start', turnId:'native-1', id:'native-2', kind:'text' },
            { seq:3, type:'item.delta', turnId:'native-1', id:'native-2', text:'Saves twice.' },
            { seq:4, type:'item.done', turnId:'native-1', id:'native-2', status:'ok' },
            { seq:5, type:'turn.done', turnId:'native-1', status:'ok' },
          ];
          if (sent) events.push({ seq:6, type:'turn.start', turnId:'native-3', text:sent });
          return { agent:{ ...card, status: sent ? 'working' : 'done', updatedAt: sent ? 3 : 2, result:'', activity:[], task:'', worktree:null }, events, more:false };
        }
        return { ok:true };
      },
    };
    createRoot(document.getElementById('root')).render(<div className="main showing" style={{display:'flex',flexDirection:'column',height:'100vh'}}>
      <NativeAgentView client={client} env={env} parent={parent} agent={card} onBack={() => {}} /></div>);
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic' });
  for (const width of [1280, 390]) {
    const view = await browser.newPage({ viewport:{width,height:844} });
    view.setDefaultTimeout(10_000);
    try {
      await view.setContent('<div id="root"></div>');
      await view.addStyleTag({ content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'') });
      await view.addScriptTag({ content:bundle.outputFiles[0].text });
      await view.getByText('Saves twice.').waitFor();
      await view.getByText('Send directly to this helper').waitFor();
      assert.equal(await view.locator('.native-foot').count(), 0);
      const box = view.locator('textarea');
      await box.fill('Check the quote path too');
      await box.press('Enter');
      // Shown in the helper's chat once it is on its way.
      await view.locator('.turn.user').filter({hasText:'Check the quote path too'}).waitFor();
      await view.locator('.sub').filter({hasText:/^Working · Dewey · gpt-test$/}).waitFor();
      assert.ok(await view.evaluate(() => window.calls.some(c => c.method === 'session.native-message' && c.params.id === 'parent'
        && c.params.agentId === 'kid' && c.params.data === 'Check the quote path too')));
      assert.equal(await box.inputValue(), '');
      await capture(view, `native-message-${width}.png`);
    } finally { await view.close(); }
  }
});

// The Git button went missing more than once because it showed only for a
// chat whose own folder is a Git project. It is always in the header now;
// a chat in a config folder that edits a project elsewhere shows that project.
test('the Git button is always in the header, and follows the project a chat edited', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    const env = { id:'git-test', name:'Laptop', online:true, info:{} };
    const chat = (id, edits) => ({ session:{ id, title:'Config chat', cwd:'/home/me/.config/tool', engine:'codex', profileId:'codex', status:'idle', driver:true },
      events: edits ? [
        { seq:1, at:1, type:'turn.start', turnId:'t1', text:'fix it' },
        { seq:2, at:2, type:'item.start', turnId:'t1', id:'e1', kind:'edit', changes:[{ path:'/home/me/code/tool/src/web.py', kind:'update', diff:'' }] },
        { seq:3, at:3, type:'item.done', id:'e1', status:'ok' },
        { seq:4, at:4, type:'turn.done', turnId:'t1', status:'ok' },
      ] : [] });
    const scene = chat(location.hash.slice(1), location.hash === '#edited');
    window.asked = [];
    const client = { on: () => () => {}, subscribe: () => {},
      rpc: async (env, method, params) => {
        if (method === 'model.list') return { models:[], modes:[] };
        if (method === 'agent.list') return { agents:[] };
        if (method === 'session.list') return { sessions:[] };
        if (method === 'session.watch') return { last:0 };
        if (method === 'session.events') return { session:scene.session, events:scene.events, pending:[], last:scene.events.length };
        if (method === 'git.status') {
          window.asked.push(params.cwd);
          return params.cwd.startsWith('/home/me/code/tool') ? { repo:true, root:'/home/me/code/tool', branch:'main', head:{commit:'abc'},
            files:[{path:'src/web.py',status:'M',add:3,del:1}] } : { repo:false };
        }
        if (method === 'git.graph') return { repo:true, commits:[], worktrees:[] };
        if (method === 'git.pr') return { pr:null };
        return { ok:true };
      },
    };
    createRoot(document.getElementById('root')).render(<DrivenSession client={client} env={env} session={scene.session} onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} />);
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic' });
  const styles = (await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'');
  for (const scene of ['edited', 'untouched']) {
    const view = await browser.newPage({ viewport:{width:390,height:844} });
    view.setDefaultTimeout(10_000);
    try {
      await view.route('http://helm-git-test/**', route => route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width, initial-scale=1"><div class="session" id="root"></div>'}));
      await view.goto(`http://helm-git-test/#${scene}`);
      await view.addStyleTag({ content:styles });
      await view.addScriptTag({ content:bundle.outputFiles[0].text });
      const bar = view.locator('.session-bar');
      if (scene === 'edited') {
        const git = bar.getByRole('button', {name:'Git: 1 changed files',exact:true});
        await git.waitFor();
        await git.click();
        const dialog = view.getByRole('dialog', {name:'Git',exact:true});
        await dialog.getByRole('tab', {name:/^Changes/}).waitFor();
        assert.ok((await view.evaluate(() => window.asked)).includes('/home/me/code/tool/src'), 'Git is read where the chat edited');
      } else {
        const git = bar.getByRole('button', {name:'Git',exact:true});
        await git.waitFor();
        await git.click();
        const dialog = view.getByRole('dialog', {name:'Git',exact:true});
        await dialog.getByText('This folder is not a Git project.').waitFor();
      }
      // No helpers yet: the bar still has Agents.
      await view.keyboard.press('Escape');
      await view.getByRole('dialog', {name:'Git',exact:true}).waitFor({state:'detached'});
      assert.equal(await bar.getByRole('button', {name:'Agents',exact:true}).count(), 1);
    } finally { await view.close(); }
  }
});

test('a terminal chat has the Git button and the full Agents panel', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SessionView } from './apps/web/src/session/SessionView';
    const env = { id:'git-term', name:'Laptop', online:true, info:{} };
    const session = { id:'term', title:'Terminal Claude', cwd:'/home/me/code/tool', engine:'claude', status:'idle', nativeCli:true, nativeChat:true };
    const client = { on: () => () => {}, subscribe: () => {}, input: async () => ({ ok:true }),
      rpc: async (env, method, params) => {
        if (method === 'model.list') return { models:[], modes:[] };
        if (method === 'session.commands') return { commands:[] };
        if (method === 'session.messages') return { messages:[] };
        if (method === 'agent.list') return { agents:[{ id:'claudes', engine:'claude', account:'a1', label:'Claude', available:true, auth:'authenticated', modes:[], shown:true }] };
        if (method === 'session.list') return { sessions:[session] };
        if (method === 'git.status') return { repo:true, root:'/home/me/code/tool', branch:'main', head:{commit:'abc'},
          files:[{path:'a.py',status:'M',add:1,del:0},{path:'b.py',status:'A',add:2,del:0}] };
        if (method === 'git.graph') return { repo:true, commits:[], worktrees:[] };
        if (method === 'git.pr') return { pr:null };
        return { ok:true };
      },
    };
    createRoot(document.getElementById('root')).render(<SessionView client={client} env={env} session={session} onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} />);
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true, write:false, format:'iife', jsx:'automatic' });
  const view = await browser.newPage({ viewport:{width:390,height:844} });
  view.setDefaultTimeout(10_000);
  try {
    await view.setContent('<div class="session" id="root"></div>');
    await view.addStyleTag({ content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'') });
    await view.addScriptTag({ content:bundle.outputFiles[0].text });
    const git = view.locator('.bar').getByRole('button', {name:'Git: 2 changed files',exact:true});
    await git.waitFor();
    await git.click();
    const gitSheet = view.getByRole('dialog', {name:'Git',exact:true});
    await gitSheet.getByRole('tab', {name:/^Changes/}).waitFor();
    await view.keyboard.press('Escape');
    await gitSheet.waitFor({ state:'detached' });
    // The same Agents panel as a Helm chat, with a task form, not a short list.
    // With no helpers yet it is still in the bar, as in a Helm chat.
    await view.locator('.bar').getByRole('button', {name:'Agents',exact:true}).click();
    await view.getByRole('dialog', {name:'Agents'}).getByRole('button', {name:/New task/}).waitFor();
  } finally { await view.close(); }
});
