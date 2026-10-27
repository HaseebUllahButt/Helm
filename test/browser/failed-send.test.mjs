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
      window.sends=[]; window.answers=[]; window.deliveryIds=[];
      const listeners=new Set();
      window.emitTurn=(turn)=>listeners.forEach(fn=>fn('laptop','session.event',{id:'failed-send-test',events:[{seq:1,at:Date.now(),type:'turn.start',turnId:'local-confirmed',queued:true,...turn}]}));
      const client={input:(env,params,_timeout,messageId)=>{window.deliveryIds.push(messageId);return client.rpc(env,'session.input',params);},on:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
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
  assert.match(await card.innerText(), /Machine did not answer/);
  assert.equal(await box.inputValue(), 'typed while waiting', 'the newer draft is left alone');

  // Retry sends the kept words, not the composer's; a double tap sends once.
  const retry = card.getByRole('button', { name: 'Retry send' });
  await retry.evaluate(button => { button.click(); button.click(); });
  await p.waitForFunction(() => window.sends.length === 2);
  assert.deepEqual(await p.evaluate(() => window.sends[1]),
    { id: 'failed-send-test', data: 'first message', references: [] });
  await p.evaluate(() => window.answers[1].reject(new Error('still nothing')));
  await p.locator('.failed-send', { hasText: 'Still nothing' }).waitFor();
  assert.equal(await p.evaluate(() => window.sends.length), 2);

  await card.getByRole('button', { name: 'Retry send' }).click();
  await p.waitForFunction(() => window.sends.length === 3);
  assert.equal(await p.evaluate(() => new Set(window.deliveryIds).size), 1, 'all retries retain the first message identity');
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

test('an unconfirmed timeout keeps the draft and offers a safe retry with the same ID', async t => {
  const p = await browser.newPage(); t.after(() => p.close());
  p.setDefaultTimeout(5000);
  await p.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await p.goto('http://helm.test/'); await p.addScriptTag({ content: script });
  const box = p.locator('textarea');
  await box.fill('only message');
  await p.getByRole('button', { name: 'send', exact: true }).click();
  await p.waitForFunction(() => window.sends.length === 1);
  await p.evaluate(() => window.answers[0].reject(Object.assign(new Error('session.deliver timed out; message 63d6b99d80dbbf70b29db7d320c8d800 is still unconfirmed - retry with the same delivery ID'), { code: 'timeout' })));
  await p.waitForFunction(() => document.querySelector('textarea').value === 'only message');
  const card = p.locator('.failed-send');
  assert.match(await card.innerText(), /did not get a reply in time/);
  assert.doesNotMatch(await p.locator('body').innerText(), /session\.deliver|63d6b99d|delivery ID/);
  await card.getByRole('button', { name: 'Retry send' }).click();
  await p.waitForFunction(() => window.sends.length === 2);
  assert.equal(await p.evaluate(() => new Set(window.deliveryIds).size), 1);
  await p.evaluate(() => window.answers[1].resolve({ ok: true }));
  await card.waitFor({ state: 'detached' });
  assert.equal(await box.inputValue(), '');
});

test('explicit rejections allow a new attempt, while unknown results keep their identity until confirmed', async t => {
  const p = await browser.newPage(); t.after(() => p.close());
  p.setDefaultTimeout(5000);
  await p.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await p.goto('http://helm.test/'); await p.addScriptTag({ content: script });
  const box = p.locator('textarea');
  const send = () => p.getByRole('button', { name: 'send', exact: true }).click();
  await box.fill('repeat these words'); await send();
  await p.waitForFunction(() => window.sends.length === 1);
  await p.evaluate(() => window.answers[0].reject(Object.assign(new Error('provider rejected it'), { code: 'provider_busy' })));
  await p.waitForFunction(() => document.querySelector('textarea').value === 'repeat these words');
  await send(); await p.waitForFunction(() => window.sends.length === 2);
  assert.notEqual(...await p.evaluate(() => window.deliveryIds.slice(0, 2)), 'a rejected request can make a fresh attempt');
  await box.fill('a newer draft');
  await p.evaluate(() => window.answers[1].reject(new Error('unknown result')));
  const card = p.locator('.failed-send'); await card.waitFor();
  await card.getByRole('button', { name: 'Retry send' }).click();
  await p.waitForFunction(() => window.sends.length === 3);
  assert.equal(...await p.evaluate(() => window.deliveryIds.slice(1, 3)), 'an uncertain retry retains its ID');
  await p.evaluate(() => window.answers[2].resolve({ ok: true }));
  await card.waitFor({ state: 'detached' });
  await box.fill('repeat these words'); await send();
  await p.waitForFunction(() => window.sends.length === 4);
  assert.notEqual(...await p.evaluate(() => [window.deliveryIds[2], window.deliveryIds[3]]), 'a later intentional repeat is a new message');
  await p.evaluate(() => window.answers[3].resolve({ ok: true }));
});

test('retry keeps original attachments and leaves a newer draft in place', async t => {
  const p = await browser.newPage(); t.after(() => p.close());
  p.setDefaultTimeout(5000);
  await p.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await p.goto('http://helm.test/'); await p.addScriptTag({ content: script });
  const box = p.locator('textarea');
  await box.waitFor();
  await p.waitForFunction(() => !document.querySelector('.attach-status'));
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['original document'], 'original.txt', { type: 'text/plain' }));
    document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.locator('.attach-preview').waitFor();
  await p.getByRole('button', { name: 'send', exact: true }).click();
  await p.waitForFunction(() => window.sends.length === 1);
  await box.fill('a newer draft');
  await p.evaluate(() => window.answers[0].reject(Object.assign(new Error('not connected'), { code: 'offline' })));
  const card = p.locator('.failed-send');
  await card.waitFor();
  assert.match(await card.innerText(), /Laptop is not connected/);
  await p.getByRole('button', { name: /Remove .*original.txt/ }).click();
  await card.getByRole('button', { name: 'Retry send' }).click();
  await p.waitForFunction(() => window.sends.length === 2);
  assert.deepEqual(await p.evaluate(() => window.sends[1].attachments), await p.evaluate(() => window.sends[0].attachments));
  assert.equal(await p.evaluate(() => new Set(window.deliveryIds).size), 1);
  await box.fill('typed during retry');
  await p.evaluate(() => window.answers[1].resolve({ ok: true }));
  await card.waitFor({ state: 'detached' });
  assert.equal(await box.inputValue(), 'typed during retry');
});

