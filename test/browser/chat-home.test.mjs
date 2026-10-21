import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// The empty chat (a question over a centred composer), the chat header (a
// path with the title last to be cut) and the machine's home screen.
let browser, script;
const shot = (page, name) => process.env.HELM_TEST_SCREENSHOT_DIR && page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, name) });
const LONG = "ok i am tired Whenever I'm using the app on my phone the title and the machine name get cut off at the top";

before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Shell } from './apps/web/src/App';
    const token = 'helm1.' + btoa(JSON.stringify({net:'network',sub:'device'})) + '.test';
    const now = Date.now();
    const mk = (id, title, cwd, extra = {}) => ({id, title, cwd, engine:'claude', profileId:'claude', driver:'claude',
      alive:true, status:'idle', turns:2, updatedAt:now - 3600e3, ...extra});
    window.sessions = {
      fresh: mk('fresh', 'New chat', '/work/project', {turns:0, model:'opus'}),
      long: mk('long', ${JSON.stringify(LONG)}, '/work/helm-mobile-app', {costUsd:15.29, updatedAt:now - 60e3}),
      run1: mk('run1', 'Fix the sidebar scroll', '/work/helm', {status:'working', updatedAt:now - 20e3}),
      run2: mk('run2', 'Port the importer', '/work/project', {status:'working', engine:'codex', profileId:'codex', driver:'codex', updatedAt:now - 90e3}),
      old1: mk('old1', 'Tidy the release notes', '/work/helm', {updatedAt:now - 5 * 3600e3}),
      old2: mk('old2', 'Why is CI red', '/work/project', {updatedAt:now - 26 * 3600e3}),
      old3: mk('old3', 'Rename the daemon', '/work/helm', {updatedAt:now - 30 * 3600e3}),
      old4: mk('old4', 'Try the new theme', '/work/helm', {updatedAt:now - 50 * 3600e3}),
      old5: mk('old5', 'Check the logs', '/work/project', {updatedAt:now - 70 * 3600e3}),
    };
    window.mount = () => {
      const envs = ['laptop','vm'].map(id => ({id,name:id === 'laptop' ? 'Laptop' : 'vm',online:true,info:{}}));
      window.calls = [];
      const client = {token,relay:'http://helm-test',
        environments:async()=>({environments:envs}), on:()=>()=>{}, subscribe:()=>{}, watchLatency:()=>()=>{},
        openDirect:async()=>{}, route:async()=>null,
        input:(env,params)=>client.rpc(env,'session.input',params),
        rpc:async(env,method,params)=>{
          window.calls.push({env,method,params});
          if(method==='session.list') return {sessions:env==='laptop'?Object.values(window.sessions):[]};
          if(method==='session.events') {
            const session = window.sessions[params.id] ?? window.sessions.fresh;
            const events = params.id === 'long' ? [
              {seq:1,type:'turn.start',at:1,turnId:'t1',text:'hello'},
              {seq:2,type:'item.start',at:2,id:'r1',turnId:'t1',kind:'text'},
              {seq:3,type:'item.delta',at:3,id:'r1',text:'Hi there.'},
            ] : [];
            return {events,pending:[],last:events.length,logFirst:events.length ? 1 : 0,firstSeq:events.length ? 1 : 0,session};
          }
          if(method==='session.watch') return {last:0};
          if(method==='model.list') return {models:[],modes:[]};
          if(method==='git.status') return {repo:false,files:[]};
          if(method==='fs.search') return {results:[]};
          if(method==='fs.list') return {path:'/home/test',entries:[{name:'project',path:'/work/project',isDir:true}]};
          if(method==='project.list') return {projects:[
            {path:'/work/project',title:'project'},{path:'/work/helm',title:'helm'},{path:'/work/empty',title:'empty-one'}]};
          if(method==='profile.list') return {profiles:[{id:'claude',engine:'claude',cmd:'claude'}]};
          if(method==='session.title') { window.sessions[params.id] = {...window.sessions[params.id], title:params.title}; return {session:window.sessions[params.id]}; }
          return {};
        }};
      createRoot(document.getElementById('root')).render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}}/>);
    };
    window.visit = (selected, view) => {
      const state = {helm:1,selected,stack:[view],depth:1};
      history.pushState(state,'');
      dispatchEvent(new PopStateEvent('popstate',{state}));
    };
    window.open = (id) => window.visit('laptop', {kind:'session', session: window.sessions[id]});
  `, resolveDir: process.cwd(), loader: 'tsx' }, plugins: [{name:'shell-export',setup(builder) {
    builder.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:await readFile(path,'utf8')+'\nexport { Shell };',loader:'tsx'}));
  }}], bundle:true,write:false,format:'iife',jsx:'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());

async function pageFor(t, width) {
  const page = await browser.newPage({viewport:{width,height:844}});
  t.after(()=>page.close());
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await page.route('http://helm-test/**',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm-test/');
  await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
  await page.addScriptTag({content:script});
  await page.evaluate(()=>window.mount());
  await page.locator('.sidebar').waitFor();
  return page;
}
const noSideways = page => page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);

for (const width of [1280,390]) test(`an empty chat asks what to build and keeps the composer mid-page, then docks it on the first message, at ${width}px`,async t=>{
  const page=await pageFor(t,width);
  await page.evaluate(()=>window.open('fresh'));
  const hero=page.locator('.empty-chat');
  await hero.waitFor();
  assert.equal((await hero.locator('h2').innerText()).replace(/\s+/g,' '),'What should we build in project?');
  const folder=hero.locator('.empty-chat-folder');
  assert.equal(await folder.innerText(),'project');
  assert.equal(await folder.getAttribute('title'),'/work/project');
  assert.match(await hero.locator('.empty-chat-sub').innerText(),/^Laptop · Claude Code · opus$/);
  assert.equal(await page.locator('.chat-wrap').isVisible(),false,'the empty conversation steps aside');

  const dock=page.locator('.composer-wrap');
  const middle=await dock.evaluate(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,h:innerHeight};});
  assert.ok(middle.top>middle.h*0.3&&middle.bottom<middle.h-20,`the composer floats mid-page, not on the bottom edge (${JSON.stringify(middle)})`);
  assert.ok(await noSideways(page),'no sideways scroll');
  await page.waitForTimeout(400);
  await shot(page,`empty-chat-${width}.png`);

  await page.getByLabel(/^Message/).fill('build me a thing');
  await page.getByRole('button',{name:'send',exact:true}).click();
  await hero.waitFor({state:'detached'});
  await page.waitForTimeout(400);
  const after=await dock.evaluate(el=>{const r=el.getBoundingClientRect();return {bottom:r.bottom,h:innerHeight};});
  assert.ok(after.h-after.bottom<24,`the composer is on the bottom dock again (${JSON.stringify(after)})`);
  await page.locator('.chat-wrap').waitFor();
});

test('a chat that already has messages never shows the greeting',async t=>{
  const page=await pageFor(t,1280);
  await page.evaluate(()=>window.open('long'));
  await page.getByText('Hi there.').waitFor();
  assert.equal(await page.locator('.empty-chat').count(),0);
});

for (const width of [1280,390]) test(`the header is a path with the title last to be cut: folder / title, machine and cost beneath, at ${width}px`,async t=>{
  const page=await pageFor(t,width);
  await page.evaluate(()=>window.open('long'));
  const bar=page.locator('.session-bar');
  await bar.waitFor();
  const title=bar.locator('h1');
  assert.equal(await title.innerText(),LONG);
  assert.equal(await title.getAttribute('title'),LONG,'hovering shows the whole title');
  assert.equal(await bar.locator('.crumb-folder').innerText(),'helm-mobile-app');
  const sub=(await bar.locator('.sub').innerText()).replace(/\s+/g,' ');
  assert.match(sub,/^Laptop · \$15\.29/,'machine first, then the cost');
  // The title keeps more room than the folder.
  const room=await bar.evaluate(el=>({folder:el.querySelector('.crumb-folder').getBoundingClientRect().width,title:el.querySelector('h1').getBoundingClientRect().width}));
  assert.ok(room.title>room.folder*2,`the title gets the room (${JSON.stringify(room)})`);
  assert.ok(await noSideways(page),'no sideways scroll');
  for (const name of ['Agents','more','Back']) assert.ok(await bar.getByRole('button',{name,exact:true}).isVisible(),`${name} is still there`);
  await shot(page,`header-long-title-${width}.png`);
});

test('double-clicking the title renames the thread; Escape leaves it alone',async t=>{
  const page=await pageFor(t,1280);
  await page.evaluate(()=>window.open('long'));
  const bar=page.locator('.session-bar');
  await bar.locator('h1').dblclick();
  const box=bar.getByRole('textbox',{name:'Chat name'});
  await box.fill('Something else');
  await box.press('Escape');
  await bar.locator('h1').waitFor();
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='session.title')),false);
  await bar.locator('h1').dblclick();
  await box.fill('Calmer title');
  await box.press('Enter');
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.title'&&c.params.title==='Calmer title'&&c.params.id==='long'));
  await bar.getByRole('button',{name:'more',exact:true}).click();
  await page.getByRole('button',{name:'Rename chat'}).waitFor();
});

for (const width of [1280,390]) test(`a machine's home asks what to build, lists what runs here and what was recent, and files projects by last activity, at ${width}px`,async t=>{
  const page=await pageFor(t,width);
  await page.evaluate(()=>window.visit('laptop',{kind:'env'}));
  const main=page.locator('.main');
  const title=main.locator('.home-title');
  await title.waitFor();
  assert.equal((await title.innerText()).replace(/\s+/g,' '),'What should we build on Laptop?');
  assert.match(await main.locator('.home-state').innerText(),/^online · 2 running/);
  // The way in is a wide button that starts a chat; the rarer errands stay reachable.
  await main.getByRole('button',{name:'New chat',exact:true}).waitFor();
  await main.getByRole('button',{name:'Send a project',exact:true}).waitFor();
  await main.getByRole('button',{name:/Connectors & skills/}).waitFor();

  const running=main.locator('div.section',{hasText:/^Running$/}).locator('xpath=following-sibling::div[1]');
  assert.deepEqual((await running.locator('.rt').allInnerTexts()).sort(),['Fix the sidebar scroll','Port the importer']);
  const recent=main.locator('div.section',{hasText:/^recent$/}).locator('xpath=following-sibling::div[1]');
  assert.equal(await recent.locator('.rowx').count(),5,'five recent chats');

  // Folders say when they last moved; an empty one shows no meaningless 0.
  const folders=main.locator('.fold-toggle').filter({has:page.locator('.foldicon')});
  await folders.first().waitFor();
  const helm=folders.filter({hasText:'helm'}).first();
  assert.match(await helm.locator('.note-inline').innerText(),/ago|just now/);
  const empty=folders.filter({hasText:'empty-one'});
  assert.equal(await empty.locator('.count').count(),0);
  assert.doesNotMatch(await main.locator('.scroll').innerText(),/\b0\b(?!\s*ms)/,'no zero counts');
  assert.ok(await noSideways(page),'no sideways scroll');
  await shot(page,`machine-home-${width}.png`);

  await main.getByRole('button',{name:'New chat',exact:true}).click();
  await page.getByRole('dialog',{name:'New chat'}).waitFor();
  assert.match(await page.locator('.newchat-greeting').innerText(),/^Pick a folder on/);
  await shot(page,`new-chat-picker-${width}.png`);
});
