import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { join } from 'node:path';

let browser, bundle, styles;
const capture = (page, name) => process.env.HELM_TEST_SCREENSHOT_DIR && page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, name) });
before(async () => {
  bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Composer } from './apps/web/src/session/Composer';
    import { ThreadDetails } from './apps/web/src/session/ThreadDetails';
    import { TeamSummary } from './apps/web/src/session/TeamSummary';
    const root = createRoot(document.getElementById('root'));
    const env = {id:'laptop',name:'Laptop',online:true,info:{}};
    const session = {id:'parent',title:'Build the dashboard',cwd:'/project',engine:'claude',profileId:'claude-work',driver:'claude',status:'idle',model:'opus',
      lastUsage:{input:10,cacheRead:9000,cacheWrite:990,inputIncludesCache:false,at:1000000}};
    let schedules = [];
    const client = { on:()=>()=>{}, rpc:async (env,method,params)=>{
      (window.calls ??= []).push({env,method,params});
      if(method==='schedule.list') return {schedules};
      if(method==='schedule.save') { const old=schedules.find(item=>item.id===params.id); const record={...old,...params,id:params.id||'schedule',enabled:params.enabled??old?.enabled??true,nextRunAt:Date.now()+3600000}; schedules=[...schedules.filter(item=>item.id!==record.id),record]; return {schedule:record}; }
      if(method==='schedule.delete') { schedules=schedules.filter(item=>item.id!==params.id); return {ok:true}; }
      if(method==='session.list') return {sessions:[]};
      if(method==='agent.list') return {agents:[]};
      return {ok:true};
    }};
    function Compose() {
      const [draft,setDraft]=useState(''); const [references,setReferences]=useState([]);
      return <Composer draft={draft} setDraft={setDraft} engine="Claude" keys={false} working steers
        onSend={()=>{window.sent={draft,references}}}
        referenceOptions={[{id:'design',title:'Design review'}]} references={references}
        onReference={id=>setReferences([{id,title:'Design review'}])} onRemoveReference={()=>setReferences([])}
        queued={[{turn:{id:'one'},text:'First task',attachments:0},{turn:{id:'two'},text:'Second task',attachments:0}]}
        onEditQueued={turn=>window.action=['edit',turn.id]} onRemoveQueued={turn=>window.action=['remove',turn.id]}
        onMoveQueued={(turn,direction)=>window.action=['move',turn.id,direction]}
        onSendQueued={turn=>window.action=['send',turn.id]} />;
    }
    function Details() { const [tab,onTab]=useState('overview'); return <ThreadDetails client={client} env={env} session={session} tab={tab} onTab={onTab} git={null} reloadGit={()=>{}} onClose={()=>root.render(null)} />; }
    window.showComposer=()=>root.render(<Compose/>);
    window.showDetails=()=>root.render(<Details/>);
    window.showTeam=()=>root.render(<TeamSummary team={[
      {session:{...session,id:'worker',title:'Build the form',createdAt:Date.now()-120000,delegation:{status:'working'}},depth:0},
      {session:{...session,id:'reviewer',title:'Review access rules',delegation:{status:'blocked'}},depth:1},
      {session:{...session,id:'done',title:'Inspect dependencies',delegation:{status:'done',summary:'No dependency changes needed.'}},depth:0}
    ]} onManage={()=>window.managed=true} onOpen={item=>window.opened=item.id} onStop={()=>window.stopped=true} onReview={()=>window.review=true}/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  styles = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

async function pageFor(context, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 850 } });
  page.setDefaultTimeout(5000);
  context.after(() => page.close());
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}

test('composer selects thread references with the keyboard and has no delivery picker', async (context) => {
  const page = await pageFor(context, 390);
  await page.evaluate(() => window.showComposer());
  const input = page.getByPlaceholder('Message Claude…');
  await input.fill('Check @des');
  await page.getByRole('listbox', { name: 'Attach thread context' }).waitFor();
  await input.press('Enter');
  await page.getByRole('button', { name: 'Remove context: Design review' }).waitFor();
  assert.equal(await input.inputValue(), 'Check ');
  assert.equal(await page.getByLabel('Message delivery').count(), 0);
  await page.getByRole('button', { name: 'send', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.sent), { draft: 'Check ', references: [{ id: 'design', title: 'Design review' }] });
  await page.getByRole('button', { name: 'Move up: Second task' }).click();
  assert.deepEqual(await page.evaluate(() => window.action), ['move', 'two', -1]);
  await page.getByRole('button', { name: 'Remove queued message: First task' }).click();
  assert.deepEqual(await page.evaluate(() => window.action), ['remove', 'one']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, 'orchestration-composer-phone.png');
});

test('thread details create, pause, run and delete a schedule on the selected machine', async (context) => {
  const page = await pageFor(context, 390);
  await page.evaluate(() => window.showDetails());
  const dialog = page.getByRole('dialog', { name: 'Thread details' });
  await dialog.getByRole('tab', { name: 'Schedules' }).click();
  await dialog.getByRole('button', { name: 'New scheduled task' }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Morning review');
  await dialog.getByLabel('Task', { exact: true }).fill('Review open changes');
  await dialog.getByLabel('Every (minutes)').fill('1440');
  await dialog.getByRole('button', { name: 'Save schedule' }).click();
  await dialog.getByRole('button', { name: 'Pause', exact: true }).click();
  await dialog.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Run now' }).click();
  await dialog.getByText('Task sent. Its result appears in this conversation.').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, 'orchestration-schedules-phone.png');
  assert.equal(await page.evaluate(() => window.calls.every(call => call.env === 'laptop')), true);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByText('No scheduled tasks for this thread.').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('team summary surfaces blocked descendants and keeps completed results compact', async (context) => {
  const page = await pageFor(context, 390);
  await page.evaluate(() => window.showTeam());
  await page.locator('.team-summary summary').click();
  assert.match(await page.locator('.team-summary summary').textContent(), /1 working · 1 need approval/);
  await page.getByText('No dependency changes needed.').waitFor();
  await page.getByRole('button', { name: /Review access rules/ }).click();
  assert.equal(await page.evaluate(() => window.opened), 'reviewer');
  await page.getByRole('button', { name: 'Stop all' }).click();
  assert.equal(await page.evaluate(() => window.stopped), true);
  const icon = await page.locator('.team-task .mark').first().boundingBox();
  assert.ok(icon.width < 40, 'the provider icon must not stretch across the task row');
  await capture(page, 'orchestration-team-phone.png');
});
