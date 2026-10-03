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
  await page.getByRole('button',{name:/Review the vulnerability/}).click();
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
  await page.getByRole('button', { name:/Review the vulnerability/ }).click();
  await page.getByRole('button', { name:'Hide finished task' }).click();
  assert.equal(await page.locator('.delegation-branch').count(), 0);
  assert.ok(await page.evaluate(() => window.calls.some(c=>c.method==='session.archive'&&c.params.id==='child'&&c.params.archived)));
  await page.getByRole('button', { name:'Close subagents' }).click();
});
