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
    createRoot(document.getElementById('root')).render(<div className="rows plain" style={{width:'100%',maxWidth:320}}>
      <HomeRow machine="Laptop" s={{id:'example',title:'Shared Claude controls',cwd:'/projects/helm',
        branch:'feature/claude-controls-and-long-branch-name',engine:'claude',status:'working',updatedAt:Date.now()-120000}}
        onOpen={()=>{}} />
      <HomeRow machine="VM" s={{id:'no-branch',title:'Session without a branch',cwd:'/projects/another-folder',
        engine:'claude',status:'idle',updatedAt:Date.now()}} onOpen={()=>{}} />
    </div>);
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',
  plugins:[{name:'test-home-row',setup(b){b.onLoad({filter:/\/App\.tsx$/},async a=>({
    contents:await readFile(a.path,'utf8')+'\nexport {HomeRow};',loader:'tsx'}));}}]});
  script=bundle.outputFiles[0].text;
  css=(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'');
  browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());
for(const width of [1280,390])test(`sidebar shows branch above title and folder below at ${width}px`,async t=>{
  const page=await browser.newPage({viewport:{width,height:844}});t.after(()=>page.close());
  await page.route('http://helm.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm.test/');await page.addStyleTag({content:css});await page.addScriptTag({content:script});
  const row=page.locator('.thread-row').first();await row.waitFor();
  assert.equal(await row.locator('.tri-top .tri-branch').innerText(),'feature/claude-controls-and-long-branch-name');
  assert.equal(await row.locator('.tri-bot .tri-where').innerText(),'helm · Laptop');
  assert.equal(await row.locator('.tri-top .tri-where').count(),0);
  assert.equal(await row.locator('.tri-bot .tri-branch').count(),0);
  const branch=await row.locator('.tri-branch').boundingBox(),title=await row.locator('.tri-title').boundingBox(),folder=await row.locator('.tri-where').boundingBox();
  assert.ok(branch.y<title.y && title.y<folder.y);
  assert.equal(await page.locator('.thread-row').nth(1).locator('.tri-branch').count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`/tmp/helm-sidebar-swapped-${width}.png`});
});
