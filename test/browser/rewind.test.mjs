import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// Configure throwaway state before bundling/importing any Helm code. The UI
// uses a fake RPC client and fresh browser contexts; no daemon or network starts.
const state = mkdtempSync(join(tmpdir(), 'helm-browser-rewind-'));
Object.assign(process.env, {
  HELM_DIR: state, HELM_DB: join(state, 'db.sqlite'), HELM_SSH_DIR: join(state, 'ssh'),
  HELM_PROCS_SOCKET: join(state, 'procs.sock'), HELM_TERMINALS_SOCKET: join(state, 'terminals.sock'),
  HELM_NATIVE_SOCKET: join(state, 'native.sock'), HELM_NO_SERVICE: '1',
});

let browser, script, styles;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    import { txn } from './apps/web/src/idb';
    const initial = {id:'rewind-chat',title:'Rewind fixture',cwd:'/fixture/worktree',engine:'codex',
      driver:'codex',profileId:'fixture-account',status:'idle',alive:true,rewindSupported:true,engineSessionId:'original-provider'};
    const at = Date.now() - 1000;
    const original = [
      {seq:1,at,type:'turn.start',turnId:'selected-turn',text:'Original transcript wording',checkpoint:'checkpoint'},
      {seq:2,at,type:'item.start',id:'reply',turnId:'selected-turn',kind:'text'},
      {seq:3,at,type:'item.delta',id:'reply',text:'Discarded reply'},
      {seq:4,at,type:'item.done',id:'reply',status:'ok'},
      {seq:5,at,type:'turn.done',turnId:'selected-turn',status:'ok'},
    ];
    const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
    canvas.getContext('2d').fillRect(0,0,2,2);
    window.expectedDraft = {text:'Recovered RPC wording [Image #1]',
      attachments:[{filename:'recovered.png',mime:'image/png',data:canvas.toDataURL('image/png').split(',')[1]}],
      references:['design-thread','missing-reference']};
    window.restoreReason = 'This worktree is shared with another session. Rewind without restoring files.';
    window.calls = []; window.sessionUpdates = [];
    let rewound = false;
    const client = {input:(env,params)=>client.rpc(env,'session.input',params),on:()=>()=>{},subscribe:()=>{},rpc:async(env,method,params={})=>{
      window.calls.push({env,method,params});
      if(method==='session.events') {
        const all = rewound ? [{seq:7,at:Date.now(),type:'history.reset'}] : original;
        return {events:all.filter(event=>!params.since||event.seq>params.since),pending:[],last:rewound?7:5,
          firstSeq:rewound?7:1,logFirst:rewound?7:1,session:{status:'idle'}};
      }
      if(method==='session.watch') return {last:rewound?7:5,status:'idle'};
      if(method==='session.list') return {sessions:[{id:'design-thread',title:'Design review',driver:'codex',status:'idle'}]};
      if(method==='session.commands') return {commands:[]};
      if(method==='model.list') return {models:[],default:null};
      if(method==='usage.limits') return {accounts:[]};
      if(method==='git.status') return {repo:false,files:[]};
      if(method==='session.rewind-check') return {restoreFiles:false,reason:window.restoreReason};
      if(method==='session.rewind') return new Promise(resolve=>{
        window.completeRewind = ()=>{
          rewound = true;
          resolve({session:{...initial,engineSessionId:'rewound-provider',lastSeq:7},
            draft:window.expectedDraft,recoveryId:'private-recovery'});
        };
      });
      if(method==='session.input') throw new Error('Rewind must not send a message');
      return {ok:true,pending:[]};
    }};
    window.savedImages = ()=>txn('kv','readonly',store=>store.get('draft-images:fixture-machine:rewind-chat'));
    function Fixture() {
      const [session,setSession] = useState(initial);
      return <DrivenSession client={client} env={{id:'fixture-machine',name:'Fixture machine',online:true}}
        session={session} onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}}
        onSession={updated=>{window.sessionUpdates.push(updated);setSession(updated)}} />;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  styles = (await readFile('apps/web/src/styles.css', 'utf8'))
    .replace(/^@import[^;]+;/gm, '').replace(/@font-face\s*\{[^}]*\}/g, '');
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => {
  await browser?.close();
  rmSync(state, { recursive: true, force: true });
});

