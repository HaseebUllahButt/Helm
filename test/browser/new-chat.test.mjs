import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Shell } from './apps/web/src/App';
    const token = 'helm1.' + btoa(JSON.stringify({net:'network',sub:'device'})) + '.test';
    window.mount = (ids = ['laptop','vm']) => {
      const envs = ids.map(id => ({id,name:id,online:true,info:{}}));
      const session = {id:'native',title:'Current chat',cwd:'/work/current',engine:'gemini',profileId:'claude',
        nativeCli:true,pty:true,shared:true,alive:true,status:'idle',turns:1,updatedAt:Date.now()};
      const quick = {id:'quickone',title:'Quick question',cwd:'/home/test/.helm/quick/quickone',quick:true,engine:'claude',
        profileId:'claude',driver:'claude',alive:true,status:'working',turns:1,updatedAt:Date.now()-60000};
      window.calls = [];
      const client = {input:(env,params)=>client.rpc(env,'session.input',params),token,relay:'http://helm-test',
        environments:async()=>({environments:envs}), on:()=>()=>{}, subscribe:()=>{}, watchLatency:()=>()=>{},
        openDirect:async()=>{}, directStatus:()=>({state:'not requested'}), route:async()=>null,
        rpc:async(env,method,params)=>{
          window.calls.push({env,method,params});
          if(method==='session.list') return {sessions:env==='laptop'?[session,quick]:[]};
          if(method==='session.events' && params.id==='fresh') return {session:{status:'idle'},events:[],pending:[],last:0};
          if(method==='session.events') return {session:quick,events:[],pending:[],last:0};
          if(method==='session.watch') return {last:0};
          if(method==='model.list') return {models:[],modes:[]};
          if(method==='git.status') return {repo:true,files:[]};
          if(method==='fs.search') return {results:[]};
          // A machine that sends its folder list: searched on the device.
          if(method==='fs.index' && window.folders) return window.folders(params);
          // The machine's own checks on a folder name (fs.js makeDir).
          if(method==='fs.mkdir') {
            if(params.name.includes('/')) throw new Error('folder name cannot contain a path separator');
            if(params.name==='..') throw new Error('invalid folder name');
            return {path:params.path+'/'+params.name};
          }
          if(method==='session.attach') return {pty:true,text:'Ready'};
          if(method==='session.messages') return {messages:[]};
          if(method==='fs.list') return params.path==='~'
            ? {path:'/home/test',entries:[{name:'project',path:'/work/project',isDir:true}]}
            : {path:params.path,entries:[{name:'existing',path:params.path+'/existing',isDir:true}]};
          if(method==='project.list') return {projects:[]};
          if(method==='profile.list') return window.profileList ?? {profiles:[{id:'claude',engine:'claude',cmd:'claude'}]};
          if(method==='session.start' && window.startGate) await window.startGate(params);
          if(method==='session.start') return {session:{...session,id:'fresh',cwd:params.quick?'/home/test/.helm/quick/fresh':params.cwd,quick:params.quick,nativeCli:false,pty:false,...window.startAs}};
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

async function pageFor(t, saved, { machines, ...options } = {}) {
  const page = await browser.newPage({viewport:{width:1280,height:900}, ...options});
  t.after(()=>page.close());
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  t.after(()=>assert.deepEqual(errors,[]));
  await page.route('http://helm-test/**',route=>route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>'}));
  await page.goto('http://helm-test/');
  if(saved) await page.evaluate(saved=>localStorage.setItem('helm.last-folder:network:device',JSON.stringify(saved)),saved);
  await page.addScriptTag({content:script});
  await page.evaluate((machines)=>window.mount(machines),machines);
  await page.locator('.sidebar').waitFor();
  return page;
}

test('one machine online skips the machine step and asks for a folder straight away',async t=>{
  const page=await pageFor(t,null,{machines:['laptop']});
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('combobox',{name:'Search folders on laptop'}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Search machines'}).count(),0);
  await page.getByRole('option').filter({hasText:'No folder'}).click();
  await startPickedChat(page,{envId:'laptop',folder:undefined});
});

async function startPickedChat(page, expected) {
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  await page.getByRole('option').filter({hasText:'Claude'}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.start'));
  const call = await page.evaluate(()=>window.calls.find(c=>c.method==='session.start'));
  assert.equal(call.env,expected.envId);
  assert.equal(call.params.cwd,expected.folder);
}

test('Ctrl+Shift+N starts in the active chat directory from a focused terminal',async t=>{
  const page=await pageFor(t,{envId:'vm',folder:'/old/folder'});
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Current chat');
  await page.getByRole('option').filter({hasText:'Current chat'}).click();
  const terminal=page.locator('.xterm-helper-textarea');
  await terminal.waitFor();
  await terminal.press('Control+Shift+n');
  await startPickedChat(page,{envId:'laptop',folder:'/work/current'});
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='session.input')),false);
});

test('Ctrl+Shift+N remembers a browsed directory and its machine after leaving it',async t=>{
  const page=await pageFor(t);
  await page.evaluate(()=>window.visit('vm',{kind:'new',path:'/work/browsed'}));
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('helm.last-folder:network:device'))?.folder==='/work/browsed');
  // A generic new-chat picker already open must switch to the contextual picker.
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('combobox',{name:'Search machines'}).waitFor();
  await page.keyboard.press('Control+Shift+n');
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.visit('laptop',{kind:'app-settings'}));
  await page.keyboard.press('Control+Shift+n');
  await startPickedChat(page,{envId:'vm',folder:'/work/browsed'});
});

