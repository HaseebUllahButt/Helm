import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A Claude taken over from a terminal is a terminal chat in Helm. Its tray
// must offer what a Helm chat's does - model, thinking and permissions, with
// favorites and new-chat defaults - and a permission change shows only once
// the machine has seen Claude switch.
let browser, script, css;
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
      import { SessionView } from './apps/web/src/App';
      import { MODES } from './packages/connect/src/modes.js';
      window.calls = [];
      const client = { on: () => () => {}, subscribe: () => () => {}, rpc: async (env, method, params) => {
        window.calls.push({ method, params });
        if (method === 'session.messages') return { messages: [{role:'assistant',text:'Existing conversation',tools:[]}], status: 'idle' };
        if (method === 'session.events') return {events:[], pending:[], last:0};
        if (method === 'session.watch') return {last:0};
        if (method === 'session.pending') return { pending: [] };
        if (method === 'model.list') return { default: null, models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
          labels: {'claude-opus-5-5':'Claude Opus 5.5','claude-sonnet-5-5':'Claude Sonnet 5.5'},
          efforts: ['low','medium','high','xhigh','max'], modes: MODES.claude, defaultMode: null,
          favs: [], effortFavs: [], prefs: {approved: [], default: 'claude-opus-5-5'}, defaults: {effort:'high', mode:'auto'},
          account: 'claude:personal', profileId: 'claudea' };
        if (method === 'session.commands') return { commands: [] };
        if (method === 'session.mode') return { ok: true, session: { ...window.current, mode: params.mode } };
        return {ok:true};
      } };
      function Harness() {
        const [session, setSession] = useState({id:'native-test',engine:'claude',nativeChat:true,nativeCli:true,pty:true,
          engineModel:'claude-opus-5-5',mode:'auto',status:'idle',cwd:'/project',title:'Taken over from the terminal'});
        window.current = session;
        return <SessionView client={client} env={{id:'laptop',name:'Laptop',online:true}} session={session}
          onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={(next) => setSession((now) => ({...now, ...next}))} />;
      }
      createRoot(document.getElementById('root')).render(<Harness />);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    plugins: [{ name: 'test-session-view', setup(b) {
      b.onLoad({filter: /\/App\.tsx$/}, async a => ({
        contents: await readFile(a.path, 'utf8') + '\nexport { SessionView };', loader: 'tsx',
      }));
    } }],
  });
  script = bundle.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm,'');
  browser = await chromium.launch({headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? {executablePath: process.env.HELM_TEST_CHROMIUM} : {})});
});
after(async () => browser?.close());

test('a taken-over Claude chat offers the whole tray and changes its permission mode', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => t.diagnostic(error.message));
  await page.setViewportSize({width:390, height:844});
  await page.route('http://helm.test/**', route => route.fulfill({contentType:'text/html', body:'<div id="root" style="display:flex;flex-direction:column;height:100dvh"></div>'}));
  await page.goto('http://helm.test/'); await page.addStyleTag({content:css}); await page.addScriptTag({content:script});

  // The same three chips a Helm chat's tray has.
  await page.getByRole('button', {name:'model: Opus 5.5', exact:true}).waitFor();
  await page.getByRole('button', {name:'thinking: think', exact:true}).waitFor();
  await page.getByRole('button', {name:'permissions: auto', exact:true}).waitFor();
  await page.screenshot({path:'/tmp/helm-native-tray-390.png'});

  // Favorites and "Set default" ride along, as in a Helm chat.
  await page.getByRole('button', {name:'model: Opus 5.5', exact:true}).click();
  await page.getByRole('checkbox', {name:'Favorite Claude Sonnet 5.5'}).waitFor();
  await page.getByRole('button', {name:'Use Claude Sonnet 5.5 by default for new chats'}).waitFor();
  await page.getByRole('button', {name:'close', exact:true}).click();

  await page.getByRole('button', {name:'permissions: auto', exact:true}).click();
  for (const label of ['Ask before acting', 'Edit freely', 'Act without asking', 'Bypass all checks']) {
    await page.getByRole('option', {name: new RegExp(label)}).waitFor();
  }
  await page.screenshot({path:'/tmp/helm-native-tray-permissions-390.png'});
  await page.getByRole('option', {name:/Edit freely/}).click();
  await page.getByRole('button', {name:'permissions: edit', exact:true}).waitFor();
  const call = await page.evaluate(() => window.calls.find((c) => c.method === 'session.mode'));
  assert.deepEqual(call.params, {id:'native-test', mode:'acceptEdits'});
  // A permission change is not a typed command: no "Sent … to Claude" notice.
  assert.equal(await page.getByText(/Sent .* to Claude/).count(), 0);
  assert.equal(await page.getByText('Existing conversation', {exact:true}).count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
