import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// The composer is one floating card. The agent's task list is a tab tucked
// behind it, and a question or approval is the top of the card itself.
let browser, bundle, styles;
const shots = process.env.HELM_TEST_SCREENSHOT_DIR;
before(async () => {
  if (shots) await mkdir(shots, { recursive: true });
  bundle = await build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {DrivenSession} from './apps/web/src/session/DrivenSession';
    const env={id:'card-test',name:'Laptop',online:true,info:{}};
    const session={id:'chat',title:'Dark switch',cwd:'/project',engine:'claude',profileId:'claude',driver:'claude',status:'idle'};
    const other={...session,id:'other',title:'Earlier chat'};
    const t0=1_790_000_000_000;
    const todo=(id,list)=>({type:'item.start',id,kind:'tool',turnId:'t1',name:'TodoWrite',input:{todos:list.map(([content,status,activeForm])=>({content,status,activeForm}))}});
    const list=[
      ['Read the settings page','completed'],['Add the dark switch','completed'],
      ['Run the tests','in_progress','Running the tests'],['Update the docs','pending'],['Ship it','pending'],
    ];
    const base=()=>[
      {type:'turn.start',turnId:'t1',text:'Add a dark switch'},
      {type:'item.start',id:'a',kind:'text',turnId:'t1'},
      {type:'item.delta',id:'a',text:'On it. I will start with the settings page.'},
      {type:'item.done',id:'a'},
    ];
    const withTodos=(l)=>[...base(),todo('w',l),{type:'item.done',id:'w'}];
    const done=(events)=>[...events,{type:'turn.done',turnId:'t1',status:'ok'}];
    const q=(over={})=>({requestId:'ask',kind:'question',title:'Claude',defaultTo:'allow',options:[],
      questions:[{question:'Which cache should the scan use?',options:[{label:'Use disk cache',description:'Fast, may be a day old'},{label:'Scan again',description:'Slow, always fresh'},{label:'Skip it'}]}],...over});
    const cmd={requestId:'cmd',kind:'command',tool:'Bash',title:'Run the tests',detail:'npm exec --workspace @helm/web -- tsc --noEmit && node --test --test-concurrency=2 test/browser/composer-card.test.mjs',
      reason:'Not in your allowed commands',defaultTo:'deny',allowEdit:true,input:{command:'npm test'},
      options:[{id:'allow',role:'allow',label:'Allow'},{id:'always',role:'allow-always',label:'Always allow npm'},{id:'deny',role:'deny',label:'Deny'}]};
    const toolAsk={requestId:'tool',kind:'tool',tool:'devin',title:'Run a command',detail:JSON.stringify({command:'echo hi',cwd:'/work'},null,2),
      options:[{id:'allow',role:'allow',label:'Allow'},{id:'deny',role:'deny',label:'Deny'}]};
    const scenes={
      idle:{events:done(base())},
      tool:{events:base(),status:'blocked',pending:[toolAsk]},
      edits:{events:done(base()),session:{mode:'acceptEdits'}},
      yolo:{events:done(base()),session:{mode:'bypassPermissions'}},
      tasks:{events:withTodos(list),status:'working'},
      allDone:{events:done(withTodos(list.map(([c,,a])=>[c,'completed',a])))},
      stopped:{events:done(withTodos(list))},
      question:{events:withTodos(list),status:'blocked',pending:[q()]},
      multi:{events:base(),status:'blocked',pending:[q({questions:[{question:'Which checks should run?',multiSelect:true,options:[{label:'Types'},{label:'Browser tests'},{label:'Lint'}]}]})]},
      two:{events:base(),status:'blocked',pending:[q({questions:[
        {question:'Which cache?',options:[{label:'Disk'},{label:'Memory'}]},
        {question:'How loud?',options:[{label:'Quiet'},{label:'Loud'}]}]})]},
      command:{events:withTodos(list),status:'blocked',pending:[cmd]},
    };
    window.scene='idle';
    const client={input:(env,params)=>client.rpc(env,'session.input',params),on:()=>()=>{},subscribe:()=>{},rpc:async(e,method,params)=>{
      (window.calls??=[]).push({method,params});
      const s=scenes[window.scene];
      if(method==='session.list')return {sessions:[session,other]};
      if(method==='session.commands')return {commands:[{name:'review',description:'Review the change'}]};
      if(method==='model.list')return {default:'claude-opus-5-5',models:['claude-opus-5-5'],labels:{'claude-opus-5-5':'Opus 5.5'},modes:[{id:'default',label:'Ask first',short:'Ask'},{id:'acceptEdits',label:'Accept edits',short:'Edits'},{id:'bypassPermissions',label:'Bypass all checks',short:'yolo',danger:true}]};
      if(method==='session.watch')return {last:0};
      if(method==='session.events'){
        const events=params.since?[]:s.events.map((ev,i)=>({seq:i+1,at:t0+i,...ev}));
        return {session:{...session,status:s.status??'idle'},events,pending:window.answered?[]:(s.pending??[]).map((p,i)=>({seq:100+i,at:t0,...p})),last:events.length};
      }
      if(method==='session.answer')window.answered=true;
      return {ok:true};
    }};
    window.mount=(name)=>{window.scene=name;window.answered=false;window.calls=[];
      createRoot(document.getElementById('root')).render(<DrivenSession client={client} env={env} session={{...session,...scenes[name].session,status:scenes[name].status??'idle'}} onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} />);};
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  styles = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

async function open(t, scene, width = 1280, height = 844) {
  const page = await browser.newPage({ viewport: { width, height } });
  t.after(() => page.close());
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => t.diagnostic(error.stack));
  await page.route('http://helm-card-test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div class="main showing" style="height:100vh;display:flex;flex-direction:column"><div class="session" id="root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>' }));
  await page.goto('http://helm-card-test/');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((name) => window.mount(name), scene);
  await page.locator('.slab textarea').waitFor();
  return page;
}
const shot = async (page, name) => { await page.waitForTimeout(250); if (shots) await page.screenshot({ path: join(shots, name) }); };
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const answered = (page) => page.waitForFunction(() => window.calls.some((c) => c.method === 'session.answer'));
const decisionOf = async (page) => (await page.evaluate(() => window.calls.find((c) => c.method === 'session.answer'))).params.decision;

