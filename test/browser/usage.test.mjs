import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { UsageView } from './apps/web/src/Usage';
    const blank = { input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,turns:0,costUsd:0,total:0,unpriced:false,cacheSavedUsd:0,cacheWritePremiumUsd:0 };
    const report = { totals:{...blank,total:11000,costUsd:10,summaryOnly:true},
      daily:[{...blank,date:'2026-10-03',total:10000,costUsd:0},{...blank,date:'2026-10-04',total:1000,costUsd:10}],
      groups:[{...blank,engine:'free',total:10000,costUsd:0},{...blank,engine:'paid',total:1000,costUsd:10}],
      accounts:[{account:'a',engine:'codex',profileId:null,source:'bromylimits',sourceUrl:'http://127.0.0.1:47291/',sourceAt:Date.now()}],scan:{},at:Date.now() };
    window.waiters = [];
    const H = 3600000, now = Date.now();
    const limits = { at: now, accounts: [
      { account:'claude|p', engine:'claude', name:'Claude · personal', profileIds:['claudea'], identity:'me@example.com', plan:'Max',
        windows:[{key:'session',label:'5-hour',usedPercent:80,resetsAt:now+4*H,durationMs:5*H},
                 {key:'weekly',label:'Weekly',usedPercent:40,resetsAt:now-H,durationMs:168*H}],
        at: now - 3*60000, source:'chat' },
      { account:'codex|d', engine:'codex', name:'Codex', profileIds:['codex'], plan:'Pro', windows:[{key:'weekly',label:'Weekly',usedPercent:8,resetsAt:now+6*24*H,durationMs:168*H},{key:'monthly',label:'Monthly',usedPercent:100,resetsAt:now+6*24*H,durationMs:720*H}],
        credits:['1,894 credits left'], at: now - 60000, source:'cli' },
      { account:'claude|d', engine:'claude', name:'Claude', profileIds:['claude'], windows:[], at:null, source:null } ] };
    window.limitCalls = [];
    const client = {limits:(env,refresh)=>{window.limitCalls.push(refresh);return Promise.resolve(limits)}, usage:(_env,opts) => window.deferred ? new Promise(resolve=>window.waiters.push({opts,resolve})) : Promise.resolve(report)};
    window.answer = (index,total) => window.waiters[index].resolve({...report,totals:{...report.totals,total}});
    window.mount = () => createRoot(document.getElementById('root')).render(<UsageView client={client} envs={[{id:'laptop',name:'Laptop'}]} onBack={()=>{}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless:true, ...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {}) });
});
after(async()=>browser?.close());
async function mount(deferred=false) {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
  await page.addScriptTag({content:script});
  await page.evaluate((deferred)=>{window.deferred=deferred;window.mount();},deferred);
  return page;
}
test('Tokens mode uses tokens for headline, daily bars and free-model shares',async()=>{
  const page=await mount();
  try {
    await page.getByRole('button',{name:'Tokens',exact:true}).click();
    await page.getByText('Tokens per day',{exact:true}).waitFor();
    assert.match(await page.locator('.usage-hero-cap').innerText(),/11,000 exact/);
    assert.equal(await page.locator('.usage-bar').first().getAttribute('style'),'height: 100%;');
    assert.match(await page.locator('.usage-legend').innerText(),/free[\s\S]*90\.9%/);
    assert.equal(await page.locator('.usage-cache').count(),0);
    assert.match(await page.locator('.usage-note').allTextContents().then(x=>x.join(' ')),/totals from BroMyLimits/);
    if(process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.HELM_TEST_SCREENSHOT_DIR}/usage-tokens.png`,fullPage:true});
    await page.getByRole('button',{name:'Cost',exact:true}).click();
    await page.getByText('Cost per day',{exact:true}).waitFor();
    assert.match(await page.locator('.usage-hero-fig').innerText(),/\$10\.00/);
  } finally {await page.close();}
});
test('a late answer from the previous date window cannot overwrite the current total',async()=>{
  const page=await mount(true);
  try {
    await page.waitForFunction(()=>window.waiters.length===1);
    await page.evaluate(()=>window.answer(0,11000));
    await page.getByRole('button',{name:'Today',exact:true}).click();
    await page.waitForFunction(()=>window.waiters.length===2);
    await page.evaluate(()=>window.answer(1,200));
    await page.getByRole('button',{name:'All',exact:true}).click();
    await page.waitForFunction(()=>window.waiters.length===3);
    await page.getByRole('button',{name:'Today',exact:true}).click();
    await page.waitForFunction(()=>window.waiters.length===4);
    await page.evaluate(()=>{window.answer(3,300);window.answer(2,99999);});
    await page.getByRole('button',{name:'Tokens',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.usage-hero-cap')?.textContent.includes('300 exact'));
    assert.doesNotMatch(await page.locator('.usage-hero-cap').innerText(),/99,999/);
  } finally {await page.close();}
});
test('Limits show what is left, renewals, a run-out warning and accounts with no reading',async()=>{
  const page=await mount();
  try {
    await page.locator('.limit-card').first().waitFor();
    const cards=page.locator('.limit-card');
    assert.equal(await cards.count(),2);
    const claude=await cards.nth(0).innerText();
    assert.match(claude,/Claude · personal/);
    assert.match(claude,/me@example\.com/);
    assert.match(claude,/5-hour\s+20% left/);
    assert.match(claude,/back in 4h, at/);
    assert.match(claude,/runs out in 15m/);
    assert.match(claude,/Weekly\s+renewed/);
    assert.match(claude,/Updated 3 min ago, from a chat/);
    const codex=await cards.nth(1).innerText();
    assert.match(codex,/92% left[\s\S]*Monthly\s+used up[\s\S]*1,894 credits left/);
    assert.doesNotMatch(codex,/runs out/);
    assert.match(await page.locator('.limit-empty').first().innerText(),/No reading yet for Claude\./);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.HELM_TEST_SCREENSHOT_DIR}/usage-limits.png`,fullPage:true});
    await page.getByRole('button',{name:'Check now'}).click();
    await page.waitForFunction(()=>window.limitCalls.includes(true));
  } finally {await page.close();}
});
