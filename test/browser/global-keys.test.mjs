import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// Settings and usage from the keyboard, anywhere in the app; and the New
// session screen painting the agents it remembers before the machine answers.
let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Shell } from './apps/web/src/App';
    const token = 'helm1.' + btoa(JSON.stringify({net:'network',sub:'device'})) + '.test';
    window.mount = () => {
      const envs = ['laptop','vm'].map(id => ({id,name:id,online:true,info:{}}));
      window.calls = [];
      window.slowProfiles = false;
      const report = {totals:{},daily:[],groups:[],accounts:[],scan:{},at:Date.now()};
      const client = {token,relay:'http://helm-test',
        environments:async()=>({environments:envs}), on:()=>()=>{}, subscribe:()=>{}, watchLatency:()=>()=>{},
        openDirect:async()=>{}, directStatus:()=>({state:'not requested'}), route:async()=>null, usage:async()=>report,
        rpc:async(env,method,params)=>{
          window.calls.push({env,method,params});
          if(method==='session.list') return {sessions:env==='laptop'?[{id:'done1',title:'Yesterday work',cwd:'/work/yesterday',engine:'claude',profileId:'claude',driver:'claude',alive:true,status:'idle',turns:3,updatedAt:Date.now()-3600000}]:[]};
          if(method==='session.events') return {session:null,events:[],pending:[],last:0};
          if(method==='session.start'&&params.profileId==='shell') {
            if(window.failStart) throw new Error('could not reach that machine');
            if(window.holdStart) await new Promise(r=>{window.releaseStart=r;});
            return {session:{id:'sh1',title:'Terminal 1',cwd:params.cwd,engine:'shell',profileId:'shell',pty:true,alive:true,status:'shell'},attach:{text:'$ ',pty:true}};
          }
          if(method==='session.kill'&&window.holdKill) return new Promise(()=>{});
          if(method==='session.title'||method==='session.archive'||method==='session.kill') return {ok:true};
          if(method==='model.list') return {models:[],modes:[]};
          if(method==='fs.list') return {path:'/home/test',entries:[]};
          if(method==='fs.search') return {results:[]};
          if(method==='project.list') return {projects:[]};
          if(method==='usage.report') return {rows:[],buckets:[],total:{}};
          if(method==='profile.list') {
            if(window.slowProfiles) await new Promise(r=>setTimeout(r,60000));
            return {profiles:[{id:'claude',engine:'claude',cmd:'claude'}]};
          }
          return {};
        }};
      createRoot(document.getElementById('root')).render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}}/>);
    };
    window.visit = (selected, view) => {
      const state = {helm:1,selected,stack:[view],depth:1};
      history.pushState(state,'');
      dispatchEvent(new PopStateEvent('popstate',{state}));
    };
  `, resolveDir: process.cwd(), loader: 'tsx' }, plugins: [{name:'shell-export',setup(builder) {
    builder.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:await readFile(path,'utf8')+'\nexport { Shell };',loader:'tsx'}));
  }}], bundle:true,write:false,format:'iife',jsx:'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());

async function pageFor(t, context) {
  const ctx = context ?? await browser.newContext({viewport:{width:1280,height:900}});
  const page = await ctx.newPage();
  t.after(()=>page.close());
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await page.route('http://helm-test/**',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm-test/');
  // Settled starts folded; these tests read its rows, so it starts open here.
  await page.evaluate(() => localStorage.setItem('helm-fold:sidebar:settled-folded', '1'));
  await page.addScriptTag({content:script});
  await page.evaluate(()=>window.mount());
  await page.locator('.sidebar').waitFor();
  return page;
}

test('Ctrl+Shift+S opens Settings and Ctrl+Shift+4 ($) opens Usage from anywhere', async t => {
  const page = await pageFor(t);
  await page.keyboard.press('Control+Shift+s');
  await page.getByRole('heading',{name:'Settings'}).first().waitFor();
  await page.keyboard.press('Control+Shift+Digit4');
  await page.getByLabel('Machine', {exact:true}).waitFor({timeout:10000});
});

test('Ctrl+Shift+E opens a terminal in the open chat\'s folder, and goes back from it', async t => {
  const page = await pageFor(t);
  await page.evaluate(()=>window.visit('laptop',{kind:'session',session:{id:'done1',title:'Yesterday work',cwd:'/work/yesterday',engine:'claude',profileId:'claude',driver:'claude',alive:true,status:'idle'}}));
  await page.keyboard.press('Control+Shift+KeyE');
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.start'));
  const start = await page.evaluate(()=>window.calls.find(c=>c.method==='session.start'));
  assert.deepEqual([start.env, start.params.cwd, start.params.profileId], ['laptop', '/work/yesterday', 'shell']);
  // The first screen comes back with the start: no second trip for it.
  assert.ok(start.params.attach?.watcher && start.params.attach.cols > 0 && start.params.attach.rows > 0);
  await page.waitForFunction(()=>history.state?.stack?.at(-1)?.session?.id === 'sh1', null, {timeout:3000});
  await page.locator('.xterm').waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='session.attach').length), 0, 'the terminal asked for its screen again');
  await page.keyboard.press('Control+Shift+KeyE');
  await page.waitForFunction(()=>history.state?.stack?.at(-1)?.session?.id === 'done1', null, {timeout:3000});
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='session.start').length), 1, 'the key in a terminal starts nothing new');
});

test('a new terminal is on screen at once, and says why when it cannot open', async t => {
  const page = await pageFor(t);
  await page.evaluate(()=>{ window.holdStart = true; });
  await page.keyboard.press('Control+Alt+KeyT');
  await page.getByText(/Opening a terminal on/).waitFor({timeout:3000});
  await page.evaluate(()=>{ window.holdStart = false; window.releaseStart(); });
  await page.locator('.xterm').waitFor({timeout:3000});
  await page.evaluate(()=>{ window.failStart = true; });
  await page.getByRole('button',{name:'New terminal'}).click();
  await page.getByText('The terminal did not open.').waitFor({timeout:3000});
  assert.match(await page.locator('.terminal-opening-failed').innerText(), /Could not reach that machine/);
  await page.evaluate(()=>{ window.failStart = false; });
  await page.getByRole('button',{name:'Try again'}).click();
  await page.waitForFunction(()=>history.state?.stack?.at(-1)?.session?.id === 'sh1', null, {timeout:3000});
});

test('Ctrl+W closes a terminal at once, even when its machine is off and never answers', async t => {
  const page = await pageFor(t);
  await page.keyboard.press('Control+Alt+KeyT');
  await page.locator('.xterm').waitFor({timeout:3000});
  await page.evaluate(()=>{ window.holdKill = true; });
  await page.locator('.xterm textarea').focus();
  await page.keyboard.press('Control+KeyW');
  await page.waitForFunction(()=>history.state?.stack?.at(-1)?.session?.id !== 'sh1', null, {timeout:3000});
  assert.equal(await page.locator('.xterm').count(), 0, 'the terminal stayed on screen');
  assert.ok(await page.evaluate(()=>window.calls.some(c=>c.method==='session.kill'&&c.params.id==='sh1')), 'the machine was not told to close it');
});

test('Ctrl+B folds and unfolds the sidebar, and a terminal keeps the key', async t => {
  const page = await pageFor(t);
  const sidebar = page.locator('aside.sidebar');
  await page.keyboard.press('Control+KeyB');
  await page.waitForFunction(()=>document.querySelector('aside.sidebar').classList.contains('collapsed'));
  assert.equal(await page.evaluate(()=>localStorage.getItem('helm.sidebar-collapsed')), '1');
  await page.keyboard.press('Control+KeyB');
  await page.waitForFunction(()=>!document.querySelector('aside.sidebar').classList.contains('collapsed'));
  await page.keyboard.press('Control+Alt+KeyT');
  await page.locator('.xterm').waitFor({timeout:3000});
  await page.locator('.xterm textarea').focus();
  await page.keyboard.press('Control+KeyB');
  assert.equal(await sidebar.evaluate(el=>el.classList.contains('collapsed')), false, 'Ctrl+B in a terminal folded the sidebar');
});

test('Ctrl+Alt+S opens and closes Settled, and unfolds a folded sidebar to show it', async t => {
  const page = await pageFor(t);
  const settled = page.locator('aside.sidebar .fold-toggle', {hasText:'Settled'});
  const expanded = value => page.waitForFunction(v=>[...document.querySelectorAll('aside.sidebar .fold-toggle')]
    .find(b=>b.textContent.includes('Settled'))?.getAttribute('aria-expanded') === v, value);
  await expanded('true');
  await page.keyboard.press('Control+Alt+KeyS');
  await expanded('false');
  await page.keyboard.press('Control+Alt+KeyS');
  await expanded('true');
  await page.keyboard.press('Control+Alt+KeyS');
  await expanded('false');
  await page.keyboard.press('Control+KeyB');
  await page.waitForFunction(()=>document.querySelector('aside.sidebar').classList.contains('collapsed'));
  await page.keyboard.press('Control+Alt+KeyS');
  await page.waitForFunction(()=>!document.querySelector('aside.sidebar').classList.contains('collapsed'));
  await expanded('true');
  await settled.waitFor({state:'visible'});
});

test('the shortcuts list names both keys', async t => {
  const page = await pageFor(t);
  await page.keyboard.press('Control+Slash');
  const text = await page.locator('.shortcuts').innerText();
  assert.match(text, /Settings/);
  assert.match(text, /Show usage, limits, and cost/);
  assert.match(text, /Open a terminal/);
  assert.match(text, /Show or hide the sidebar/);
  assert.match(text, /Open or close Settled/);
});

test('bare keys open nothing: every shortcut needs Ctrl/Cmd', async t => {
  const page = await pageFor(t);
  await page.keyboard.press('?');
  await page.keyboard.press('/');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.shortcuts').count(), 0, 'a bare "?" opened the key list');
  assert.equal(await page.locator('.palette-box').count(), 0, 'a bare "/" opened search');
});

test('New session paints the agents it remembers before a slow machine answers', async t => {
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  t.after(()=>context.close());
  // First visit: the machine answers, and the list is remembered on the device.
  const first = await pageFor(t, context);
  await first.evaluate(()=>window.visit('vm',{kind:'start',cwd:'/work/project'}));
  await first.locator('.row.tall').filter({hasText:'Claude'}).first().waitFor();
  await first.waitForFunction(()=>window.calls.some(c=>c.method==='profile.list'));
  await new Promise(r=>setTimeout(r,200));
  await first.close();
  // Second visit: the machine takes a minute; the list is there at once.
  const second = await pageFor(t, context);
  await second.evaluate(()=>{ window.slowProfiles = true; });
  await second.evaluate(()=>window.visit('vm',{kind:'start',cwd:'/work/project'}));
  await second.locator('.row.tall').filter({hasText:'Claude'}).first().waitFor({timeout:3000});
});

test('the sidebar rows have the same ⋯ menu as the machine screen: rename, archive, delete', async t => {
  const page = await pageFor(t);
  // Settled is open to begin with; its first rows are on show.
  const row = page.locator('.sidebar .tri-row').filter({hasText:'Yesterday work'});
  await row.waitFor({timeout:5000});
  await row.getByRole('button',{name:'Show actions for Yesterday work'}).click({force:true});
  await page.getByRole('button',{name:'Archive chat'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Rename chat'}).count(),1);
  await page.getByRole('button',{name:'Delete chat'}).click();
  await page.getByRole('button',{name:'Delete',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.kill'&&c.params.id==='done1'));
});
