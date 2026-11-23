import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

// How accounts merge into rows is tested without a browser in test/usage.test.mjs.
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { UsageView } from './apps/web/src/Usage';
  const total = (n) => ({input:n,output:10,cacheRead:n*3,cacheWrite:0,reasoning:0,total:n*4+10,turns:2,costUsd:n/10,unpriced:false,cacheSavedUsd:1,cacheWritePremiumUsd:0});
  const report = (n, model) => ({ totals:total(n),daily:[{date:'2026-10-01',...total(n/2)},{date:'2026-10-02',...total(n/2)}],
    groups:model != null ? [{model,...total(n)}] : [{model:'claude-opus-5',engine:'claude',account:'claude|/home/x/.claude-work',...total(n-1)},{model:'small-model',...total(1),costUsd:0,unpriced:true}],
    accounts:[{account:'claude|/home/x/.claude-work',engine:'claude',profileId:'cw'}],scan:{},at:Date.now() });
  const envs = [{id:'laptop',name:'Laptop'},{id:'vm',name:'VM'}];
  let oldResolve;
  // Lets the held answer land, and resolves once the app has drawn two frames since.
  window.releaseOld = () => { oldResolve?.(report(999)); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); };
  const client = {
    usage: async (env, opts) => {
      if (env === 'vm') throw new Error('Offline');
      if (opts.model != null) return window.oldDaemon ? report(999) : report(12,opts.model);
      if (window.delayOld && !window.held) {window.held = true; return new Promise(r => oldResolve=r);}
      return report(opts.since ? 100 : 200);
    },
    rpc: async () => ({unsupported:0,accounts:[]}),
  };
  createRoot(document.getElementById('root')).render(<UsageView client={client} envs={envs} onBack={() => {}}/>);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
const style = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');

async function setup(t, width=390, delay=false) {
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width,height:900}});
  await page.setContent('<div class="app"><div id="root" style="display:flex;flex-direction:column;width:100%;height:100dvh"></div></div>');
  await page.addStyleTag({content:style});
  if(delay) await page.evaluate(() => window.delayOld=true);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  return page;
}

test('Usage ignores a late response from the previous date range', async t => {
  const page = await setup(t,1280,true);
  await page.getByLabel('Machine').selectOption('vm');
  await page.getByText('No machine has sent a usage report.',{exact:true}).waitFor();
  assert.equal(await page.locator('.usage-hero').count(),0, 'missing reports must not appear as zero cost');
  await page.getByRole('button',{name:'All',exact:true}).click();
  await page.getByLabel('Machine').selectOption('laptop');
  await page.locator('.usage-hero-fig').filter({hasText:'$20.00'}).waitFor();
  await page.evaluate(() => window.releaseOld());
  assert.equal(await page.locator('.usage-hero-fig').innerText(),'$20.00');
});

test('model detail refuses an unfiltered answer from an older daemon', async t => {
  const page = await setup(t);
  await page.evaluate(() => window.oldDaemon=true);
  await page.getByRole('button',{name:/^claude-opus-5,/}).click();
  const detail = page.getByRole('dialog');
  await detail.getByText('Helm cannot get model history. Check machine connections and updates.',{exact:true}).waitFor();
  assert.equal(await detail.locator('.usage-hero').count(),0);
});