for (const width of [390, 1280]) test(`Edit from here confirms a refused file restore and restores the RPC draft without sending at ${width}px`, { timeout: 30_000 }, async t => {
  const context = await browser.newContext({ viewport: { width, height: 850 } });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const errors = [], externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== 'http://helm.test') {
      externalRequests.push(route.request().url()); return route.abort();
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' });
  });
  await page.goto('http://helm.test/');
  await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: script });
  const composer = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await composer.fill('Keep this draft until confirmation');
  await page.getByText('Discarded reply', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.attach-status'));
  const edit = page.getByRole('button', { name: 'Edit from here', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Edit from here', exact: true });
  const mutations = () => page.evaluate(() => window.calls.filter(call => ['session.rewind','session.input'].includes(call.method)));

  await edit.click(); await dialog.waitFor();
  assert.equal(await dialog.getByText('Edit from here?', { exact: true }).isVisible(), true);
  assert.match(await dialog.innerText(), /Helm removes this message and later replies/);
  assert.match(await dialog.innerText(), /This replaces your draft/);
  const restore = dialog.getByRole('checkbox', { name: 'Restore files to before this message', exact: true });
  assert.equal(await restore.isDisabled(), true); assert.equal(await restore.isChecked(), false);
  assert.equal(await dialog.getByText('Another chat can use these files. Continue without restoring files.', { exact: true }).isVisible(), true);
  assert.equal(await composer.inputValue(), 'Keep this draft until confirmation');
  assert.deepEqual(await mutations(), [], 'opening the confirmation only checks availability');
  assert.deepEqual(await page.evaluate(() => window.calls.find(call => call.method === 'session.rewind-check')),
    { env: 'fixture-machine', method: 'session.rewind-check', params: { id: 'rewind-chat', turnId: 'selected-turn' } });

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(await mutations(), [], 'cancel must neither rewind nor send');
  await edit.click(); await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Edit from here', exact: true }).click();
  await page.waitForFunction(() => typeof window.completeRewind === 'function');
  assert.equal(await dialog.getByRole('button', { name: 'Restoring…', exact: true }).isDisabled(), true);
  assert.equal(await composer.inputValue(), 'Keep this draft until confirmation', 'the draft waits for RPC success');
  assert.equal(await page.locator('.attach-preview').count(), 0);
  assert.deepEqual(await mutations(), [{ env: 'fixture-machine', method: 'session.rewind',
    params: { id: 'rewind-chat', turnId: 'selected-turn', restoreFiles: false } }]);

  await page.evaluate(() => window.completeRewind());
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('textarea[data-composer]').value === window.expectedDraft.text);
  const image = page.locator('.attach-preview img'); await image.waitFor();
  await page.waitForFunction(() => document.querySelector('.attach-preview img')?.naturalWidth > 0);
  assert.equal(await image.getAttribute('src'), await page.evaluate(() => 'data:image/png;base64,' + window.expectedDraft.attachments[0].data));
  assert.equal(await page.locator('.attach-preview').getAttribute('title'), '[Image #1] recovered.png');
  assert.equal(await page.getByRole('button', { name: 'Remove chat details: Design review', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Remove chat details: Chat', exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('helm-draft:fixture-machine:rewind-chat')),
    await page.evaluate(() => window.expectedDraft.text));
  assert.deepEqual(await page.evaluate(() => window.savedImages()), await page.evaluate(() => window.expectedDraft.attachments.map(({filename,mime,data}) => ({name:filename,mime,data}))));
  await page.getByText('Chat restored. Edit your draft and send it.', { exact: true }).waitFor();
  await page.getByText('Original transcript wording', { exact: true }).waitFor({ state: 'detached' });
  await page.getByText('Discarded reply', { exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.sessionUpdates.map(session => session.engineSessionId)), ['rewound-provider']);
  assert.equal(await page.getByRole('button', { name: 'send', exact: true }).isEnabled(), true, 'sending is left to the owner');
  assert.equal((await mutations()).length, 1, 'rewind restores a draft and never sends it');
});
