import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { UsageView } from './apps/web/src/Usage';
  import { loadUsage, saveUsage } from './apps/web/src/usageCache';
  window.usageCache = { loadUsage, saveUsage };
  const total = (n) => ({input:n,output:10,cacheRead:n*3,cacheWrite:0,reasoning:0,total:n*4+10,turns:2,costUsd:n/10,unpriced:false,cacheSavedUsd:1,cacheWritePremiumUsd:0});
  const report = (n, model) => ({ totals:total(n),daily:[{date:'2026-10-01',...total(n/2)},{date:'2026-10-02',...total(n/2)}],
    groups:model != null ? [{model,...total(n)}] : [{model:'claude-opus-5',engine:'claude',account:'claude|/home/x/.claude-work',...total(n-1)},{model:'small-model',...total(1),costUsd:0,unpriced:true}],
    accounts:[{account:'claude|/home/x/.claude-work',engine:'claude',profileId:'cw'}],scan:{},at:Date.now() });
  const envs = [{id:'laptop',name:'Laptop'},{id:'vm',name:'VM'}];
  window.requests = [];
  let oldResolve;
  window.releaseOld = () => oldResolve?.(report(999));
  const client = {
    usage: async (env, opts) => {
      window.requests.push({env,...opts});
      if (window.usageFixture) return window.usageFixture(env, opts, report);
      if (env === 'vm') throw new Error('Offline');
      if (opts.model != null) {
        if (window.oldDaemon) return report(999);
        return report(12,opts.model);
      }
      if (window.delayOld && !window.held) {window.held = true; return new Promise(r => oldResolve=r);}
      return report(opts.since ? 100 : 200);
    },
    rpc: async env => {
      if (window.limitsFixture) return window.limitsFixture(env);
      if(env === 'vm') throw new Error('Offline');
      return {unsupported:1,accounts:[
        {account:'a',engine:'claude',label:'personal',aliases:['c','cf'],windows:[
          {label:'5h',used:25,resetsAt:Date.now()/1000+3600,at:Date.now()-120000},
          {label:'7d',used:90,resetsAt:Date.now()/1000-10,at:Date.now()-86400000}]},
        {account:'b',engine:'codex',label:'work',aliases:['cx'],windows:[]},
        {account:'claude|~/.claude-work|',engine:'claude',label:'work',aliases:['cw'],windows:[
          {label:'7d',used:60,resetsAt:Date.now()/1000+3.5*86400,at:Date.now()-60000}]}
      ]};
    }
  };
  createRoot(document.getElementById('root')).render(<UsageView client={client} envs={envs} onBack={() => {}}/>);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
const style = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');

async function setup(t, width=390, delay=false, fixture) {
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width,height:900}});
  await page.setContent('<div class="app"><div id="root" style="display:flex;flex-direction:column;width:100%;height:100dvh"></div></div>');
  await page.addStyleTag({content:style});
  if(delay) await page.evaluate(() => window.delayOld=true);
  if(fixture) await page.evaluate(fixture);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  return page;
}

test('Usage shows reported allowance, expired and missing reports, and model-specific detail on mobile', async t => {
  const page = await setup(t);
  await page.getByRole('button',{name:'claude-opus-5',exact:true}).waitFor();
  assert.equal(await page.getByRole('meter').first().getAttribute('aria-valuenow'),'75');
  // Plan value: $9.90 over 7 days against a weekly allowance 60% used halfway
  // through the week - on pace for 120%, so it runs dry; a full week ≈ $16.50.
  // The allowance, its pace and what it is worth are one account row: the
  // weekly meter is drawn once, not again in a separate plan card.
  const accounts = page.getByRole('region',{name:'Accounts'});
  await accounts.getByText('runs out before the reset at this pace',{exact:true}).waitFor();
  assert.equal(await accounts.getByText('$16.50',{exact:true}).count(),1);
  assert.equal(await accounts.getByRole('meter',{name:'claude work 7d remaining'}).count(),1);
  assert.equal(await page.getByRole('region',{name:'Plan value'}).count(),0);
  await accounts.getByText('Add plan price',{exact:true}).click();
  await accounts.getByPlaceholder('e.g. 200').fill('200');
  await accounts.getByText('0.2×',{exact:true}).waitFor();
  await accounts.getByText('Plan $200/month',{exact:true}).waitFor();
  assert.equal(await page.getByText('Awaiting report',{exact:true}).count(),1);
  assert.equal(await page.getByText('No limit report yet',{exact:true}).count(),1);
  await page.getByText('VM · Limits unavailable',{exact:true}).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path:'/tmp/helm-usage-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'claude-opus-5',exact:true}).click();
  const detail = page.getByRole('dialog');
  await detail.getByText('$1.20',{exact:true}).waitFor();
  assert.equal(await detail.getByText('1 of 2 machines reporting.',{exact:true}).count(),1);
  assert.equal(await detail.locator('.usage-bar').count(), 0, 'the per-day chart is gone');
  assert.equal(await page.evaluate(() => window.requests.filter(r=>r.model==='claude-opus-5').length),2);
  assert.ok((await detail.locator('.modal-title').boundingBox()).height < 80, 'the model title must fit beside Close');
  await page.screenshot({path:'/tmp/helm-usage-model-mobile.png',fullPage:true});
  await page.keyboard.press('Escape');
  assert.equal(await detail.count(),0);
  assert.equal(await page.evaluate(() => document.activeElement.textContent),'claude-opus-5');
  await page.getByText('More models (1)',{exact:true}).click();
  await page.getByRole('button',{name:/small-model/}).click();
  await page.getByRole('dialog').getByText('$1.20',{exact:true}).waitFor();
});