test('the composer is a card with a context-aware placeholder', async (t) => {
  const page = await open(t, 'idle');
  const area = page.locator('.slab textarea');
  await page.waitForFunction(() => document.querySelector('.slab textarea').placeholder.includes('/ for commands'));
  assert.equal(await area.getAttribute('placeholder'), 'Ask anything, @ to attach a chat, / for commands');
  assert.equal(await page.locator('.todo-strip').count(), 0, 'no list, no tab');
  const box = await page.locator('.slab').boundingBox();
  assert.ok(box.width <= 64 * 16 + 2, `the card stays in the chat lane: ${box.width}`);
  const radius = await page.locator('.slab').evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
  assert.ok(radius >= 20, `rounded: ${radius}`);
  await shot(page, 'composer-normal-1280.png');
});

test('the task strip names the current step, opens to the checklist, and closes again', async (t) => {
  const page = await open(t, 'tasks');
  const strip = page.locator('.todo-strip');
  await strip.waitFor();
  const head = strip.locator('.todo-strip-head');
  assert.match(await head.innerText(), /Tasks\s+Running the tests\s+2\/5/);
  assert.deepEqual(await strip.locator('.todo-segs i').evaluateAll((els) => els.map((e) => e.className)),
    ['completed', 'completed', 'in_progress', 'pending', 'pending']);
  assert.equal(await strip.locator('.todo').count(), 0, 'closed to start with');
  await shot(page, 'composer-tasks-collapsed-1280.png');
  await head.click();
  assert.equal(await head.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await strip.locator('.todo').evaluateAll((els) => els.map((e) => e.className.split(' ')[1])),
    ['completed', 'completed', 'in_progress', 'pending', 'pending']);
  const tab = await strip.boundingBox(), card = await page.locator('.slab').boundingBox();
  assert.ok(tab.y + tab.height > card.y && tab.y < card.y, 'the tab is tucked behind the card edge');
  await shot(page, 'composer-tasks-expanded-1280.png');
  await head.click();
  assert.equal(await strip.locator('.todo').count(), 0);
});

