import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, page;
const shot = (name) => process.env.HELM_TEST_SCREENSHOT_DIR
  ? page.screenshot({path:join(process.env.HELM_TEST_SCREENSHOT_DIR,name),animations:'disabled'}) : null;
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
    const store = new Map();
    Object.defineProperty(window,'localStorage',{configurable:true,value:{
      getItem:(name)=>store.has(name) ? store.get(name) : null, setItem:(name,value)=>store.set(name,String(value)),
      removeItem:(name)=>store.delete(name), clear:()=>store.clear(),
    }});
    const agents = [
      { id:'main', title:'Review mobile notifications', engine:'codex', profileId:'codex-personal', status:'working', cwd:'/project' },
      { id:'shared', title:'Inspect the accessibility changes', engine:'claude', profileId:'claude-main', status:'idle', cwd:'/project' },
      { id:'feature', title:'Improve the branch graph', engine:'claude', profileId:'claude-main', status:'blocked', cwd:'/project-feature' },
    ];
    const data = { repo:true, commits:[
      {hash:'merge',parents:['main','feature'],subject:'Merge the graph improvements',author:'Haseeb',refs:['HEAD -> main','origin/main'],date:'2026-10-01'},
      {hash:'feature',parents:['base'],subject:'Show where each agent is working',author:'Claude',refs:['helm/graph'],date:'2026-10-01'},
      {hash:'main',parents:['base'],subject:'Simplify the start screen',author:'Codex',refs:[],date:'2026-10-01'},
      {hash:'base',parents:[],subject:'Initial commit',author:'Haseeb',refs:['tag: v0.1','tag: v0.2','origin/legacy'],date:'2026-09-30'},
    ], worktrees:[
      {path:'/project',branch:'main',head:'merge',current:true,agents:agents.slice(0,2)},
      {path:'/project-feature',branch:'helm/graph',head:'feature',current:false,agents:[agents[2]]},
      {path:'/project-idle',branch:'old',head:'base',current:false,agents:[]},
    ]};
    const client = {
      on: (fn) => {listeners.add(fn);return () => listeners.delete(fn)},
      rpc: async (env,method,params) => {
        (window.calls ??= []).push({env,method,params});
        if(method === 'git.graph') {
          if(window.graphFails > 0){window.graphFails--;throw new Error('git is busy');}
          return data;
        }
        if(method === 'git.pr') return {pr:{number:42,title:'Calmer Git screen',url:'https://example.test/pull/42',state:'OPEN',draft:false,review:null}};
        if(method === 'session.list') return {sessions:agents};
        if(method === 'git.diff') {
          if(window.diffFails > 0){window.diffFails--;throw new Error('diff failed');}
          return {diff:'@@ -1 +1 @@\\n-before\\n+after',truncated:false};
        }
        if(method === 'git.commit') return {hash:params.hash+'0000000',parents:data.commits.find((commit)=>commit.hash===params.hash)?.parents ?? ['base'],
          author:'Claude',date:'2026-10-01T10:00:00Z',
          subject:'Show where each agent is working',body:'Agents appear on the commit they have checked out.',
          files:[{path:'apps/web/src/GitGraph.tsx',add:12,del:3}],
          ...(params.path ? {diff:'diff --git a/x b/x\\n@@ -1 +1 @@\\n-old line\\n+new line',truncated:false} : {})};
      }
    };
    const changed = {repo:true,branch:'main',upstream:'origin/main',ahead:2,behind:0,head:{commit:'merge',subject:'Merge the graph improvements'},
      files:[{path:'App.tsx',status:'M',add:1,del:1},{path:'apps/web/src/session/GitGraph.tsx',status:'A',add:40,del:0}]};
    const clean = {repo:true,branch:'main',upstream:'origin/main',head:{commit:'merge',subject:'Merge the graph improvements'},files:[]};
    window.graphRows = graphRows;
    window.showGit = (which) => root.render(<ChangesPanel key={Math.random()} client={client} env={{id:'local',name:'Laptop',online:true}} cwd='/project'
      status={which === 'clean' ? clean : changed}
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
  await page.getByRole('tab',{name:'Changes 2'}).waitFor();
  assert.equal(await page.getByRole('tab',{name:'Changes 2'}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.git-branch').innerText(),'main');
  assert.equal(await page.locator('.git-sync').getAttribute('aria-label'),'2 ahead');
  const pr = page.getByRole('link',{name:/Pull request #42, open: Calmer Git screen/});
  assert.equal(await pr.getAttribute('href'),'https://example.test/pull/42');
  assert.equal(await page.locator('.bar .sub').innerText().then((text)=>text.includes('main')),false,'the branch is not repeated under the title');
  await page.getByRole('tab',{name:'Graph',exact:true}).click();
  await page.getByText('2 agents share this folder', {exact:false}).waitFor();
  assert.equal(await page.locator('.git-dot').count(),4);
  assert.equal(await page.locator('.git-dot.merge').count(),1);
  assert.equal(await page.locator('.git-ref.head').innerText(),'main');
  assert.equal(await page.locator('.git-checkout.current .git-agent').count(),2);
  assert.equal(await page.locator('.git-checkout:not(.current) .git-agent').count(),1);
  assert.equal(await page.locator('.git-checkout').count(),2,'a checkout with nobody in it stays out of the way');
  assert.equal(await page.locator('.git-row[data-hash="base"] .git-ref:not(.more)').count(),2,'refs beyond the first two fold away');
  assert.equal(await page.locator('.git-row[data-hash="base"] .git-ref.more').innerText(),'+1');
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
  await page.locator('.git-checkout:not(.current)').getByRole('button',{name:/Open Improve the branch graph, Claude Code, Needs you/}).click();
  await page.waitForFunction(()=>window.opened==='feature');
  await shot('git-desktop.png');
});

test('Git tabs remain keyboard accessible and preserve the file diff view', async () => {
  await page.getByRole('tab',{name:'Graph',exact:true}).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByRole('tab',{name:'Changes 2'}).getAttribute('aria-selected'),'true');
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'git-changes-tab');
  await page.keyboard.press('Home');
  assert.equal(await page.getByRole('tab',{name:'Graph',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');
  assert.equal(await page.getByRole('tab',{name:'Changes 2'}).getAttribute('aria-selected'),'true');
  await page.locator('.filemain').first().click();
  await page.getByText('+after',{exact:true}).waitFor();
  await shot('git-desktop-changes.png');
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
  await shot('git-desktop-commit.png');
  const asked = await page.evaluate(()=>window.calls.filter((c)=>c.method==='git.commit').map((c)=>c.params));
  assert.deepEqual(asked.map((p)=>p.path ?? null),[null,'apps/web/src/GitGraph.tsx']);
  await page.locator('.git-line').filter({hasText:'Show where each agent is working'}).click();
  await page.locator('.git-detail').waitFor({state:'detached'});
});

test('a merge links to its parents, folded refs show in full, and refresh reloads the graph', async () => {
  await page.locator('.git-line').filter({hasText:'Merge the graph improvements'}).click();
  await page.getByText('Merge of',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Go to parent feature'}).click();
  await page.locator('.git-row[data-hash="feature"].open').waitFor();
  assert.equal(await page.locator('.git-row[data-hash="merge"].open').count(),0);
  await page.locator('.git-line').filter({hasText:'Initial commit'}).click();
  await page.locator('.git-row[data-hash="base"] .git-detail-refs .git-ref').nth(2).waitFor();
  assert.equal(await page.locator('.git-row[data-hash="base"] .git-detail-refs .git-ref').count(),3);
  const before = await page.evaluate(()=>window.calls.filter((call)=>call.method==='git.graph').length);
  await page.getByRole('button',{name:'Refresh Git'}).click();
  await page.waitForFunction((earlier)=>window.refreshed && window.calls.filter((call)=>call.method==='git.graph').length>earlier,before);
});

test('files can be marked viewed, and a failed diff can be retried', async () => {
  await page.evaluate(()=>{localStorage.clear();window.showGit()});
  await page.getByText('0/2 viewed').waitFor();
  const mark = page.getByRole('button',{name:'mark App.tsx as viewed'});
  await mark.click();
  assert.equal(await mark.getAttribute('aria-pressed'),'true');
  await page.getByText('1/2 viewed').waitFor();
  assert.ok(await page.locator('.fileRow.viewed').count() === 1);
  await shot('git-desktop-changes-collapsed.png');
  assert.ok(Object.keys(JSON.parse(await page.evaluate(()=>localStorage.getItem('helm.viewed:local:/project')))).includes('App.tsx'));
  await mark.click();
  assert.equal(await mark.getAttribute('aria-pressed'),'false');
  await page.getByText('0/2 viewed').waitFor();
  await page.evaluate(()=>{window.diffFails = 1});
  await page.locator('.filemain').nth(1).click();
  await page.getByText('Could not read this diff.').waitFor();
  await page.getByRole('button',{name:'Try again'}).click();
  await page.getByText('+after',{exact:true}).waitFor();
});

test('a clean folder and an unreachable history each say what is going on', async () => {
  await page.evaluate(()=>{window.graphFails = 1;window.showGit('clean')});
  assert.equal(await page.getByRole('tab',{name:'Graph',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.getByRole('tab',{name:'Changes',exact:true}).count(),1,'no zero count on a clean folder');
  await page.getByText('Could not load Git history').waitFor();
  await page.getByText('git is busy').waitFor();
  await page.getByRole('button',{name:'Try again'}).click();
  await page.getByText('2 agents share this folder', {exact:false}).waitFor();
  await page.getByRole('tab',{name:'Changes',exact:true}).click();
  await page.getByText('Working tree clean').waitFor();
  await page.getByText('merge · Merge the graph improvements').waitFor();
  await shot('git-desktop-clean.png');
});

test('graph and branded notifications fit a phone, and dismissal does not navigate', async () => {
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.showGit());
  await page.locator('.changes').waitFor({state:'visible'});
  await page.getByRole('tab',{name:'Graph',exact:true}).click();
  await page.getByText('2 agents share this folder', {exact:false}).waitFor();
  await page.evaluate(()=>window.showToast());
  await page.getByRole('button',{name:'Dismiss notification'}).waitFor();
  const bounds = await page.locator('.toast').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.equal((await page.locator('.toast').innerText()).replace(/\s+/g,' '),'Codex needs you Review mobile notifications');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true);
  await shot('git-notification-phone.png');
  await page.getByRole('button',{name:'Dismiss notification'}).click();
  await page.locator('.toast').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>!!window.toastOpened),false);
  await page.evaluate(()=>window.showToast());
  await page.locator('.toast-open').click();
  await page.waitForFunction(()=>window.toastOpened);
});

test('on a phone the Git screen keeps to the width and its controls stay easy to tap', async () => {
  await page.evaluate(()=>{localStorage.clear();window.showGit()});
  await page.getByRole('tab',{name:'Graph',exact:true}).click();
  await page.locator('.git-line').first().waitFor();
  const fits = () => page.evaluate(()=>[...document.querySelectorAll('.changes *')].every((element)=>{
    const rect = element.getBoundingClientRect();
    return rect.width === 0 || (rect.left >= -1 && rect.right <= window.innerWidth + 1) || element.closest('.diff,.git-lanes,.git-through');
  }));
  assert.equal(await fits(),true,'nothing in the graph spills off the side');
  for (const tab of await page.getByRole('tab').all()) assert.ok((await tab.boundingBox()).height >= 40, 'tabs are tall enough to tap');
  const tabs = await Promise.all((await page.getByRole('tab').all()).map((tab)=>tab.boundingBox()));
  assert.ok(Math.abs(tabs[0].width - tabs[1].width) < 2, 'the two tabs share the width evenly');
  for (const agent of await page.locator('.git-agent').all()) assert.ok((await agent.boundingBox()).height >= 40);
  assert.equal(await page.locator('.git-sha').first().isVisible(),false,'short hashes give way to the subject on a phone');
  await shot('git-mobile-graph.png');
  await page.locator('.git-line').filter({hasText:'Show where each agent is working'}).click();
  await page.locator('.git-file-row').click();
  await page.getByText('+new line',{exact:true}).waitFor();
  assert.equal(await fits(),true,'an opened commit keeps to the width');
  await page.locator('.git-row.open').scrollIntoViewIfNeeded();
  await shot('git-mobile-commit-expanded.png');
  await page.locator('.git-line').filter({hasText:'Show where each agent is working'}).click();
  await page.locator('.git-detail').waitFor({state:'detached'});
  await page.getByRole('tab',{name:'Changes 2'}).click();
  await page.locator('.filemain').first().waitFor();
  await shot('git-mobile-changes-collapsed.png');
  await page.locator('.filemain').first().click();
  await page.getByText('+after',{exact:true}).waitFor();
  assert.equal(await fits(),true,'nothing in the file list spills off the side');
  for (const toggle of await page.locator('.viewedbox').all()) {
    const box = await toggle.boundingBox();
    assert.ok(box.width >= 40 && box.height >= 40, 'the viewed toggle is a full-size target');
  }
  for (const fileRow of await page.locator('.filemain').all()) assert.ok((await fileRow.boundingBox()).height >= 44);
  await shot('git-mobile-changes.png');
  await page.evaluate(()=>document.documentElement.dataset.theme = 'light');
  await shot('git-mobile-changes-light.png');
  await page.evaluate(()=>delete document.documentElement.dataset.theme);
});