test('retry keeps a replacement file and its caption in the draft', async t => {
  const p = await browser.newPage(); t.after(() => p.close());
  p.setDefaultTimeout(5000);
  await p.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await p.goto('http://helm.test/'); await p.addScriptTag({ content: script });
  const box = p.locator('textarea');
  await box.waitFor();
  await p.waitForFunction(() => !document.querySelector('.attach-status'));
  const pasteFile = data => p.evaluate(data => {
    const dt = new DataTransfer();
    dt.items.add(new File([data], 'same.txt', { type: 'text/plain' }));
    document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
  await box.fill('keep this caption');
  await pasteFile('original file');
  await p.locator('.attach-preview').waitFor();
  await p.getByRole('button', { name: 'send', exact: true }).click();
  await p.waitForFunction(() => window.sends.length === 1);
  const caption = await p.evaluate(() => window.sends[0].data);
  await p.evaluate(() => window.answers[0].reject(new Error('not connected')));
  await p.locator('.failed-send').waitFor();
  await p.getByRole('button', { name: /Remove .*same.txt/ }).click();
  await p.locator('.attach-preview').waitFor({ state: 'detached' });
  await box.focus();
  await box.press('Control+End');
  await pasteFile('replacement file');
  await p.locator('.attach-preview').waitFor();
  await p.waitForFunction(() => document.querySelector('textarea').value.endsWith('[File: same.txt] '));
  const replacementDraft = await box.inputValue();
  assert.equal(replacementDraft.trim(), caption);
  assert.equal(await p.locator('.attach-preview').count(), 1);
  await p.getByRole('button', { name: 'Retry send' }).click();
  await p.waitForFunction(() => window.sends.length === 2);
  await p.evaluate(() => window.answers[1].resolve({ ok: true }));
  await p.locator('.failed-send').waitFor({ state: 'detached' });
  assert.equal(await box.inputValue(), replacementDraft);
  assert.equal(await p.locator('.attach-preview').count(), 1);
  assert.deepEqual(await p.evaluate(() => window.sends[1].attachments), await p.evaluate(() => window.sends[0].attachments));
});

for (const when of ['before', 'after']) test(`a matching delivery ${when} a lost reply confirms that send only`, async t => {
  const p = await browser.newPage(); t.after(() => p.close());
  await p.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await p.goto('http://helm.test/'); await p.addScriptTag({ content: script });
  const box = p.locator('textarea');
  await box.fill('continue');
  await p.getByRole('button', { name: 'send', exact: true }).click();
  await p.waitForFunction(() => window.sends.length === 1);
  const confirm = async () => {
    await p.evaluate(() => window.emitTurn({ text: 'continue', messageId: window.deliveryIds[0] }));
    await p.locator('.queued-row').waitFor();
  };
  if (when === 'before') await confirm();
  await p.evaluate(() => window.answers[0].reject(Object.assign(new Error('reply lost'), { code: 'timeout' })));
  if (when === 'after') { await p.locator('.failed-send').waitFor(); await confirm(); }
  await p.locator('.failed-send').waitFor({ state: 'detached' });
  await p.waitForFunction(() => document.querySelector('textarea').value === '');
  await box.fill('continue');
  await p.getByRole('button', { name: 'send', exact: true }).click();
  await p.waitForFunction(() => window.sends.length === 2);
  assert.notEqual(...await p.evaluate(() => window.deliveryIds), 'an intentional repeat gets a new identity');
  await p.evaluate(() => window.answers[1].resolve({ ok: true }));
});

for (const identified of [true, false]) test(`another device's matching words cannot confirm a failed send (identified: ${identified})`, async t => {
  const p = await browser.newPage(); t.after(() => p.close());
  await p.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await p.goto('http://helm.test/'); await p.addScriptTag({ content: script });
  const box = p.locator('textarea');
  await box.fill('continue'); await p.getByRole('button', { name: 'send', exact: true }).click();
  await p.waitForFunction(() => window.sends.length === 1);
  await box.fill('keep this newer draft');
  await p.evaluate(identified => window.emitTurn({ text: 'continue', ...(identified ? { messageId: 'b'.repeat(32) } : {}) }), identified);
  await p.locator('.queued-row').waitFor();
  await p.evaluate(() => window.answers[0].reject(Object.assign(new Error('reply lost'), { code: 'timeout' })));
  const card = p.locator('.failed-send'); await card.waitFor();
  assert.equal(await box.inputValue(), 'keep this newer draft');
  await card.getByRole('button', { name: 'Retry send' }).click();
  await p.waitForFunction(() => window.sends.length === 2);
  assert.equal(...await p.evaluate(() => window.deliveryIds), 'the safe retry retains its identity');
  await p.evaluate(() => window.answers[1].resolve({ ok: true }));
  await card.waitFor({ state: 'detached' });
});

test('a late attached-message confirmation keeps newer writing and removes the sent image draft', async t => {
  const p = await browser.newPage(); t.after(() => p.close());
  await p.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await p.goto('http://helm.test/'); await p.addScriptTag({ content: script });
  const box = p.locator('textarea'); await box.waitFor();
  await p.waitForFunction(() => !document.querySelector('.attach-status'));
  await p.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'picture.png', { type: 'image/png' }));
    document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.locator('.attach-preview').waitFor();
  await p.getByRole('button', { name: 'send', exact: true }).click();
  await p.waitForFunction(() => window.sends.length === 1);
  await p.evaluate(() => window.answers[0].reject(Object.assign(new Error('reply lost'), { code: 'timeout' })));
  await p.locator('.failed-send').waitFor(); await box.fill('keep this newer draft [Image #1]');
  await p.evaluate(() => window.emitTurn({ text: window.sends[0].data, messageId: window.deliveryIds[0], attachments: window.sends[0].attachments }));
  await p.locator('.queued-row').waitFor(); await p.locator('.failed-send').waitFor({ state: 'detached' });
  await p.locator('.slab .attach-preview').waitFor({ state: 'detached' });
  assert.equal(await box.inputValue(), 'keep this newer draft [Image #1]');
});