test('the task strip is hidden once its turn is done and everything is ticked, not before', async (t) => {
  const finished = await open(t, 'allDone');
  await finished.waitForFunction(() => document.querySelector('.slab textarea').placeholder.includes('/ for commands'));
  assert.equal(await finished.locator('.todo-strip').count(), 0);
  const stopped = await open(t, 'stopped');
  await stopped.locator('.todo-strip').waitFor();
  assert.match(await stopped.locator('.todo-strip-count').innerText(), /2\/5/);
});

test('a question sits in the card and a number key answers it, even from the empty box', async (t) => {
  const page = await open(t, 'question');
  const banner = page.locator('.slab .sheet.banner.question');
  await banner.waitFor();
  assert.equal(await page.locator('.composer-col > .sheet').count(), 0, 'no separate sheet');
  assert.equal(await page.locator('.slab textarea').getAttribute('placeholder'), 'Answer the question above or type an answer');
  assert.equal(await banner.getByLabel('Your own answer').count(), 0, 'the composer is the free-text box');
  assert.deepEqual(await banner.locator('.q-num').allTextContents(), ['1', '2', '3']);
  await shot(page, 'composer-question-1280.png');
  await page.locator('.slab textarea').focus();
  await page.keyboard.press('2');
  await answered(page);
  assert.deepEqual(await decisionOf(page), { option: 'allow', answers: { 'Which cache should the scan use?': 'Scan again' } });
  assert.equal(await page.locator('.slab textarea').inputValue(), '', 'the digit was a choice, not text');
});

test('typing into the composer while a question is open answers it instead of sending a message', async (t) => {
  const page = await open(t, 'question');
  await page.locator('.slab .sheet.banner.question').waitFor();
  const area = page.locator('.slab textarea');
  await area.fill('3 files');
  await page.keyboard.press('Enter');
  await answered(page);
  assert.deepEqual(await decisionOf(page), { option: 'allow', answers: { 'Which cache should the scan use?': '3 files' } });
  assert.equal(await page.evaluate(() => window.calls.some((c) => c.method === 'session.input')), false, 'not sent as a new message');
  assert.equal(await area.inputValue(), '');
});

test('several questions go one by one; a multi-select needs its own Send', async (t) => {
  const two = await open(t, 'two');
  await two.locator('.slab .sheet.banner.question').waitFor();
  await two.keyboard.press('1');
  await two.getByText('How loud?').waitFor();
  await two.locator('.slab textarea').fill('Whisper');
  await two.keyboard.press('Enter');
  await answered(two);
  assert.deepEqual((await decisionOf(two)).answers, { 'Which cache?': 'Disk', 'How loud?': 'Whisper' });
  const multi = await open(t, 'multi');
  await multi.locator('.slab .sheet.banner.question').waitFor();
  await multi.keyboard.press('1');
  await multi.keyboard.press('3');
  assert.equal(await multi.evaluate(() => window.calls.some((c) => c.method === 'session.answer')), false);
  await multi.getByRole('button', { name: 'Send', exact: true }).click();
  await answered(multi);
  assert.deepEqual((await decisionOf(multi)).answers, { 'Which checks should run?': 'Types, Lint' });
});

test('Shift Tab walks every permission mode, bypass included, and comes back round', async (t) => {
  const modeAfterShiftTab = async (scene) => {
    const page = await open(t, scene);
    await page.waitForFunction(() => document.querySelector('.slab textarea').placeholder.includes('/ for commands'));
    await page.keyboard.press('Shift+Tab');
    await page.waitForFunction(() => window.calls.some((c) => c.method === 'session.mode'));
    return page.evaluate(() => window.calls.find((c) => c.method === 'session.mode').params.mode);
  };
  assert.equal(await modeAfterShiftTab('edits'), 'bypassPermissions');
  assert.equal(await modeAfterShiftTab('yolo'), 'default');
});

test('a command approval is the top of the card with the command in a mono block', async (t) => {
  const page = await open(t, 'command');
  const banner = page.locator('.slab .sheet.banner.command');
  await banner.waitFor();
  assert.equal(await banner.locator('.ask-kind').textContent(), 'Command approval');
  assert.match(await banner.locator('.sheet-cmd').innerText(), /^npm exec --workspace/);
  assert.match(await page.locator('.slab textarea').getAttribute('placeholder'), /^Select an answer above/);
  assert.deepEqual(await banner.locator('.sheet-actions button').allTextContents(), ['Decline', 'Always allow npm', 'Approve']);
  assert.equal(await page.locator('.todo-strip').count(), 1, 'the task tab stays behind the card');
  await shot(page, 'composer-approval-1280.png');
  await banner.getByRole('button', { name: 'Decline', exact: true }).click();
  await answered(page);
  assert.equal((await decisionOf(page)).option, 'deny');
});

