import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A send can take over a minute to fail. If the owner has typed since, the
// failed words cannot go back into the composer, so they wait on a card.
let browser, script;
before(async () => {
  const result = await build({
    stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { DrivenSession } from './apps/web/src/session/DrivenSession';
      window.sends=[]; window.answers=[];
      const client={on:()=>()=>{},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
        if(method==='session.messages')return {messages:[],status:'idle'};
        if(method==='session.events')return {events:[],pending:[],last:0,session:{status:'idle'}};
        if(method==='model.list')return {models:[],default:null};
        if(method==='session.list')return {sessions:[{id:'other',title:'Other',driver:'codex'}]};
        if(method==='session.input'){
          window.sends.push(params);
          return new Promise((resolve,reject)=>window.answers.push({resolve,reject}));
        }
        return {ok:true,pending:[]};
      }};
      createRoot(document.getElementById('root')).render(<DrivenSession client={client} env={{id:'laptop',name:'Laptop',online:true}}
        session={{id:'failed-send-test',engine:'codex',driver:'codex',status:'idle',cwd:'/project',title:'Codex'}}
        onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} />);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

test('a failed send after the owner typed on is kept on a card, retried as sent, and cleared', async t => {
  const p = await browser.newPage(); t.after(() => p.close());
  p.setDefaultTimeout(5000);
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await p.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await p.goto('http://helm.test/'); await p.addScriptTag({ content: script });
  const box = p.locator('textarea');
  await box.fill('first message');
  await p.getByRole('button', { name: 'send', exact: true }).click();
  await p.waitForFunction(() => window.sends.length === 1);
  await box.fill('typed while waiting');
  await p.evaluate(() => window.answers[0].reject(new Error('machine did not answer')));

  const card = p.locator('.failed-send');
  await card.waitFor();
  assert.match(await card.innerText(), /Send not confirmed/);
  assert.match(await card.innerText(), /first message/);
  assert.match(await card.innerText(), /machine did not answer — check the conversation before retrying/);
  assert.equal(await box.inputValue(), 'typed while waiting', 'the newer draft is left alone');

  // Retry sends the kept words, not the composer's; a double tap sends once.
  const retry = card.getByRole('button', { name: 'Retry send' });
  await retry.evaluate(button => { button.click(); button.click(); });
  await p.waitForFunction(() => window.sends.length === 2);
  assert.deepEqual(await p.evaluate(() => window.sends[1]),
    { id: 'failed-send-test', data: 'first message', references: [] });
  await p.evaluate(() => window.answers[1].reject(new Error('still nothing')));
  await p.locator('.failed-send', { hasText: 'still nothing — check the conversation' }).waitFor();
  assert.equal(await p.evaluate(() => window.sends.length), 2);

  await card.getByRole('button', { name: 'Retry send' }).click();
  await p.waitForFunction(() => window.sends.length === 3);
  await p.evaluate(() => window.answers[2].resolve({ ok: true }));
  await card.waitFor({ state: 'detached' });
  assert.equal(await box.inputValue(), 'typed while waiting');

  // Dismiss lets a kept message go.
  await p.getByRole('button', { name: 'send', exact: true }).click();
  await p.waitForFunction(() => window.sends.length === 4);
  await box.fill('another draft');
  await p.evaluate(() => window.answers[3].reject(new Error('lost')));
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await card.waitFor({ state: 'detached' });
  assert.equal(await p.evaluate(() => window.sends.length), 4);
});

test('a failed send with an untouched composer still goes back into it, with no card', async t => {
  const p = await browser.newPage(); t.after(() => p.close());
  p.setDefaultTimeout(5000);
  await p.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await p.goto('http://helm.test/'); await p.addScriptTag({ content: script });
  const box = p.locator('textarea');
  await box.fill('only message');
  await p.getByRole('button', { name: 'send', exact: true }).click();
  await p.waitForFunction(() => window.sends.length === 1);
  await p.evaluate(() => window.answers[0].reject(new Error('nope')));
  await p.waitForFunction(() => document.querySelector('textarea').value === 'only message');
  assert.equal(await p.locator('.failed-send').count(), 0);
});