test('Usage ignores a late response from the previous date range', async t => {
  const page = await setup(t,1280,true);
  await page.getByLabel('Environment').selectOption('vm');
  await page.getByText('Usage unavailable. No machine has returned a report.',{exact:true}).waitFor();
  assert.equal(await page.locator('.usage-hero').count(),0, 'missing reports must not appear as zero cost');
  await page.getByRole('button',{name:'All',exact:true}).click();
  await page.getByLabel('Environment').selectOption('laptop');
  await page.locator('.usage-hero-fig').filter({hasText:'$20.00'}).waitFor();
  await page.evaluate(() => window.releaseOld());
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.usage-hero-fig').innerText(),'$20.00');
  await page.screenshot({path:'/tmp/helm-usage-desktop.png',fullPage:true});
});

test('model detail refuses an unfiltered answer from an older daemon', async t => {
  const page = await setup(t);
  await page.evaluate(() => window.oldDaemon=true);
  await page.getByRole('button',{name:'claude-opus-5',exact:true}).click();
  const detail = page.getByRole('dialog');
  await detail.getByText('Model history unavailable. The machines may be offline or need an update.',{exact:true}).waitFor();
  assert.equal(await detail.locator('.usage-hero').count(),0);
});

test('a saved rolling window is reused only for the same calendar boundary', async t => {
  const page = await setup(t);
  await page.route('http://helm.test/', route => route.fulfill({status:200,contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm.test/');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const result = await page.evaluate(async () => {
    const {loadUsage,saveUsage}=window.usageCache;
    const report={totals:{total:42},daily:[],groups:[],accounts:[],scan:{},at:Date.now()};
    await saveUsage('cache-test',report,'7d','2026-10-01');
    const matching=await loadUsage('cache-test','7d','2026-10-01');
    const changed=await loadUsage('cache-test','7d','2026-10-02');
    await saveUsage('cache-test',{...report,totals:{total:50}},'7d','2026-10-02');
    const newDay=await loadUsage('cache-test','7d','2026-10-02');
    const oldDay=await loadUsage('cache-test','7d','2026-10-01');
    return {matching:matching?.report.totals.total,changed,newDay:newDay?.report.totals.total,oldDay};
  });
  assert.deepEqual(result,{matching:42,changed:null,newDay:50,oldDay:null});
});

test('logins sharing a home keep separate allowances and no borrowed full-week worth', async t => {
  const page = await setup(t, 390, false, () => {
    const now = Date.now() / 1000;
    const week = (used, at) => [{label:'7d',used,resetsAt:now+3.5*86400,at}];
    window.limitsFixture = env => env === 'vm' ? {unsupported:0,accounts:[]} : {unsupported:0,accounts:[
      {account:'claude|~/.claude-personal|TOKEN_A',engine:'claude',label:'personal',displayLabel:'personal (claudea)',aliases:['claudea'],windows:week(60,Date.now()-60000)},
      {account:'claude|~/.claude-personal|TOKEN_S',engine:'claude',label:'personal',displayLabel:'personal (claudes)',aliases:['claudes'],windows:week(20,Date.now()-60000)}]};
    window.usageFixture = (env, opts, report) => {
      const r = report(100);
      r.groups = [{...r.groups[0], account:'claude|/home/x/.claude-personal'}];
      r.accounts = [{account:'claude|/home/x/.claude-personal',engine:'claude',profileId:'claudea'}];
      return r;
    };
  });
  const accounts = page.getByRole('region',{name:'Accounts'});
  const a = accounts.getByRole('meter',{name:'claude personal (claudea) 7d remaining'});
  const s = accounts.getByRole('meter',{name:'claude personal (claudes) 7d remaining'});
  await a.waitFor();
  assert.equal(await a.getAttribute('aria-valuenow'),'40');
  assert.equal(await s.getAttribute('aria-valuenow'),'80');
  await accounts.getByText('Shared by personal (claudea), personal (claudes)',{exact:true}).waitFor();
  assert.equal(await accounts.getByText(/full week/).count(),0, 'shared spend is not priced against either login\'s allowance');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path:'/tmp/helm-usage-shared-home.png',fullPage:true});
});

test('one credential read on two machines is one row that keeps both report times', async t => {
  const page = await setup(t, 1280, false, () => {
    const now = Date.now() / 1000;
    const row = at => ({account:'claude|~/.claude|TOKEN_A',engine:'claude',label:'personal',aliases:['claudea'],
      windows:[{label:'7d',used:30,resetsAt:now+3.5*86400,at}]});
    window.limitsFixture = env => ({unsupported:0,accounts:[row(env === 'vm' ? Date.now()-3*3600000 : Date.now()-120000)]});
  });
  const accounts = page.getByRole('region',{name:'Accounts'});
  const row = accounts.locator('.usage-account').filter({hasText:'claude personal'});
  await row.getByRole('meter').waitFor();
  assert.equal(await accounts.getByRole('meter').count(),1);
  assert.match(await row.locator('.usage-account-name small').innerText(), /^Laptop 2m ago · VM 3h ago$/);
  // Pace is measured from the newer reading: 30% at half the week is 60%.
  await accounts.getByText(/on pace for 60% of the week/).waitFor();
});