test('on the card the title has its own line and the note box opens only when asked for', async (t) => {
  const page = await open(t, 'command', 390);
  const banner = page.locator('.slab .sheet.banner.command');
  await banner.waitFor();
  assert.equal(await banner.locator('.sheet-title b').textContent(), 'Run the tests');
  assert.equal(await banner.locator('.sheet-head .tag').count(), 0, 'no Bash tag beside "Command approval"');
  assert.equal(await banner.locator('.sheet-note').count(), 0);
  await banner.getByRole('button', { name: 'Add a note' }).click();
  await banner.locator('.sheet-note').fill('use the fast suite');
  await banner.getByRole('button', { name: 'Decline', exact: true }).click();
  await answered(page);
  const decision = await decisionOf(page);
  assert.equal(decision.option, 'deny');
  assert.equal(decision.message, 'use the fast suite');
});

test('a tool approval shows what the tool was given as plain lines, not JSON', async (t) => {
  const page = await open(t, 'tool');
  const banner = page.locator('.slab .sheet.banner.tool');
  await banner.waitFor();
  assert.equal(await banner.locator('.ask-kind').textContent(), 'Tool approval');
  assert.equal(await banner.locator('.sheet-json').innerText(), 'command: echo hi\ncwd: /work');
});

test('edit before allowing still works from the card', async (t) => {
  const page = await open(t, 'command');
  await page.getByRole('button', { name: 'Edit command' }).click();
  await page.locator('.sheet-edit').fill('npm run lint');
  await page.getByRole('button', { name: 'Allow edited command' }).click();
  await answered(page);
  const decision = await decisionOf(page);
  assert.equal(decision.option, 'allow');
  assert.equal(decision.updatedInput.command, 'npm run lint');
});

test('on a phone the card fits, the request scrolls inside and never takes the whole screen', async (t) => {
  const idle = await open(t, 'idle', 390);
  await idle.waitForFunction(() => document.querySelector('.slab textarea').placeholder === 'Ask anything, @ chats, / commands');
  const line = await idle.locator('.slab textarea').evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
  assert.ok(line, 'the placeholder fits on one line');
  await shot(idle, 'composer-normal-390.png');
  const tasks = await open(t, 'tasks', 390);
  await tasks.locator('.todo-strip').waitFor();
  await shot(tasks, 'composer-tasks-collapsed-390.png');
  await tasks.locator('.todo-strip-head').click();
  await shot(tasks, 'composer-tasks-expanded-390.png');
  const question = await open(t, 'question', 390);
  await question.locator('.sheet.banner.question').waitFor();
  await shot(question, 'composer-question-390.png');
  const command = await open(t, 'command', 390);
  const banner = command.locator('.sheet.banner.command');
  await banner.waitFor();
  await command.evaluate(() => { document.querySelector('.sheet-cmd').textContent = Array.from({ length: 60 }, (_, i) => `step ${i}`).join('\n'); });
  const box = await command.locator('.slab').boundingBox();
  assert.ok((await banner.boundingBox()).height <= 844 * 0.47, 'at most about half the screen');
  assert.ok(box.x >= 0 && box.x + box.width <= 390);
  assert.equal(await noOverflow(command), true);
  await shot(command, 'composer-approval-390.png');
  const approve = await banner.getByRole('button', { name: 'Approve', exact: true }).boundingBox();
  assert.ok(approve.y + approve.height <= 844, 'the buttons stay on screen');
});

test('the same card in the light theme', async (t) => {
  const page = await open(t, 'tasks');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('.todo-strip-head').click();
  await shot(page, 'composer-tasks-light-1280.png');
  const command = await open(t, 'command');
  await command.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await command.locator('.sheet.banner.command').waitFor();
  await shot(command, 'composer-approval-light-1280.png');
});
