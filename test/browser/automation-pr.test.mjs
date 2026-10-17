import '../automation-env.mjs';
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
    import { PullRequests } from './apps/web/src/session/PullRequests';
    import { RecoveryCard } from './apps/web/src/session/RecoveryCard';
    import { Pipeline } from './apps/web/src/session/Pipeline';
    const root = createRoot(document.getElementById('root'));
    const env = {id:'local',name:'Test machine',online:true};
    const session = {id:'thread',driver:'codex',engine:'codex',cwd:'/project',status:'idle',autoResumeLimited:false};
    const sha = 'a'.repeat(40);
    const pr = {number:42,title:'New feature',body:'A useful change',state:'OPEN',draft:false,author:'reviewer',headSha:sha,head:'feature',base:'main',mergeable:'MERGEABLE',mergeState:'clean',url:'https://example.test/pr/42'};
    window.calls=[];window.schedules=[];window.agentEnabled=false;window.notifyEnabled=false;window.maxWakes=5;
    const client = {rpc:async (env,method,params) => {
      window.calls.push({method,params});
      if(method === 'schedule.list') return {schedules:window.schedules};
      if(method === 'schedule.save') {
        const current=window.schedules.find(s=>s.id===params.id)||{};
        const row={...current,...params,id:params.id||'task',enabled:params.enabled??true,nextRunAt:Date.now()+3600000};
        if(row.type==='webhook'){row.nextRunAt=null;row.webhook={url:'https://helm-hooks-test.example.test/hooks/task/secret',path:'/hooks/task/secret',hasSecret:!!params.hmacSecret};delete row.hmacSecret;}
        window.schedules=[row];return {schedule:row};
      }
      if(method==='schedule.run') return {ok:true,sessionId:'fresh'};
      if(method==='session.list') return {sessions:[{...session,id:'fresh',title:'Automation result'}]};
      if(method==='session.auto-resume'){session.autoResumeLimited=params.on;return {session};}
      if(method==='git.prs') return {pullRequests:[pr],more:false};
      if(method==='git.pr-detail') return {pr,account:'work',comments:[{id:1,kind:'comment',author:'reviewer',body:'Please add tests',at:new Date().toISOString()}],files:[{path:'App.tsx',additions:2,deletions:1,patch:'@@ -1 +1 @@\\n-before\\n+after'}],checks:[{id:1,name:'Unit tests',state:'success'}]};
      if(method==='git.pr-action') return {ok:true};
      if(method==='git.status') return {files:[{path:'App.tsx'}]};
      if(method==='git.publish') return {ok:true,completed:['commit','push','create'],pr};
      if(method==='git.accounts') return {selected:'work',accounts:[{login:'work',valid:true}]};
      if(method==='git.watch'){if(params.agent!=null)window.agentEnabled=params.agent;else window.notifyEnabled=params.on;if(params.maxWakes)window.maxWakes=params.maxWakes;return {watching:window.notifyEnabled};}
      throw new Error('Unexpected UI request '+method);
    }};
    window.showPRs=()=>root.render(<PullRequests client={client} env={env} cwd='/project' account='work' onChanged={()=>{}}/>);
    window.showRecovery=()=>root.render(<RecoveryCard recovery={{kind:'limited',message:'Usage limit',at:1,resetAt:Date.now()+60000}} busy={false} offline={false} autoResume={session.autoResumeLimited}
      onAutoResume={on=>{window.calls.push({method:'session.auto-resume',params:{on}});session.autoResumeLimited=on;window.showRecovery();}} onRetry={()=>window.retried=true}/>);
    window.showPipeline=()=>root.render(<Pipeline client={client} env={env} cwd='/project' sessionId='thread' data={{supported:true,account:'work',errors:[],checkedAt:Date.now(),watching:window.notifyEnabled,
      agentWatch:{enabled:window.agentEnabled,maxWakes:window.maxWakes,wakes:0,pending:false},checks:[],runs:[],deployments:[]}} error='' loading={false} refresh={()=>window.showPipeline()}
      watch={async()=>{await client.rpc('local','git.watch',{sessionId:'thread',on:!window.notifyEnabled});window.showPipeline();}} watchBusy={false}/>);
  `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());
async function pageFor(t, show) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } }); t.after(() => page.close());
  page.setDefaultTimeout(5000);
  await page.setContent('<div id="root" style="padding:20px"></div>');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await page.addScriptTag({ content: script }); await page.evaluate(name => window[name](), show); return page;
}

test('usage recovery opt-in sends a preference and keeps manual resume available', { timeout: 15000 }, async t => {
  const page = await pageFor(t, 'showRecovery'); await page.getByLabel('Continue automatically at reset', { exact: true }).check();
  assert.equal(await page.evaluate(() => window.calls.at(-1).params.on), true);
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); assert.equal(await page.evaluate(() => window.retried), true);
});

test('PR actions send comments, head-bound reviews and an explicitly confirmed merge', { timeout: 15000 }, async t => {
  const page = await pageFor(t, 'showPRs'); await page.locator('details.pull-requests > summary').click(); await page.getByRole('button', { name: '#42 New feature', exact: true }).click();
  await page.getByLabel('Comment / review', { exact: true }).fill('Please add coverage'); await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c.method === 'git.pr-action' && c.params.action === 'comment'));
  await page.getByLabel('Review', { exact: true }).selectOption('APPROVE'); await page.getByRole('button', { name: 'Submit review', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c.params.action === 'review'));
  const review = await page.evaluate(() => window.calls.find(c => c.params.action === 'review').params); assert.equal(review.headSha, 'a'.repeat(40)); assert.equal(review.event, 'APPROVE');
  const merge = page.getByRole('button', { name: 'Merge pull request', exact: true }); assert.equal(await merge.isDisabled(), true);
  await page.getByLabel(/Merge PR #42 at/).check(); await merge.click();
  await page.waitForFunction(() => window.calls.some(c => c.params.action === 'merge'));
  assert.equal(await page.evaluate(() => window.calls.find(c => c.params.action === 'merge').params.headSha), 'a'.repeat(40));
});

test('publishing sends selected files and complete PR metadata', { timeout: 15000 }, async t => {
  const page = await pageFor(t, 'showPRs'); await page.locator('details.pull-requests > summary').click(); await page.getByRole('button', { name: 'Commit / push / create PR', exact: true }).click();
  await page.getByLabel('Commit message', { exact: true }).fill('Add feature'); await page.getByLabel('App.tsx', { exact: true }).check();
  await page.getByLabel('PR title', { exact: true }).fill('Feature PR'); await page.getByLabel('Description', { exact: true }).fill('Feature details');
  await page.getByRole('button', { name: 'Commit, push and create PR', exact: true }).click(); await page.waitForFunction(() => window.calls.some(c => c.method === 'git.publish'));
  const params = await page.evaluate(() => window.calls.find(c => c.method === 'git.publish').params); assert.deepEqual(params.paths, ['App.tsx']); assert.equal(params.action, 'publish'); assert.equal(params.title, 'Feature PR');
});

test('agent wake and notification controls toggle independently', { timeout: 15000 }, async t => {
  const page = await pageFor(t, 'showPipeline'); await page.locator('.pipeline > details.fold > summary', { hasText: 'Settings' }).click(); await page.getByRole('switch', { name: 'Wake agent on GitHub changes', exact: true }).click();
  await page.waitForFunction(() => window.agentEnabled); assert.equal(await page.getByRole('switch', { name: 'Notify this thread about CI / CD', exact: true }).getAttribute('aria-checked'), 'false');
  await page.getByRole('switch', { name: 'Notify this thread about CI / CD', exact: true }).click(); await page.waitForFunction(() => window.notifyEnabled);
  assert.equal(await page.getByRole('switch', { name: 'Wake agent on GitHub changes', exact: true }).getAttribute('aria-checked'), 'true');
});
