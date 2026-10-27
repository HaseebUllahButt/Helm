import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script, css;
before(async () => {
  const bundle = await build({stdin:{contents:`
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {HomeRow} from './apps/web/src/App';
    const now = Date.now();
    localStorage.setItem('helm-seen:v1', JSON.stringify({ since: now - 3600000, at: {} }));
    createRoot(document.getElementById('root')).render(<div className="rows plain" style={{width:'100%',maxWidth:320}}>
      <HomeRow machine="Laptop" s={{id:'example',title:'Shared Claude controls',cwd:'/projects/helm',
        branch:'feature/claude-controls-and-long-branch-name',engine:'claude',status:'working',updatedAt:now-125000}}
        onOpen={()=>{}} />
      <HomeRow machine="VM" s={{id:'no-branch',title:'Session without a branch',cwd:'/projects/another-folder',
        engine:'claude',status:'idle',turns:2,updatedAt:now-300000-3600000*3}} onOpen={()=>{}} />
      <HomeRow machine="VM" s={{id:'ask',title:'Waiting on an approval',cwd:'/projects/helm',engine:'codex',status:'blocked',pending:1,updatedAt:now-60000}} onOpen={()=>{}} />
      <HomeRow machine="VM" s={{id:'fail',title:'Last turn failed',cwd:'/projects/helm',engine:'codex',status:'idle',recovery:{kind:'error',message:'x',at:now},updatedAt:now-60000}} onOpen={()=>{}} />
      <HomeRow machine="VM" s={{id:'new',title:'Finished, not opened',cwd:'/projects/helm',engine:'claude',status:'idle',turns:1,updatedAt:now-120000}} onOpen={()=>{}} />
      <HomeRow slim machine="VM" s={{id:'slim',title:'A settled chat with a rather long title that must not wrap',cwd:'/projects/helm',engine:'claude',status:'idle',turns:1,updatedAt:now-7200000}} onOpen={()=>{}} />
    </div>);
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',
  plugins:[{name:'test-home-row',setup(b){b.onLoad({filter:/\/App\.tsx$/},async a=>({
    contents:await readFile(a.path,'utf8')+'\nexport {HomeRow};',loader:'tsx'}));}}]});
  script=bundle.outputFiles[0].text;
  css=(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'');
  browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());
for(const width of [1280,390])test(`a chat row puts its title and status first, then folder, machine, branch and agent at ${width}px`,async t=>{
  const page=await browser.newPage({viewport:{width,height:844}});t.after(()=>page.close());
  await page.route('http://helm.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm.test/');await page.addStyleTag({content:css});await page.addScriptTag({content:script});
  const rows=page.locator('.thread-row');await rows.first().waitFor();
  const row=rows.first();
  assert.equal(await row.locator('.tri-top .tri-title').innerText(),'Shared Claude controls');
  assert.match(await row.locator('.tri-top .tstat.working').innerText(),/^2m 0\ds$/,'a clock since the turn began, on the first line');
  assert.equal(await row.locator('.tri-bot .tri-where').innerText(),'helm · Laptop');
  assert.equal(await row.locator('.tri-bot .tri-branch').innerText(),'feature/claude-controls-and-long-branch-name');
  assert.equal(await row.locator('.tri-bot .tri-mark').count(),1,'the agent logo ends the second line');
  assert.equal(await row.locator('.tri-top .tri-where, .tri-top .tri-branch').count(),0);
  assert.equal(await row.getAttribute('title'),'Shared Claude controls\nhelm · Laptop · feature/claude-controls-and-long-branch-name · Claude Code');
  const title=await row.locator('.tri-title').boundingBox(),status=await row.locator('.tstat').boundingBox(),folder=await row.locator('.tri-where').boundingBox(),branch=await row.locator('.tri-branch').boundingBox();
  assert.ok(title.y<folder.y && Math.abs(title.y-status.y)<8 && Math.abs(folder.y-branch.y)<8 && status.x>title.x);
  assert.equal(await rows.nth(1).locator('.tri-branch').count(),0);
  // One slot, five answers.
  assert.equal(await rows.nth(1).locator('.tstat.quiet').innerText(),'3h','quiet rows show a compact age');
  assert.equal(await rows.nth(2).locator('.tstat.needs').innerText(),'Needs you');
  assert.equal(await rows.nth(3).locator('.tstat.failed').innerText(),'Failed');
  assert.equal(await rows.nth(4).locator('.tstat.unread').getAttribute('aria-label'),'Finished. You have not opened this chat.');
  assert.equal(await rows.nth(4).locator('.tstat.unread').innerText(),'2m','a new chat shows a green dot before its age');
  const colours=await page.evaluate(()=>Object.fromEntries([...document.querySelectorAll('.tstat')].map(e=>[e.dataset.mood,getComputedStyle(e).color])));
  assert.equal(new Set(Object.values(colours)).size,5,'each state has its own colour: '+JSON.stringify(colours));
  // Slim: one line - the title, its age and the agent.
  const slim=rows.nth(5);
  assert.equal(await slim.locator('.tri-bot').count(),0);
  assert.match(await slim.locator('.tstat.quiet').innerText(),/^2h$/);
  assert.equal(await slim.locator('.tri-mark').count(),1,'a settled chat keeps its agent logo');
  assert.ok((await slim.boundingBox()).height<40,'a settled row is a single line');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:process.env.HELM_TEST_SCREENSHOT_DIR?`${process.env.HELM_TEST_SCREENSHOT_DIR}/sidebar-moods-${width}.png`:`/tmp/helm-sidebar-moods-${width}.png`});
});
