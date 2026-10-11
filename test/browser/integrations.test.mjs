import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
let browser, page;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { IntegrationsView } from './apps/web/src/Integrations';
    const root = createRoot(document.getElementById('root'));
    window.calls = [];
    const accounts = [
      {profileId:'claudea',label:'Claude personal',engine:'claude',mcp:[{name:'notion',scope:'user',transport:'http',target:'https://mcp.notion.com/mcp',status:'configured'}],skills:[{name:'helpful-skill',folder:'helpful-skill',description:'A shared useful skill',path:'/home/test/.agents/skills/helpful-skill',shared:true}],plugins:[{name:'example@market',scope:'user'}],support:{mcp:true,skills:true,plugins:true,auth:'terminal'}},
      {profileId:'codex',label:'Codex work',engine:'codex',mcp:[],skills:[],plugins:[],support:{mcp:true,skills:true,plugins:true,auth:'terminal'}},
      {profileId:'gemini',label:'Gemini',engine:'gemini',mcp:[],skills:[],plugins:[],support:{mcp:false,skills:false,plugins:false,auth:'none'}}];
    const catalog = [{name:'gmail',title:'Gmail',description:'Email and drafts · Google Developer Preview',transport:'http',url:'https://gmailmcp.googleapis.com/mcp/v1',needsSignIn:true,source:'https://developers.google.com/workspace/guides/configure-mcp-servers',setup:'Developer Preview membership and OAuth setup required.'}];
    const client = {rpc: async(machine,method,params)=>{window.calls.push(JSON.parse(JSON.stringify({machine,method,params}))); 
      if(method==='integrations.list') return {accounts,catalog};
      if(method==='integrations.mcp.connect') return {session:{id:'auth-terminal',engine:'shell'}};
      if(method==='integrations.mcp.add') {accounts.find(a=>a.profileId===params.profileId).mcp.push({name:params.name,scope:params.scope,transport:params.transport,target:params.url||params.command,status:'configured'});return {row:{name:params.name}};}
      return {ok:true};}};
    window.render=()=>root.render(<IntegrationsView client={client} env={{id:'machine-a',name:'Laptop',online:true}} onBack={()=>{}} onOpenSession={s=>window.opened=s} />);window.render();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  browser = await chromium.launch({ headless: true, executablePath: process.env.HELM_TEST_CHROMIUM || '/usr/bin/chromium' });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('http://helm.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div class="main showing" style="height:100vh;width:100%;display:flex;flex-direction:column"><div id="root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>' }));
  await page.goto('http://helm.test/');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});
after(async () => browser?.close());
test('lists account connectors, shared skills and plugins at phone and desktop widths', async () => {
  await page.getByText('notion', { exact: true }).waitFor();
  await page.getByText('helpful-skill', { exact: false }).waitFor();
  await page.getByText('example@market', { exact: true }).waitFor();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow');
    if (process.env.HELM_TEST_SCREENSHOT_DIR) { await mkdir(process.env.HELM_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.HELM_TEST_SCREENSHOT_DIR}/integrations-${width}.png` }); }
  }
});
test('catalog and custom form add to the chosen machine and account', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Add connector…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add connector', exact: true });
  await dialog.getByText('Gmail', { exact: true }).waitFor();
  await dialog.getByText('Needs sign-in').waitFor();
  await dialog.getByText('Custom…', { exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Connector details' });
  await form.getByLabel('Name', { exact: true }).fill('new-connector');
  await form.getByLabel('URL', { exact: true }).fill('https://example.test/mcp');
  await form.getByLabel('Scope').selectOption('user');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByText('new-connector', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.find(c=>c.method==='integrations.mcp.add')), {machine:'machine-a',method:'integrations.mcp.add',params:{name:'new-connector',transport:'http',scope:'user',url:'https://example.test/mcp',profileId:'claudea'}});
});
test('Connect opens returned terminal; account changes expose supported actions only', async () => {
  await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
  await page.waitForFunction(() => window.opened?.id === 'auth-terminal');
  assert.equal(await page.evaluate(() => window.calls.find(c=>c.method==='integrations.mcp.connect').params.profileId), 'claudea');
  await page.getByRole('button', { name: 'Choose account', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Codex work/ }).click();
  await page.getByText('No connectors configured.').waitFor();
  await page.getByRole('button', { name: 'Add skill…' }).click();
  await page.getByRole('dialog', { name: 'Add skill', exact: true }).getByLabel('Git URL or absolute folder').fill('/skills');
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.calls.find(c=>c.method==='integrations.skills.add').params.source), '/skills');
  await page.getByRole('button', { name: 'Choose account', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Gemini/ }).click();
  await page.getByText('Connector management is not supported for this CLI yet.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add connector…', exact: true }).count(), 0);
});