test('Ctrl+Shift+N restores the last directory on a fresh app open',async t=>{
  const page=await pageFor(t,{envId:'vm',folder:'/saved/project'});
  await page.keyboard.press('Control+Shift+n');
  await startPickedChat(page,{envId:'vm',folder:'/saved/project'});
});

test('Ctrl+Shift+N without any previous directory opens the normal picker',async t=>{
  const page=await pageFor(t);
  await page.keyboard.press('Control+Shift+n');
  await page.getByRole('combobox',{name:'Search machines'}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Search agents'}).count(),0);
});

test('Ctrl+Shift+N remembers a folder chosen in the new-chat picker',async t=>{
  const page=await pageFor(t);
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('option').filter({hasText:'vm'}).click();
  await page.getByRole('option').filter({hasText:'project'}).click();
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+n');
  await startPickedChat(page,{envId:'vm',folder:'/work/project'});
});

/** Open the new-chat box on the vm's folder step. */
async function folderStep(page) {
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('option').filter({hasText:'vm'}).click();
  const box=page.getByRole('combobox',{name:'Search folders on vm'});
  await box.waitFor();
  await page.getByRole('option').filter({hasText:'project'}).waitFor();
  return box;
}
const startCall = (page) => page.evaluate(()=>window.calls.find(c=>c.method==='session.start'));

test('a new chat opens at once while its agent starts, and what you send then goes in when it is up',async t=>{
  const page=await pageFor(t);
  await page.evaluate(()=>{ window.startGate=()=>new Promise((ok,fail)=>{ window.release=ok; window.refuse=fail; }); });
  await folderStep(page);
  await page.getByRole('option').filter({hasText:'project'}).click();
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  await page.keyboard.press('Enter');
  // The picker is gone and the chat is there, saying it is starting.
  await page.locator('.chip.working').filter({hasText:'starting'}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Search agents'}).count(),0);
  assert.match(await page.locator('.session-bar').innerText(),/project/);
  const box=page.getByRole('textbox',{name:/^Message /});
  await box.fill('hello there');
  await box.press('Enter');
  await page.locator('.turn.user').filter({hasText:'hello there'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='session.input')),false);
  await page.evaluate(()=>window.release());
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.input'));
  const input=await page.evaluate(()=>window.calls.find(c=>c.method==='session.input'));
  assert.deepEqual({env:input.env,id:input.params.id,data:input.params.data},{env:'vm',id:'fresh',data:'hello there'});
  await page.locator('.chip.working').filter({hasText:'starting'}).waitFor({state:'detached'});
  await page.locator('.main h1').filter({hasText:'Current chat'}).waitFor();
});

test('a new chat stays on one steady empty page from starting to ready',async t=>{
  const page=await pageFor(t);
  // A chat helm drives itself, as a real Claude start is.
  await page.evaluate(()=>{ window.startGate=()=>new Promise(ok=>{ window.release=ok; }); window.startAs={driver:'claude',engine:'claude',title:'project'}; });
  await folderStep(page);
  await page.getByRole('option').filter({hasText:'project'}).click();
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  await page.keyboard.press('Enter');
  await page.locator('[data-empty-chat]').waitFor();
  // The row under the box that the live chat has, so the box does not move.
  assert.equal(await page.locator('.composer-wrap .slab-status').count(),1);
  // Every frame from here: the empty page must never leave, nor fade in again.
  await page.evaluate(()=>{
    window.flicker=[];
    let shown=document.querySelector('[data-empty-chat]');
    const watch=()=>{
      const now=document.querySelector('[data-empty-chat]');
      if(!now) window.flicker.push('gone');
      // No stylesheet here, so the fade itself never runs: what turns it off has to be there.
      else if(now!==shown && !now.classList.contains('still')) window.flicker.push('faded in again');
      shown=now ?? shown;
      if(window.watching) requestAnimationFrame(watch);
    };
    window.watching=true; requestAnimationFrame(watch);
  });
  await page.evaluate(()=>window.release());
  await page.locator('.chip.working').filter({hasText:'starting'}).waitFor({state:'detached'});
  await page.getByRole('button',{name:'more',exact:true}).waitFor();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.events' && c.params.id==='fresh'));
  await page.waitForTimeout(400);
  await page.evaluate(()=>{ window.watching=false; });
  assert.deepEqual(await page.evaluate(()=>[...new Set(window.flicker)]),[]);
  assert.match(await page.locator('[data-empty-chat]').innerText(),/What should we build in project\?/);
  assert.equal(await page.locator('.composer-wrap .slab-status').count(),1);
});

test('an agent that fails to start says why, keeps what you wrote, and can be tried again',async t=>{
  const page=await pageFor(t);
  await page.evaluate(()=>{ window.startGate=()=>new Promise((ok,fail)=>{ window.release=ok; window.refuse=fail; }); });
  await folderStep(page);
  await page.getByRole('option').filter({hasText:'project'}).click();
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  await page.keyboard.press('Enter');
  const box=page.getByRole('textbox',{name:/^Message /});
  await box.fill('keep me');
  await page.evaluate(()=>window.refuse(new Error('claude is not logged in')));
  await page.getByRole('alert').filter({hasText:'claude is not logged in'}).waitFor();
  assert.equal(await box.inputValue(),'keep me');
  await page.getByRole('button',{name:'Try again'}).click();
  await page.locator('.chip.working').filter({hasText:'starting'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='session.start').length),2);
  await page.evaluate(()=>window.release());
  await page.locator('.main h1').filter({hasText:'Current chat'}).waitFor();
  // Never sent, so it becomes the chat's own draft.
  assert.equal(await page.evaluate(()=>localStorage.getItem('helm-draft:vm:fresh')),'keep me');
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='session.input')),false);
});

