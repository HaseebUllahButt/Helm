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
      {profileId:'gemini',label:'Gemini',engine:'gemini',mcp:[],skills:[],plugins:[],support:{mcp:false,skills:false,plugins:false,auth:'none'}},
      {profileId:'codexwhy',label:'Codex on why',engine:'codex',support:{mcp:true,skills:true,plugins:true,auth:'terminal'},
        mcp:[{name:'node_repl',scope:'user',transport:'stdio',target:'/usr/lib/chatgpt/resources/cua_node/bin/node_repl',status:'configured'},{name:'rea',scope:'user',transport:'stdio',target:'/home/test/.npm/_npx/dea9475797100b20/node_modules/.bin/rea',status:'configured'},{name:'lms',scope:'user',transport:'stdio',target:'/usr/bin/python3',status:'configured'},{name:'pw',scope:'user',transport:'stdio',target:'npx',package:'@playwright/mcp',status:'configured'},{name:'gh',scope:'user',transport:'stdio',target:'docker',package:'ghcr.io/github/github-mcp-server',status:'configured'},{name:'team',scope:'user',transport:'http',target:'https://mcp.linear.app/mcp',status:'configured'},{name:'mystery',scope:'user',transport:'stdio',target:'/opt/mystery/bin/serve',status:'configured'}],
        skills:[{name:'diagnose-crash',folder:'diagnose-crash',description:'Diagnose a crash',path:'/home/test/.codex/skills/diagnose-crash',source:'/usr/share/omarchy/default/agents/skills/diagnose-crash',shared:false},{name:'omarchy',folder:'omarchy',description:'Customise the desktop',path:'/home/test/.codex/skills/omarchy',source:'/usr/share/omarchy/default/agents/skills/omarchy',shared:false},{name:'reverse-engineer-anything',folder:'reverse-engineer-anything',description:'Reverse engineer with REA',path:'/home/test/.agents/skills/reverse-engineer-anything',shared:true}],
        plugins:[{name:'codex-app-tools@openai-bundled',scope:'user',enabled:true},{name:'browser@openai-bundled',scope:'user',enabled:true},{name:'visualize@openai-bundled',scope:'user',enabled:true},{name:'example@market',scope:'user',enabled:true}]}];
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
  await page.getByText('Notion', { exact: true }).waitFor();
  await page.getByText('Online service', { exact: true }).waitFor();
  await page.getByText('helpful-skill', { exact: false }).waitFor();
  await page.getByText('example', { exact: true }).waitFor();
  await page.getByText('from market', { exact: true }).waitFor();
  assert.equal(await page.locator('.clogo svg').count() >= 3, true, 'a logo for the connector and glyphs for the skill and plugin');
  assert.equal(await page.getByText('https://mcp.notion.com/mcp').count(), 0, 'the address waits behind a tap');
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow');
    if (process.env.HELM_TEST_SCREENSHOT_DIR) { await mkdir(process.env.HELM_TEST_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: `${process.env.HELM_TEST_SCREENSHOT_DIR}/integrations-${width}.png` }); }
  }
});
test('catalog and custom form add to the chosen machine and account', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Add connector', exact: true }).click();
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
  await page.getByRole('button', { name: /^Notion/ }).click();
  const detail = page.getByRole('dialog', { name: 'Notion' });
  await detail.getByText('https://mcp.notion.com/mcp').waitFor();
  await detail.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => window.opened?.id === 'auth-terminal');
  assert.equal(await page.evaluate(() => window.calls.find(c=>c.method==='integrations.mcp.connect').params.profileId), 'claudea');
  await page.getByRole('button', { name: 'Choose account', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Codex work/ }).click();
  await page.getByText('No connectors configured.').waitFor();
  await page.getByRole('button', { name: 'Add skill', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add skill', exact: true }).getByLabel('Git URL or absolute folder').fill('/skills');
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.calls.find(c=>c.method==='integrations.skills.add').params.source), '/skills');
  await page.getByRole('button', { name: 'Choose account', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Gemini/ }).click();
  await page.getByText('Connector management is not supported for this CLI yet.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add connector', exact: true }).count(), 0);
});
test('each row wears the logo of what is behind it', async () => {
  await page.getByRole('button', { name: 'Choose account', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Codex on why/ }).click();
  await page.getByText('node_repl', { exact: true }).waitFor();
  const logos = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.integrations .rows .row')].map((r) => [r.querySelector('.rt-text')?.textContent, r.querySelector('.clogo')?.getAttribute('data-logo')]).filter(([n]) => n)));
  assert.deepEqual(logos, {
    node_repl: 'openai', rea: 'node', lms: 'python', pw: 'playwright', gh: 'github', Linear: 'linear', mystery: 'letter',
    'diagnose-crash': 'omarchy', omarchy: 'omarchy', 'reverse-engineer-anything': 'openai',
    'codex-app-tools': 'openai', browser: 'browser', visualize: 'openai', example: 'plugin',
  });
  assert.equal(await page.locator('.clogo-letter').count(), 1, 'only the unknown command falls back to its letter');
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow');
    if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.HELM_TEST_SCREENSHOT_DIR}/integrations-logos-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: /^diagnose-crash/ }).click();
  await page.getByRole('dialog', { name: 'diagnose-crash' }).getByText('/usr/share/omarchy/default/agents/skills/diagnose-crash').waitFor();
});
