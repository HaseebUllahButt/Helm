import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, page;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ChangesPanel } from './apps/web/src/session/Changes';
    import { graphRows } from './apps/web/src/session/GitGraph';
    import { NotificationToast } from './apps/web/src/NotificationToast';
    const root = createRoot(document.getElementById('root'));
    const toast = createRoot(document.getElementById('toast'));
    const listeners = new Set();
    const agents = [
      { id:'main', title:'Review mobile notifications', engine:'codex', profileId:'codex-personal', status:'working', cwd:'/project' },
      { id:'shared', title:'Inspect the accessibility changes', engine:'claude', profileId:'claude-main', status:'idle', cwd:'/project' },
      { id:'feature', title:'Improve the branch graph', engine:'claude', profileId:'claude-main', status:'blocked', cwd:'/project-feature' },
    ];
    const data = { repo:true, commits:[
      {hash:'merge',parents:['main','feature'],subject:'Merge the graph improvements',author:'Haseeb',refs:['HEAD -> main'],date:'2026-10-01'},
      {hash:'feature',parents:['base'],subject:'Show where each agent is working',author:'Claude',refs:['helm/graph'],date:'2026-10-01'},
      {hash:'main',parents:['base'],subject:'Simplify the start screen',author:'Codex',refs:[],date:'2026-10-01'},
      {hash:'base',parents:[],subject:'Initial commit',author:'Haseeb',refs:[],date:'2026-09-30'},
    ], worktrees:[
      {path:'/project',branch:'main',head:'merge',current:true,agents:agents.slice(0,2)},
      {path:'/project-feature',branch:'helm/graph',head:'feature',current:false,agents:[agents[2]]},
    ]};
    const client = {
      on: (fn) => {listeners.add(fn);return () => listeners.delete(fn)},
      rpc: async (env,method,params) => {
        (window.calls ??= []).push({env,method,params});
        if(method === 'git.graph') return data;
        if(method === 'git.pr') return {pr:null};
        if(method === 'session.list') return {sessions:agents};
        if(method === 'git.diff') return {diff:'@@ -1 +1 @@\\n-before\\n+after',truncated:false};
        if(method === 'git.commit') return {hash:params.hash+'0000000',parents:['base'],author:'Claude',date:'2026-10-01T10:00:00Z',
          subject:'Show where each agent is working',body:'Agents appear on the commit they have checked out.',
          files:[{path:'apps/web/src/GitGraph.tsx',add:12,del:3}],
          ...(params.path ? {diff:'diff --git a/x b/x\\n@@ -1 +1 @@\\n-old line\\n+new line',truncated:false} : {})};
      }
    };
    window.graphRows = graphRows;
    window.showGit = () => root.render(<ChangesPanel client={client} env={{id:'local',name:'Laptop',online:true}} cwd='/project'
      status={{repo:true,branch:'main',head:{commit:'merge'},files:[{path:'App.tsx',status:'M',add:1,del:1}]}}
      reload={()=>{window.refreshed = true}} onClose={()=>root.render(null)} onOpen={(s)=>{window.opened = s.id}} />);
    window.showToast = () => toast.render(<NotificationToast session={{...agents[0],title:'Review mobile notifications https://private.test /home/me/project'}}
      onOpen={()=>{window.toastOpened=true;toast.render(null)}} onDismiss={()=>{window.dismissed=true;toast.render(null)}} />);
    window.notifyChange = () => listeners.forEach((fn)=>fn('local','session.update',{}));
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true,write:false,format:'iife',jsx:'automatic' });
  browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  page = await browser.newPage({viewport:{width:1280,height:900}});
  await page.setContent('<div class="main showing" style="height:100vh;width:100%"><div id="root"></div></div><div id="toast"></div>');
  await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
});
after(async () => {await browser?.close()});