test('the folder step starts with a quick-chat row, and Enter on it skips the folder',async t=>{
  const page=await pageFor(t);
  await folderStep(page);
  const first=page.getByRole('option').first();
  assert.equal(await first.locator('.palette-title').innerText(),'No folder · quick chat');
  assert.equal(await first.getAttribute('aria-selected'),'true');
  await page.keyboard.press('Enter');
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  assert.equal(await page.locator('.newchat-steps .on').innerText(),'Agent');
  assert.match(await page.locator('.newchat-steps').innerText(),/Quick chat/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.start'));
  const call=await startCall(page);
  assert.deepEqual({env:call.env,quick:call.params.quick,cwd:call.params.cwd},{env:'vm',quick:true,cwd:undefined});
  // A quick chat is never remembered as "the last folder".
  assert.equal(await page.evaluate(()=>localStorage.getItem('helm.last-folder:network:device')),null);
});

test('Ctrl+Enter at the folder step is a quick chat; at the machine step it does nothing',async t=>{
  const page=await pageFor(t);
  await page.keyboard.press('Control+Shift+o');
  await page.getByRole('combobox',{name:'Search machines'}).waitFor();
  await page.keyboard.press('Control+Enter');
  await page.keyboard.press('Control+Shift+Enter');
  assert.equal(await page.getByRole('combobox',{name:'Search machines'}).count(),1);
  await page.keyboard.press('Escape');
  const box=await folderStep(page);
  await box.fill('pro');
  await page.keyboard.press('Control+Enter');
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  // Back lands on the folder step again, with what was typed still there.
  await page.keyboard.press('Backspace');
  await page.getByRole('combobox',{name:'Search folders on vm'}).waitFor();
  assert.equal(await box.inputValue(),'pro');
  await box.fill('');
  await page.getByRole('option').filter({hasText:'project'}).click();
  await startPickedChat(page,{envId:'vm',folder:'/work/project'});
  assert.equal((await startCall(page)).params.quick,undefined);
});

test('a typed name that is not a folder offers a new-folder row that makes it and picks it',async t=>{
  const page=await pageFor(t);
  const box=await folderStep(page);
  await box.fill('fresh');
  const make=page.getByRole('option').last();
  await make.filter({hasText:'Create folder "fresh" in home'}).waitFor();
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
  if (process.env.HELM_TEST_SCREENSHOT_DIR) for (const width of [1280,390]) {
    await page.setViewportSize({width,height:844});
    await page.screenshot({path:`${process.env.HELM_TEST_SCREENSHOT_DIR}/new-chat-folder-${width}.png`});
  }
  assert.equal(await make.locator('.palette-sub').innerText(),'~/fresh');
  await page.keyboard.press('ArrowDown');
  assert.equal(await make.getAttribute('aria-selected'),'true');
  await page.keyboard.press('Enter');
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  const mkdir=await page.evaluate(()=>window.calls.find(c=>c.method==='fs.mkdir'));
  assert.deepEqual(mkdir,{env:'vm',method:'fs.mkdir',params:{path:'~',name:'fresh'}});
  assert.match(await page.locator('.newchat-steps').innerText(),/fresh/);
  // The home list learned it: back with an empty box shows it.
  await page.keyboard.press('Backspace');
  await box.fill('');
  await page.getByRole('option').filter({hasText:/^fresh$/}).waitFor();
  await page.getByRole('option').filter({hasText:/^fresh$/}).click();
  await startPickedChat(page,{envId:'vm',folder:'~/fresh'});
});

test('Ctrl+Shift+Enter makes the folder beside the highlighted one, or inside it once opened',async t=>{
  const page=await pageFor(t);
  const box=await folderStep(page);
  // Cursor on "project" (closed), past "Clone from GitHub": the new folder goes beside it.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await box.fill('beside');
  await page.getByRole('option').filter({hasText:'Create folder "beside" in work'}).waitFor();
  assert.equal(await page.getByRole('option').last().locator('.palette-sub').innerText(),'/work/beside');
  // Opened with →: inside it.
  await box.fill('');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await box.fill('inner');
  await page.getByRole('option').filter({hasText:'Create folder "inner" in project'}).waitFor();
  await page.keyboard.press('Control+Shift+Enter');
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  const mkdir=await page.evaluate(()=>window.calls.filter(c=>c.method==='fs.mkdir'));
  assert.deepEqual(mkdir.map(c=>c.params),[{path:'/work/project',name:'inner'}]);
  await startPickedChat(page,{envId:'vm',folder:'/work/project/inner'});
});

test('a name the machine refuses is explained in the box and nothing starts',async t=>{
  const page=await pageFor(t);
  const box=await folderStep(page);
  await box.fill('a/b');
  await page.getByRole('option').filter({hasText:'Create folder "a/b"'}).waitFor();
  await page.keyboard.press('Control+Shift+Enter');
  await page.locator('.newchat .error').filter({hasText:'folder name cannot contain a path separator'}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Search folders on vm'}).count(),1);
  // Not offered for a folder that is already there.
  await box.fill('');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.getByRole('option').filter({hasText:'existing'}).waitFor();
  await box.fill('existing');
  await page.getByText('No folder matches.').waitFor();
  assert.equal(await page.getByRole('option').filter({hasText:'New folder'}).count(),0);
});

test('the palette opens a quick chat on the machine on screen',async t=>{
  const page=await pageFor(t);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Quick chat');
  await page.getByRole('option').filter({hasText:'Ask a short question without a folder.'}).click();
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.start'));
  const call=await startCall(page);
  assert.deepEqual({env:call.env,quick:call.params.quick},{env:'laptop',quick:true});
});

for (const width of [1280,390]) test(`a quick chat says "quick chat" where the folder goes, with no Git, at ${width}px`,async t=>{
  const page=await pageFor(t);
  await page.setViewportSize({width,height:844});
  await page.evaluate(()=>window.visit('laptop',{kind:'env'}));
  const row=page.locator('.thread-row').filter({hasText:'Quick question'}).first();
  await row.waitFor();
  assert.equal(await row.locator('.tri-where').innerText(),'quick chat · laptop');
  assert.equal(await row.locator('.tri-branch').count(),0);
  await row.click();
  const bar=page.locator('.session-bar');
  await bar.waitFor();
  assert.match(await bar.locator('.sub').innerText(),/laptop\s*· quick chat/);
  assert.doesNotMatch(await bar.innerText(),/quickone|\.helm/);
  // Git is always in the header; a quick chat's Git sheet says why it is empty.
  assert.equal(await bar.getByRole('button',{name:/^Git/}).count(),1);
  assert.equal(await page.evaluate(()=>window.calls.some(c=>c.method==='git.status')),false);
  await bar.getByRole('button',{name:'more'}).click();
  assert.equal(await page.getByRole('button',{name:'Send to another machine'}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Rename chat'}).count(),1);
});

test('with the machine\'s folder list, typing searches on the device and shows how fresh it is',async t=>{
  const page=await pageFor(t);
  await page.evaluate(()=>{
    window.folders=(params)=>({stamp:'s1',at:Date.now()-30_000,count:4,building:false,
      ...(params.since==='s1' && !params.refresh ? {unchanged:true} : {names:['dev','helm','intercept','notes'],parents:[-1,0,0,2],repos:[1]})});
  });
  const box=await folderStep(page);
  await page.locator('.newchat-index').filter({hasText:'checked 30s ago'}).waitFor();
  await box.fill('inter');
  await page.getByRole('option').filter({hasText:'~/dev/intercept'}).first().waitFor();
  await box.fill('inter notes');
  await page.getByRole('option').filter({hasText:'~/dev/intercept/notes'}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='fs.search').length),0,'never asks per keystroke');
  // The refresh button makes the machine look at its disk again.
  await page.getByRole('button',{name:'Look for new folders now'}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='fs.index' && c.params.refresh===true));
});

test('New folder is always offered below the list, and on each folder row as a +',async t=>{
  const page=await pageFor(t);
  await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
  const box=await folderStep(page);
  // Nothing typed, cursor nowhere: home.
  await page.getByRole('button',{name:/^New folder in home$/}).click();
  const name=page.getByRole('textbox',{name:/New folder name, in ~/});
  await name.fill('scratch');
  if (process.env.HELM_TEST_SCREENSHOT_DIR) for (const width of [1280,390]) {
    await page.setViewportSize({width,height:844});
    await page.screenshot({path:`${process.env.HELM_TEST_SCREENSHOT_DIR}/new-chat-create-${width}.png`});
  }
  await page.setViewportSize({width:1280,height:900});
  // Esc puts it away without making anything.
  await name.press('Escape');
  await page.getByRole('button',{name:/^New folder in home$/}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='fs.mkdir').length),0);
  // The + on a folder row aims inside that folder, even deep in the tree.
  await page.getByRole('option').filter({hasText:/^project$/}).hover();
  await page.getByRole('button',{name:'Create a folder inside project'}).click();
  await page.getByRole('option').filter({hasText:/^existing$/}).waitFor();
  await page.getByRole('option').filter({hasText:/^existing$/}).hover();
  await page.getByRole('button',{name:'Create a folder inside existing'}).click();
  const deep=page.getByRole('textbox',{name:'New folder name, in /work/project/existing'});
  await deep.fill('deeper');
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.HELM_TEST_SCREENSHOT_DIR}/new-chat-create-deep.png`});
  await deep.press('Enter');
  await page.getByRole('combobox',{name:'Search agents'}).waitFor();
  const mkdir=await page.evaluate(()=>window.calls.filter(c=>c.method==='fs.mkdir').map(c=>c.params));
  assert.deepEqual(mkdir,[{path:'/work/project/existing',name:'deeper'}]);
  await startPickedChat(page,{envId:'vm',folder:'/work/project/existing/deeper'});
  void box;
});

async function hiddenPicker(page, { local = false, all = false } = {}) {
  await page.evaluate(({ local, all }) => {
    const hidden = all ? ['visible', 'hidden-personal', 'hidden-other'] : ['hidden-personal', 'hidden-other'];
    window.profileList = {
      profiles: [
        { id: 'codex', engine: 'codex', cmd: 'codex', account: 'visible' },
        { id: 'claude-personal', engine: 'claude', cmd: 'claude', account: 'hidden-personal', env: { CLAUDE_CONFIG_DIR: '~/.claude-personal' }, defaults: { effort: 'high', mode: 'auto' } },
        { id: 'grok', engine: 'grok', cmd: 'grok', account: 'hidden-other' },
      ],
      ...(local ? {} : { picker: { hidden, last: 'visible', agent: 'visible' } }),
    };
    if (local) localStorage.setItem('helm.prefs', JSON.stringify({ vm: { hidden, account: 'visible' } }));
  }, { local, all });
  await page.keyboard.press('Control+Shift+n');
  await page.getByRole('combobox', { name: 'Search agents' }).waitFor();
  await page.getByRole('option', { name: /^Show \d+ hidden agents/ }).waitFor();
}

for (const width of [1280, 390]) test(`hidden CLIs can be used once without unhiding them at ${width}px`, async t => {
  const page = await pageFor(t, { envId: 'vm', folder: '/work/project' });
  await page.setViewportSize({ width, height: 844 });
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await hiddenPicker(page);
  assert.equal(await page.getByRole('option').count(), 2);
  assert.equal(await page.locator('.newchat-bar').count(), 0);
  if (process.env.HELM_TEST_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.HELM_TEST_SCREENSHOT_DIR}/shown-cli-${width}.png` });
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    await page.screenshot({ path: `${process.env.HELM_TEST_SCREENSHOT_DIR}/shown-cli-light-${width}.png` });
    await page.evaluate(() => delete document.documentElement.dataset.theme);
  }
  await page.getByRole('option', { name: 'Show 2 hidden agents', exact: true }).click();
  await page.getByText('Hidden agents', { exact: true }).waitFor();
  assert.equal(await page.getByRole('option').count(), 3);
  assert.equal(await page.getByRole('option').filter({ hasText: 'Codex' }).count(), 0);
  const chosen = page.getByRole('option').filter({ hasText: 'personal' });
  const geometry = await chosen.boundingBox();
  assert.ok(geometry && geometry.x >= 0 && geometry.x + geometry.width <= width, 'hidden choices fit the picker');
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HELM_TEST_SCREENSHOT_DIR}/hidden-cli-${width}.png` });
  await chosen.click();
  await page.waitForFunction(() => window.calls.some(call => call.method === 'session.start'));
  const call = await startCall(page);
  assert.equal(call.env, 'vm');
  assert.equal(call.params.profileId, 'claude-personal');
  assert.equal(call.params.effort, 'high');
  assert.equal(call.params.mode, 'auto');
  assert.equal(call.params.cwd, '/work/project');
  const changes = await page.evaluate(() => window.calls.filter(call => call.method === 'picker.prefs').map(call => call.params));
  assert.deepEqual(changes, []);
  await page.keyboard.press('Control+Shift+n');
  await page.getByRole('option', { name: 'Show 2 hidden agents', exact: true }).waitFor();
  assert.equal(await page.getByRole('option').filter({ hasText: 'personal' }).count(), 0, 'a fresh picker returns to shown CLIs');
});

test('the hidden view keeps the search and supports keyboard launch', async t => {
  const page = await pageFor(t, { envId: 'vm', folder: '/work/project' });
  await hiddenPicker(page);
  const input = page.getByRole('combobox', { name: 'Search agents' });
  await input.fill('grok');
  const toggle = page.getByRole('option', { name: 'Show 1 hidden match', exact: true, selected: true });
  await toggle.waitFor();
  assert.equal(await page.getByText('No agent matches.', { exact: true }).count(), 0);
  await input.press('Enter');
  const hiddenInput = page.getByRole('combobox', { name: 'Search hidden agents' });
  assert.equal(await hiddenInput.inputValue(), 'grok');
  assert.equal(await hiddenInput.evaluate(el => el === document.activeElement), true);
  await page.getByRole('option').filter({ hasText: 'Grok' }).waitFor();
  await hiddenInput.fill('');
  await hiddenInput.press('ArrowDown');
  assert.match(await page.getByRole('option', { selected: true }).innerText(), /Grok/);
  await hiddenInput.press('Enter');
  await page.waitForFunction(() => window.calls.some(call => call.method === 'session.start'));
  assert.equal((await startCall(page)).params.profileId, 'grok');
});

test('all-hidden and legacy local preferences still offer a way to use a hidden CLI', async t => {
  const page = await pageFor(t, { envId: 'vm', folder: '/work/project' });
  await hiddenPicker(page, { local: true, all: true });
  assert.equal(await page.getByRole('option').count(), 1);
  await page.getByRole('option', { name: 'Show 3 hidden agents', exact: true }).click();
  assert.equal(await page.getByRole('option').count(), 4);
  await page.getByRole('option', { name: 'Show visible agents', exact: true }).click();
  assert.equal(await page.getByRole('option').count(), 1);
  await page.getByRole('option', { name: 'Show 3 hidden agents', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'Grok' }).click();
  await page.waitForFunction(() => window.calls.some(call => call.method === 'session.start'));
  assert.equal((await startCall(page)).params.profileId, 'grok');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('helm.prefs')).vm), { hidden: ['visible', 'hidden-personal', 'hidden-other'], account: 'visible' });
});

test('arrows reach the quiet row and Backspace returns through hidden, shown, then folders', async t => {
  const page = await pageFor(t, { envId: 'vm', folder: '/work/project' });
  await hiddenPicker(page);
  const input = page.getByRole('combobox', { name: 'Search agents' });
  assert.match(await page.getByRole('option', { selected: true }).innerText(), /Codex/);
  await input.press('ArrowDown');
  const toggle = page.getByRole('option', { name: 'Show 2 hidden agents', selected: true });
  await toggle.waitFor();
  assert.equal(await input.getAttribute('aria-activedescendant'), await toggle.getAttribute('id'));
  await input.press('Enter');
  const hidden = page.getByRole('combobox', { name: 'Search hidden agents' });
  await hidden.press('ArrowUp');
  await page.getByRole('option', { name: 'Show visible agents', selected: true }).waitFor();
  await hidden.press('Enter');
  await input.press('ArrowUp');
  await input.press('Enter');
  await hidden.press('Backspace');
  await input.waitFor();
  assert.match(await page.getByRole('option', { selected: true }).innerText(), /Codex/);
  await input.press('Backspace');
  await page.getByRole('combobox', { name: 'Search folders on vm' }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.method === 'session.start')), false);
});

test('search counts hidden matches and keeps a return row when the hidden list is empty', async t => {
  const page = await pageFor(t, { envId: 'vm', folder: '/work/project' });
  await hiddenPicker(page);
  const input = page.getByRole('combobox', { name: 'Search agents' });
  await input.fill('o');
  await page.getByRole('option', { name: 'Show 2 hidden matches' }).waitFor();
  await input.fill('missing');
  await page.getByText('No agent matches.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('option').count(), 0);
  await input.fill('claude');
  await page.getByRole('option', { name: 'Show 1 hidden match' }).click();
  const hidden = page.getByRole('combobox', { name: 'Search hidden agents' });
  await hidden.fill('missing');
  await page.getByText('No hidden agent matches.', { exact: true }).waitFor();
  await page.getByRole('option', { name: 'Show visible agents' }).click();
  assert.equal(await input.inputValue(), 'missing');
  await page.getByText('No agent matches.', { exact: true }).waitFor();
});

test('Enter still launches the shown default and remembers it', async t => {
  const page = await pageFor(t, { envId: 'vm', folder: '/work/project' });
  await hiddenPicker(page);
  await page.getByRole('combobox', { name: 'Search agents' }).press('Enter');
  await page.waitForFunction(() => window.calls.some(call => call.method === 'session.start'));
  assert.equal((await startCall(page)).params.profileId, 'codex');
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.method === 'picker.prefs').map(call => call.params)), [{ last: 'visible' }]);
});

test('the quiet row has a mobile tap target and pointer selection changes its appearance', async t => {
  const page = await pageFor(t, { envId: 'vm', folder: '/work/project' }, { isMobile: true, hasTouch: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await hiddenPicker(page);
  const toggle = page.getByRole('option', { name: 'Show 2 hidden agents' });
  const before = await toggle.evaluate(el => getComputedStyle(el).backgroundColor);
  await toggle.hover();
  assert.equal(await toggle.getAttribute('aria-selected'), 'true');
  assert.notEqual(await toggle.evaluate(el => getComputedStyle(el).backgroundColor), before);
  const geometry = await toggle.boundingBox();
  assert.ok(geometry && geometry.height >= 44, 'touch row is at least 44px tall');
  assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= 390, 'touch row fits the viewport');
  assert.equal(await page.locator('.palette-foot').count(), 0);
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HELM_TEST_SCREENSHOT_DIR}/quiet-cli-touch.png` });
});
