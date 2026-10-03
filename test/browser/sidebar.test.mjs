import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('Done is newest first across machines, retires at three days, and the footer is quiet', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Shell } from './apps/web/src/App';
    const now = Date.now(), hour = 3600000;
    const session = (title, age, more={}) => ({id:title,title,cwd:'/project',engine:'codex',profileId:'codex',
      driver:'codex',turns:1,status:'idle',updatedAt:now-age,...more});
    const sessions = {
      laptop: [session('Two days ago',48*hour),session('Newest',hour),session('Retired',72*hour),
        session('Almost retired',72*hour-1000),session('Working',100*hour,{status:'working'}),
        session('Archived',0,{archived:true}),session('Child',0,{delegation:{parentId:'other'}}),
        session('Unused',0,{turns:0}),session('Waiting',0,{status:'blocked'})],
      vm: [session('Yesterday',24*hour),...Array.from({length:31},(_,i)=>session('Recent '+i,(i+2)*60000))],
    };
    const client = { relay:'https://private.sslip.io',
      environments:async()=>({environments:['laptop','vm'].map(id=>({id,name:id,online:true,info:{}}))}),
      on:()=>()=>{},subscribe:()=>{},watchLatency:()=>()=>{},openDirect:async()=>{},route:async()=>null,
      rpc:async(env,method)=>method==='session.list'?{sessions:sessions[env]}:{},
    };
    createRoot(document.getElementById('root')).render(<Shell client={client} conn={{online:true,reachable:true}} onSignOut={()=>{}} />);
  `, resolveDir:process.cwd(),loader:'tsx' }, plugins:[{name:'shell-test-export',setup(b){
    b.onLoad({filter:/\/App\.tsx$/},async({path})=>({contents:await readFile(path,'utf8')+'\nexport { Shell };',loader:'tsx'}));
  }}],bundle:true,write:false,format:'iife',jsx:'automatic' });
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    await page.route('http://helm-test/**',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
    await page.goto('http://helm-test/');
    await page.clock.install({time:new Date('2026-10-03T12:00:00Z')});
    await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const sidebar = page.locator('.sidebar');
    const done = sidebar.locator('.foldwrap').filter({has:page.locator('.fold-title',{hasText:/^done$/})});
    await done.getByRole('button',{name:'done 35',exact:true}).click();
    const titles = await done.locator('.rt-text').allTextContents();
    assert.equal(titles.length,35,'all recent threads remain until their own retirement time');
    assert.deepEqual(titles.slice(-4),['Newest','Yesterday','Two days ago','Almost retired']);
    assert.equal(titles[0],'Recent 0');
    assert.equal(titles.includes('Retired'),false);
    assert.equal(await sidebar.locator('.diag').count(),0);
    assert.doesNotMatch(await sidebar.innerText(),/sslip\.io|socket live/i);
    await page.clock.fastForward(30000);
    await done.getByRole('button',{name:'done 34',exact:true}).waitFor();
    assert.equal(await done.getByText('Almost retired',{exact:true}).count(),0);
    await sidebar.getByRole('textbox').fill('Almost retired');
    await sidebar.getByText('Almost retired',{exact:true}).waitFor();
    assert.ok(await sidebar.getByText('Almost retired',{exact:true}).isVisible(),'retirement preserves searchable history');
  } finally {await browser.close();}
});