test('graph shows merges and live agents on their checkouts, and opens the selected thread', async () => {
  await page.evaluate(()=>window.showGit());
  await page.getByRole('tab',{name:'Changes 1'}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'Changes 1'}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:'Graph',exact:true}).click();
  await page.getByText('2 agents share this folder', {exact:false}).waitFor();
  assert.equal(await page.locator('.git-dot').count(),4);
  assert.equal(await page.locator('.git-dot.merge').count(),1);
  assert.equal(await page.locator('.git-ref.head').innerText(),'main');
  assert.equal(await page.locator('.git-checkout.current .git-agent').count(),2);
  assert.equal(await page.locator('.git-checkout:not(.current) .git-agent').count(),1);
  const rows = await page.evaluate(()=>window.graphRows([
    {hash:'merge',parents:['a','b']},{hash:'a',parents:['root']},{hash:'b',parents:['root']},{hash:'root',parents:[]}
  ]));
  assert.deepEqual(rows[0].after,['a','b']);
  assert.deepEqual(rows[2].after,['root']);
  assert.deepEqual(rows[3].after,[]);
  assert.ok(rows.every((r)=>r.edges.every((e)=>e.to >= 0)));
  // A side line that reaches the shared parent first bends into the
  // mainline; the mainline keeps its column and its colour.
  const side = await page.evaluate(()=>window.graphRows([
    {hash:'M',parents:['A','F']},{hash:'F',parents:['B']},{hash:'A',parents:['B']},{hash:'B',parents:[]}
  ]));
  assert.deepEqual(side.map((r)=>r.lane),[0,1,0,0]);
  assert.equal(side[3].colour,side[0].colour);
  assert.notEqual(side[1].colour,side[0].colour);
  await page.locator('.git-checkout:not(.current)').getByRole('button',{name:/Open Improve the branch graph/}).click();
  await page.waitForFunction(()=>window.opened==='feature');
  if(process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.HELM_TEST_SCREENSHOT_DIR,'git-desktop.png'),animations:'disabled'});
});

test('Git tabs remain keyboard accessible and preserve the file diff view', async () => {
  await page.getByRole('tab',{name:'Graph',exact:true}).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByRole('tab',{name:'Changes 1'}).getAttribute('aria-selected'),'true');
  await page.locator('.filemain').click();
  await page.getByText('+after',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'Graph',exact:true}).click();
  await page.getByText('2 agents share this folder', {exact:false}).waitFor();
  const before = await page.evaluate(()=>window.calls.filter((c)=>c.method==='git.graph').length);
  await page.evaluate(()=>window.notifyChange());
  await page.waitForFunction((n)=>window.calls.filter((c)=>c.method==='git.graph').length>n,before);
});

test('a commit opens to its message and files, and a file to its diff', async () => {
  await page.locator('.git-line').filter({hasText:'Show where each agent is working'}).click();
  await page.getByText('Agents appear on the commit they have checked out.').waitFor();
  assert.ok(await page.locator('.git-through').count() >= 1, 'lanes carry on beside the opened commit');
  await page.locator('.git-file-row').click();
  await page.getByText('+new line',{exact:true}).waitFor();
  const asked = await page.evaluate(()=>window.calls.filter((c)=>c.method==='git.commit').map((c)=>c.params));
  assert.deepEqual(asked.map((p)=>p.path ?? null),[null,'apps/web/src/GitGraph.tsx']);
  await page.locator('.git-line').filter({hasText:'Show where each agent is working'}).click();
  await page.locator('.git-detail').waitFor({state:'detached'});
});

test('graph and branded notifications fit a phone, and dismissal does not navigate', async () => {
  await page.setViewportSize({width:390,height:844});
  await page.locator('.changes').waitFor({state:'visible'});
  await page.evaluate(()=>window.showToast());
  await page.getByRole('button',{name:'Dismiss notification'}).waitFor();
  const bounds = await page.locator('.toast').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal((await page.locator('.toast').innerText()).replace(/\s+/g,' '),'Helm Codex needs you Review mobile notifications › ×');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true);
  if(process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.HELM_TEST_SCREENSHOT_DIR,'git-notification-phone.png'),animations:'disabled'});
  await page.getByRole('button',{name:'Dismiss notification'}).click();
  await page.locator('.toast').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>!!window.toastOpened),false);
  await page.evaluate(()=>window.showToast());
  await page.locator('.toast-open').click();
  await page.waitForFunction(()=>window.toastOpened);
});
