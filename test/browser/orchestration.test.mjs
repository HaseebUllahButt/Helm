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
    import { LimitsLine } from './apps/web/src/session/LimitsLine';
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
      return <Composer draft={draft} setDraft={setDraft} engine="Claude" keys={false} working
        onSend={()=>{window.sent={draft,references}}}
        referenceOptions={[{id:'design',title:'Design review'}]} references={references}
        onReference={id=>setReferences([{id,title:'Design review'}])} onRemoveReference={()=>setReferences([])}
        queued={[{turn:{id:'one'},text:'First task',attachments:0},{turn:{id:'two'},text:'Second task',attachments:0}]}
        onEditQueued={turn=>window.action=['edit',turn.id]} onRemoveQueued={turn=>window.action=['remove',turn.id]}
        onMoveQueued={(turn,direction)=>window.action=['move',turn.id,direction]}
        onSendQueued={turn=>window.action=['send',turn.id]} />;
    }
    function Details() { return <ThreadDetails client={client} env={env} session={session} tab='agents' git={null} reloadGit={()=>{}} onClose={()=>root.render(null)} />; }
    function ComposeImages() {
      const [draft,setDraft]=useState('Compare '); const [attachments,setAttachments]=useState([]);
      window.imageDraft=()=>draft;
      const px=(i)=>{ const c=document.createElement('canvas'); c.width=160; c.height=110; const g=c.getContext('2d'); g.fillStyle=['#3b82f6','#10b981','#f59e0b'][i%3]; g.fillRect(0,0,160,110); return c.toDataURL(); };
      return <Composer draft={draft} setDraft={setDraft} engine="Claude" keys={false} onSend={()=>{}}
        attachments={attachments} onRemoveAttachment={i=>setAttachments(a=>a.filter((_,j)=>j!==i))}
        onAttach={async files=>{ const next=[...files].map((f,i)=>({name:f.name,mime:'image/png',data:'',url:px(i+f.name.charCodeAt(0))})); setAttachments(a=>[...a,...next]); return next; }} />;
    }
    function ComposeLimits() {
      const [draft,setDraft] = useState('Test message');
      return <Composer draft={draft} setDraft={setDraft} engine="Claude" keys={false} working onStop={()=>window.stopped=true}
        onSend={()=>window.limitSent=true} onAttach={()=>{}} onTranscribe={async ()=>''}
        foot={<div className="chips">{['Model','Thinking','Permissions','Speed'].map(name=><button key={name} className="chip-pick" aria-label={name} onClick={()=>window.limitControl=name}><span className="cg">●</span><span className="chip-label">{name}</span></button>)}</div>}
        statusLine={<LimitsLine windows={[{label:'5h',used:87},{label:'7d',used:96}]}/>}/>;
    }
    function ComposeTiming() {
      const [draft,setDraft] = useState('');
      return <Composer draft={draft} setDraft={setDraft} engine="Devin" keys={false} working onSend={()=>{}}
        pendingLabel="After current response"
        queued={[
          {turn:{id:'sent',delivered:true},text:'Already with the CLI',attachments:0,delivered:true},
          {turn:{id:'auto',delivery:'auto'},text:'Follows the CLI',attachments:0},
          {turn:{id:'held',delivery:'queue'},text:'A scheduled prompt',attachments:0},
        ]}
        onEditQueued={()=>{}} onRemoveQueued={()=>{}} onMoveQueued={()=>{}}
        onSendQueued={turn=>window.action=['send',turn.id]} />;
    }
    window.showTiming=()=>root.render(<ComposeTiming/>);
    window.showLimits=()=>root.render(<ComposeLimits/>);
    window.showComposer=()=>root.render(<Compose/>);
    window.showImages=()=>root.render(<ComposeImages/>);
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

test('composer selects thread references and sends without a delivery selector', async (context) => {
  const page = await pageFor(context, 390);
  await page.evaluate(() => window.showComposer());
  const input = page.getByLabel('Message Claude', {exact:true});
  await input.fill('Check @des');
  await page.getByRole('listbox', { name: 'Attach thread context' }).waitFor();
  await input.press('Enter');
  await page.getByRole('button', { name: 'Remove context: Design review' }).waitFor();
  assert.equal(await input.inputValue(), 'Check ');
  assert.equal(await page.getByLabel('Message delivery').count(), 0);
  assert.equal(await page.getByText('After this task', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'send', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.sent), { draft: 'Check ', references: [{ id: 'design', title: 'Design review' }] });
  await page.getByRole('button', { name: 'Move up: Second task' }).click();
  assert.deepEqual(await page.evaluate(() => window.action), ['move', 'two', -1]);
  await page.getByRole('button', { name: 'Remove queued message: First task' }).click();
  assert.deepEqual(await page.evaluate(() => window.action), ['remove', 'one']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, 'orchestration-composer-phone.png');
});

