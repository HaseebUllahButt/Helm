import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, page;
/** An added diff line. Its "+" sign is a piece of its own, so match the code after it. */
const addedLine = (scope, text) => scope.locator('.cv-row.add .cv-c', {hasText:new RegExp(`^${text}$`)});
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ChangesPanel } from './apps/web/src/session/Changes';
    import { graphRows } from './apps/web/src/session/GitGraph';
    const root = createRoot(document.getElementById('root'));
    const store = new Map();
    Object.defineProperty(window,'localStorage',{configurable:true,value:{
      getItem:(name)=>store.has(name) ? store.get(name) : null, setItem:(name,value)=>store.set(name,String(value)),
      removeItem:(name)=>store.delete(name), clear:()=>store.clear(),
    }});
    const agents = [
      { id:'main', title:'Review mobile notifications', engine:'codex', profileId:'codex-personal', status:'working', cwd:'/project' },
      { id:'feature', title:'Improve the branch graph', engine:'claude', profileId:'claude-main', status:'blocked', cwd:'/project-feature' },
    ];
    const data = { repo:true, commits:[
      {hash:'merge',parents:['main','feature'],subject:'Merge the graph improvements',author:'Haseeb',refs:['HEAD -> main'],date:'2026-10-01'},
      {hash:'feature',parents:['base'],subject:'Show where each agent is working',author:'Claude',refs:['helm/graph'],date:'2026-10-01'},
      {hash:'main',parents:['base'],subject:'Simplify the start screen',author:'Codex',refs:[],date:'2026-10-01'},
      {hash:'base',parents:[],subject:'Initial commit',author:'Haseeb',refs:[],date:'2026-09-30'},
    ], worktrees:[
      {path:'/project',branch:'main',head:'merge',current:true,agents:[agents[0]]},
      {path:'/project-feature',branch:'helm/graph',head:'feature',current:false,agents:[agents[1]]},
    ]};
    const client = {
      on: () => () => {},
      rpc: async (env,method,params) => {
        (window.calls ??= []).push({env,method,params});
        if(method === 'git.graph') return data;
        if(method === 'git.monitor') return {supported:true,repository:'owner/project',sha:'merge',checkedAt:Date.now(),errors:[],checksState:'failure',checks:[],deployments:[],
          runs:[{id:91,name:'Build and deploy',state:'failure',attempt:window.monitorAttempt || 1,event:'push',sha:'merge',url:'https://example.test/actions/91'}]};
        if(method === 'git.prs') return {pullRequests:[],more:false};
        if(method === 'git.accounts') return {selected:'auto',accounts:[]};
        if(method === 'git.jobs') return {jobs:[{id:7,name:'Build',state:'failure',url:'https://example.test/job/7',steps:[{number:2,name:'Compile application',state:'failure'}]}]};
        if(method === 'git.files') return {root:'/project',start:'',files:['App.tsx'],secret:[],truncated:false};
        if(method === 'session.list') return {sessions:agents};
        if(method === 'git.diff') return {diff:'@@ -1 +1 @@\\n-before\\n+after',truncated:false};
        if(method === 'git.commit') return {hash:params.hash+'0000000',parents:['base'],author:'Claude',date:'2026-10-01T10:00:00Z',
          subject:'Show where each agent is working',body:'',files:[{path:'apps/web/src/GitGraph.tsx',add:12,del:3}],
          ...(params.path ? {diff:'diff --git a/x b/x\\n@@ -1 +1 @@\\n-old line\\n+new line',truncated:false} : {})};
      }
    };
    const changed = {repo:true,branch:'main',upstream:'origin/main',ahead:2,behind:0,head:{commit:'merge',subject:'Merge the graph improvements'},
      files:[{path:'App.tsx',status:'M',add:1,del:1},{path:'apps/web/src/session/GitGraph.tsx',status:'A',add:40,del:0}]};
    window.graphRows = graphRows;
    window.showGit = () => root.render(<ChangesPanel key={Math.random()} client={client} env={{id:'local',name:'Laptop',online:true}} cwd='/project' sessionId='main'
      status={changed} reload={()=>{}} onClose={()=>root.render(null)} onOpen={()=>{}} />);
  `, resolveDir: process.cwd(), loader:'tsx' }, bundle:true,write:false,format:'iife',jsx:'automatic' });
  browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  page = await browser.newPage({viewport:{width:1280,height:900}});
  await page.setContent('<div class="main showing" style="height:100vh;width:100%"><div id="root"></div></div>');
  await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
});
after(async () => {await browser?.close()});

test('graph lanes: merges keep every parent, and a side line bends back into the mainline', async () => {
  const rows = await page.evaluate(()=>window.graphRows([
    {hash:'merge',parents:['a','b']},{hash:'a',parents:['root']},{hash:'b',parents:['root']},{hash:'root',parents:[]}
  ]));
  assert.deepEqual(rows[0].after,['a','b']);
  assert.deepEqual(rows[2].after,['root']);
  assert.deepEqual(rows[3].after,[]);
  assert.ok(rows.every((r)=>r.edges.every((e)=>e.to >= 0)));
  const side = await page.evaluate(()=>window.graphRows([
    {hash:'M',parents:['A','F']},{hash:'F',parents:['B']},{hash:'A',parents:['B']},{hash:'B',parents:[]}
  ]));
  assert.deepEqual(side.map((r)=>r.lane),[0,1,0,0]);
  assert.equal(side[3].colour,side[0].colour);
  assert.notEqual(side[1].colour,side[0].colour);
});

test('a workflow rerun discards cached jobs from the previous attempt', async () => {
  await page.evaluate(()=>{window.monitorAttempt=1;window.showGit()});
  await page.getByRole('tab',{name:'Build checks',exact:true}).click();
  const workflow = page.getByRole('button',{name:/Build and deploy/});
  await workflow.click();
  await page.getByText('Failed step: Compile application',{exact:true}).waitFor();
  const before = await page.evaluate(()=>window.calls.filter(c=>c.method==='git.jobs').length);
  await page.evaluate(()=>{window.monitorAttempt=2});
  await page.getByRole('button',{name:'Refresh build checks',exact:true}).click();
  await page.getByText('attempt 2',{exact:true}).waitFor();
  assert.equal(await workflow.getAttribute('aria-expanded'),'false');
  await workflow.click();
  await page.waitForFunction(n=>window.calls.filter(c=>c.method==='git.jobs').length>n,before);
  await page.getByText('Failed step: Compile application',{exact:true}).waitFor();
});

test('on a phone the Git screen keeps to the width, with an opened commit and an opened diff', async () => {
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{localStorage.clear();window.showGit()});
  await page.getByRole('tab',{name:'Graph',exact:true}).click();
  await page.locator('.git-line').first().waitFor();
  const fits = () => page.evaluate(()=>[...document.querySelectorAll('.changes *')].every((element)=>{
    const rect = element.getBoundingClientRect();
    return rect.width === 0 || (rect.left >= -1 && rect.right <= window.innerWidth + 1) || element.closest('.diff,.git-lanes,.git-through');
  }));
  assert.equal(await fits(),true,'nothing in the graph spills off the side');
  await page.locator('.git-line').filter({hasText:'Show where each agent is working'}).click();
  await page.locator('.git-file-row').click();
  await addedLine(page,'new line').waitFor();
  assert.equal(await fits(),true,'an opened commit keeps to the width');
  await page.getByRole('tab',{name:'Changes 2'}).click();
  await page.locator('.filemain').first().click();
  await addedLine(page,'after').waitFor();
  assert.equal(await fits(),true,'nothing in the file list spills off the side');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true);
});
