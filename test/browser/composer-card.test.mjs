import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A question or approval is the top of the composer card. Keys and typed
// text answer it; a sudo password never reaches the agent.
let browser, bundle, styles;
before(async () => {
  bundle = await build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {DrivenSession} from './apps/web/src/session/DrivenSession';
    const env={id:'card-test',name:'Laptop',online:true,info:{}};
    const session={id:'chat',title:'Dark switch',cwd:'/project',engine:'claude',profileId:'claude',driver:'claude',status:'idle'};
    const other={...session,id:'other',title:'Earlier chat'};
    const t0=1_790_000_000_000;
    const base=()=>[
      {type:'turn.start',turnId:'t1',text:'Add a dark switch'},
      {type:'item.start',id:'a',kind:'text',turnId:'t1'},
      {type:'item.delta',id:'a',text:'On it. I will start with the settings page.'},
      {type:'item.done',id:'a'},
    ];
    const done=(events)=>[...events,{type:'turn.done',turnId:'t1',status:'ok'}];
    const q=(over={})=>({requestId:'ask',kind:'question',title:'Claude',defaultTo:'allow',options:[],
      questions:[{question:'Which cache should the scan use?',options:[{label:'Use disk cache',description:'Fast, may be a day old'},{label:'Scan again',description:'Slow, always fresh'},{label:'Skip it'}]}],...over});
    const cmd={requestId:'cmd',kind:'command',tool:'Bash',title:'Run the tests',detail:'npm exec --workspace @helm/web -- tsc --noEmit && node --test --test-concurrency=2 test/browser/composer-card.test.mjs',
      reason:'Not in your allowed commands',defaultTo:'deny',allowEdit:true,input:{command:'npm test'},
      options:[{id:'allow',role:'allow',label:'Allow'},{id:'always',role:'allow-always',label:'Always allow npm'},{id:'deny',role:'deny',label:'Deny'}]};
    const sudoAsk={requestId:'sudo-cardtest1',kind:'command',tool:'sudo',title:'Run as admin',detail:'pacman -U zapfast-bin-0.21.2.pkg.tar.zst',
      reason:'Install Zapfast. Folder: /tmp',defaultTo:'allow',allowEdit:false,ownLabels:true,passwordNeeded:true,machine:'Laptop',
      input:{command:'pacman -U zapfast-bin-0.21.2.pkg.tar.zst'},
      options:[{id:'allow',role:'allow',label:'Allow once'},{id:'allow-15',role:'allow-always',label:'Allow for 15 min'},{id:'deny',role:'deny',label:'Deny'}]};
    const scenes={
      edits:{events:done(base()),session:{mode:'acceptEdits'}},
      yolo:{events:done(base()),session:{mode:'bypassPermissions'}},
      question:{events:base(),status:'blocked',pending:[q()]},
      multi:{events:base(),status:'blocked',pending:[q({questions:[{question:'Which checks should run?',multiSelect:true,options:[{label:'Types'},{label:'Browser tests'},{label:'Lint'}]}]})]},
      two:{events:base(),status:'blocked',pending:[q({questions:[
        {question:'Which cache?',options:[{label:'Disk'},{label:'Memory'}]},
        {question:'How loud?',options:[{label:'Quiet'},{label:'Loud'}]}]})]},
      command:{events:base(),status:'blocked',pending:[cmd]},
      sudo:{events:base(),status:'blocked',pending:[sudoAsk]},
    };
    window.scene='question';
    const client={pendingActions:()=>[],resumeActions:async()=>[],input:(env,params)=>client.rpc(env,'session.input',params),on:()=>()=>{},subscribe:()=>{},rpc:async(e,method,params)=>{
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
      if(method==='sudo.setup'&&params.password==='bad')throw new Error('This password is wrong: sudo did not accept it. Try again.');
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
const answered = (page) => page.waitForFunction(() => window.calls.some((c) => c.method === 'session.answer'));
const decisionOf = async (page) => (await page.evaluate(() => window.calls.find((c) => c.method === 'session.answer'))).params.decision;

test('question shortcuts require Ctrl or Cmd and Alt, while number keys remain text', async (t) => {
  const page = await open(t, 'question');
  const banner = page.locator('.slab .sheet.banner.question');
  await banner.waitFor();
  await page.locator('.slab textarea').focus();
  await page.keyboard.press('2');
  assert.equal(await page.locator('.slab textarea').inputValue(), '2');
  assert.equal(await page.evaluate(() => window.calls.some(c => c.method === 'session.answer')), false);
  await page.locator('.slab textarea').fill('');
  const altGraph = await page.locator('.slab textarea').evaluate(el => {
    const event = new KeyboardEvent('keydown', { key: '@', code: 'Digit2', ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return { altGraph: event.getModifierState('AltGraph'), prevented: event.defaultPrevented };
  });
  assert.deepEqual(altGraph, { altGraph: true, prevented: false });
  await page.locator('.slab textarea').evaluate(el => {
    const event = new KeyboardEvent('keydown', { key: '2', code: 'Digit2', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    event.preventDefault(); el.dispatchEvent(event);
  });
  assert.equal(await page.evaluate(() => window.calls.some(c => c.method === 'session.answer')), false);
  await page.keyboard.press('Control+Alt+2');
  await answered(page);
  assert.deepEqual(await decisionOf(page), { option: 'allow', answers: { 'Which cache should the scan use?': 'Scan again' }, answerLists: { 'Which cache should the scan use?': ['Scan again'] } });
  assert.equal(await page.locator('.slab textarea').inputValue(), '');
  const mac = await open(t, 'question');
  await mac.locator('.slab .sheet.banner.question').waitFor();
  await mac.keyboard.press('Meta+Alt+2');
  await answered(mac);
  assert.equal((await decisionOf(mac)).answers['Which cache should the scan use?'], 'Scan again');
});

test('typing into the composer while a question is open answers it instead of sending a message', async (t) => {
  const page = await open(t, 'question');
  await page.locator('.slab .sheet.banner.question').waitFor();
  const area = page.locator('.slab textarea');
  await area.pressSequentially('3 files, please');
  await page.keyboard.press('Enter');
  await answered(page);
  assert.deepEqual(await decisionOf(page), { option: 'allow', answers: { 'Which cache should the scan use?': '3 files, please' }, answerLists: { 'Which cache should the scan use?': ['3 files, please'] } });
  assert.equal(await page.evaluate(() => window.calls.some((c) => c.method === 'session.input')), false, 'not sent as a new message');
  assert.equal(await area.inputValue(), '');
});

test('several questions go one by one; a multi-select needs its own Send', async (t) => {
  const two = await open(t, 'two');
  await two.locator('.slab .sheet.banner.question').waitFor();
  await two.keyboard.press('Control+Alt+1');
  await two.getByText('How loud?').waitFor();
  await two.locator('.slab textarea').fill('Whisper');
  await two.keyboard.press('Enter');
  await answered(two);
  assert.deepEqual((await decisionOf(two)).answers, { 'Which cache?': 'Disk', 'How loud?': 'Whisper' });
  const multi = await open(t, 'multi');
  await multi.locator('.slab .sheet.banner.question').waitFor();
  await multi.keyboard.press('Control+Alt+1');
  await multi.keyboard.press('Control+Alt+3');
  assert.equal(await multi.evaluate(() => window.calls.some((c) => c.method === 'session.answer')), false);
  await multi.getByRole('button', { name: 'Send', exact: true }).click();
  await answered(multi);
  assert.deepEqual((await decisionOf(multi)).answers, { 'Which checks should run?': 'Types, Lint' });
  assert.deepEqual((await decisionOf(multi)).answerLists, { 'Which checks should run?': ['Types', 'Lint'] });
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

test('a note typed on an approval goes with the answer', async (t) => {
  const page = await open(t, 'command', 390);
  const banner = page.locator('.slab .sheet.banner.command');
  await banner.waitFor();
  await banner.getByRole('button', { name: 'Add a note' }).click();
  await banner.locator('.sheet-note').fill('use the fast suite');
  await banner.getByRole('button', { name: 'Decline', exact: true }).click();
  await answered(page);
  const decision = await decisionOf(page);
  assert.equal(decision.option, 'deny');
  assert.equal(decision.message, 'use the fast suite');
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

test('a helm sudo card with no saved password asks for it, with no note box', async (t) => {
  const page = await open(t, 'sudo');
  const box = page.locator('.sheet-password');
  await box.waitFor();
  assert.equal(await page.locator('.sheet-links, .sheet-note').count(), 0, 'no note: a typed password must not go to the agent');
  const allow = page.locator('.sheet-actions button', { hasText: 'Allow once' });
  assert.equal(await allow.isDisabled(), true);
  // A wrong password says so and keeps the card.
  await box.locator('input').fill('bad');
  await allow.click();
  await box.locator('.error').waitFor();
  assert.equal(await page.evaluate(() => window.calls.some((c) => c.method === 'session.answer')), false);
  // The right one is saved first; the answer never carries it.
  await box.locator('input').fill('right horse');
  await box.locator('input').press('Enter');
  await answered(page);
  const calls = await page.evaluate(() => window.calls.filter((c) => ['sudo.setup', 'session.answer'].includes(c.method)));
  assert.deepEqual(calls.map((c) => c.method), ['sudo.setup', 'sudo.setup', 'session.answer']);
  assert.equal(JSON.stringify(calls.at(-1)).includes('right horse'), false);
  assert.deepEqual(await decisionOf(page), { option: 'allow' });
});