test('waiting messages say when the CLI reads them, and Send now is offered on every CLI', async (context) => {
  const page = await pageFor(context, 390);
  await page.evaluate(() => window.showTiming());
  const row = (text) => page.locator('.queued-row').filter({ hasText: text });
  await row('Follows the CLI').getByText('After current response', { exact: true }).waitFor();
  await row('A scheduled prompt').getByText('After this task', { exact: true }).waitFor();
  const sent = row('Already with the CLI');
  await sent.getByText('Sent to CLI', { exact: true }).waitFor();
  assert.equal(await sent.getByRole('button').count(), 0, 'what the CLI has cannot be edited or taken back');
  assert.equal(await sent.locator('.queued-timing').count(), 0);
  await row('Follows the CLI').getByRole('button', { name: 'Send now', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.action), ['send', 'auto']);
  assert.equal(await row('A scheduled prompt').getByRole('button', { name: 'Send now', exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, 'queue-timing-phone.png');
});

test('pasted images are labelled where the cursor was and renumbered when one goes', async (context) => {
  const page = await pageFor(context, 390);
  await page.evaluate(() => window.showImages());
  const input = page.getByLabel('Message Claude', {exact:true});
  await input.click();
  await input.press('End');
  const paste = (names) => page.evaluate((names) => {
    const dt = new DataTransfer();
    for (const name of names) dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' }));
    document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, names);
  await paste(['a.png']);
  await page.waitForFunction(() => window.imageDraft() === 'Compare [Image #1] ');
  await input.press('End');
  await input.pressSequentially('with ');
  await paste(['b.png', 'c.png']);
  await page.waitForFunction(() => window.imageDraft() === 'Compare [Image #1] with [Image #2] [Image #3] ');
  assert.equal(await page.locator('.attach-preview').nth(1).getAttribute('title'), '[Image #2] b.png');
  await page.screenshot({ path: '/tmp/helm-image-labels.png' });
  await page.getByRole('button', { name: 'remove Image #1' }).dispatchEvent('click');
  await page.waitForFunction(() => window.imageDraft() === 'Compare with [Image #1] [Image #2] ');
  assert.equal(await page.locator('.attach-preview').count(), 2);
});

test('the agents panel is only agents: no Git, Schedules or Browser tabs, and it fits a phone', async (context) => {
  const page = await pageFor(context, 390);
  await page.evaluate(() => window.showDetails());
  const dialog = page.getByRole('dialog', { name: 'Agents' });
  await dialog.getByRole('heading', { name: 'Agents' }).waitFor();
  assert.equal(await dialog.getByRole('tab').count(), 0);
  assert.equal(await dialog.getByText('Automations').count(), 0);
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


test('account limits occupy their own row without covering mobile composer controls', async context => {
  const page = await pageFor(context, 390);
  for (const width of [320,390,600,1280]) {
    await page.setViewportSize({width,height:850});
    await page.evaluate(()=>window.showLimits());
    await page.getByText('Account limits',{exact:true}).waitFor();
    assert.equal(await page.locator('.limits-line .lw').count(),2,'both windows stay visible');
    const bounds = await page.locator('.slab-status').boundingBox();
    const buttons = await page.locator('.slab-foot button').all();
    for (const button of buttons) {
      // Settings intentionally scroll horizontally on narrow phones.
      await button.scrollIntoViewIfNeeded();
      const b = await button.boundingBox();
      assert.ok(b.x>=0 && b.x+b.width<=width, 'every control stays on screen');
      assert.ok(b.y+b.height<=bounds.y+1, 'usage never overlaps a control');
    }
    await page.getByRole('button',{name:'Permissions',exact:true}).scrollIntoViewIfNeeded();
    await page.getByRole('button',{name:'Permissions',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.limitControl),'Permissions');
    await page.getByRole('button',{name:'send',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.limitSent),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(width===390) await capture(page,'composer-limits-mobile.png');
  }
});
