import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script, css;
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
      import { SessionView } from './apps/web/src/App';
      window.calls = [];
      const listeners = new Set();
      window.emit = (kind, payload) => listeners.forEach(fn => fn('laptop', kind, payload));
      const client = {pendingActions:()=>[],resumeActions:async()=>[],input:(env,params)=>client.rpc(env,'session.input',params), on: fn => { listeners.add(fn); return () => listeners.delete(fn); }, subscribe: () => () => {}, rpc: async (env, method, params) => {
        if (method === 'session.messages') return { messages: [{role:'assistant',text:'Existing conversation',tools:[]}], status: window.sessionStatus || 'idle' };
        if (method === 'session.events') { window.eventsRead = true; return {events:[], pending:[],last:0}; }
        if (method === 'session.watch') return {last:0};
        if (method === 'session.pending') return { pending: [] };
        if (method === 'model.list') return { default: 'unrelated-account-default',
          models: ['opus', 'sonnet'], efforts: ['low', 'high'],
          modes: [{id:'default',label:'Ask before acting',short:'ask'}, {id:'acceptEdits',label:'Edit freely',short:'edit'},
            {id:'bypassPermissions',label:'Bypass all checks',short:'yolo',danger:true}],
          defaultMode:'bypassPermissions', profileId:'claude-personal', prefs:{default:'sonnet',approved:['opus','sonnet']},
          defaults:{effort:'low',mode:'default'}, favs:['opus'], effortFavs:[] };
        if (method === 'session.attach') return { text: 'Claude terminal', pty: true };
        if (['session.mode', 'session.input'].includes(method)) {
          window.calls.push({env, method, params});
          if (method === 'session.mode') return {session:{...window.currentSession,mode:params.mode}};
          return {ok:true, terminal: method !== 'session.input' || params.data.trim().startsWith('/')};
        }
        return {ok:true};
      } };
      function NativeChat() {
        const [session,setSession] = useState({id:'native-test',engine:'claude',nativeChat:true,nativeCli:true,pty:true,
          engineModel:'opus',status:window.sessionStatus || 'idle',cwd:'/project',title:'Native Claude',mode:window.initialMode});
        window.currentSession = session; window.updateSession = patch => setSession(s => ({...s,...patch}));
        return <SessionView client={client}
        env={{id:'laptop',name:'Laptop',online:true}}
        session={session}
        onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={setSession} />;
      }
      createRoot(document.getElementById('root')).render(<NativeChat />);
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
async function pageFor(t, status = 'idle') {
  const page = await browser.newPage(); t.after(() => page.close());
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => t.diagnostic(error.message));
  await page.route('http://helm.test/**', route => route.fulfill({contentType:'text/html', body:'<div id="root" style="display:flex;flex-direction:column;height:100dvh"></div>'}));
  await page.goto('http://helm.test/'); await page.addStyleTag({content:css}); await page.evaluate(status => {window.sessionStatus = status}, status); await page.addScriptTag({content:script});
  await page.getByRole('button', {name:'model: opus', exact:true}).waitFor();
  return page;
}
test('a slash command during a reply keeps chat and approvals available in both views', async t => {
  const page = await pageFor(t, 'working');
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(() => window.eventsRead);
  await page.locator('textarea').fill('/context');
  await page.getByRole('button', {name:'send', exact:true}).click();
  await page.getByRole('button', {name:'View in terminal', exact:true}).waitFor();
  assert.equal(await page.getByText('Existing conversation', {exact:true}).count(), 1);
  assert.equal(await page.locator('textarea').count(), 1);
  // The CLI can request permission after the command has been queued.
  await page.evaluate(() => window.emit('session.event', {id:'native-test',events:[{
    seq:1,at:Date.now(),type:'permission.request',requestId:'approval-1',kind:'command',
    title:'Allow this command?',detail:'echo example',options:[
      {id:'allow',role:'allow',label:'Allow once'},{id:'deny',role:'deny',label:'Deny'},
    ],
  }]}));
  await page.getByRole('button', {name:'Allow once', exact:true}).waitFor();
  await page.getByRole('button', {name:'View in terminal', exact:true}).click();
  await page.getByRole('button', {name:'Show chat', exact:true}).waitFor();
  assert.equal(await page.getByRole('button', {name:'Allow once', exact:true}).count(), 1);
  await page.getByRole('button', {name:'Show chat', exact:true}).click();
  assert.equal(await page.getByRole('button', {name:'Allow once', exact:true}).count(), 1);
  assert.equal(await page.locator('textarea').count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Inspecting output and returning to chat never injects keys or answers.
  assert.deepEqual(await page.evaluate(() => window.calls.map(c => c.method)), ['session.input']);
});


test('native permissions show only confirmed state and require two taps for bypass', async t => {
  const page = await pageFor(t);
  await page.getByRole('button', {name:'permissions: mode',exact:true}).click();
  assert.equal(await page.getByRole('option', {selected:true}).count(), 0);
  await page.getByRole('option', {name:'Edit freely',exact:true}).click();
  await page.getByRole('button', {name:'permissions: edit',exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls[0]), {
    env:'laptop', method:'session.mode',params:{id:'native-test',mode:'acceptEdits'},
  });
  await page.getByRole('button', {name:'permissions: edit',exact:true}).click();
  await page.getByRole('option', {name:/Bypass all checks/}).click();
  assert.equal(await page.evaluate(() => window.calls.length), 1);
  await page.getByRole('option', {name:/Bypass all checks/}).click();
  await page.getByRole('button', {name:'permissions: yolo',exact:true}).waitFor();
  assert.equal(await page.locator('textarea').count(), 1);
});

test('native Shift Tab cycles every permission, bypass included, and blocked approvals prevent changes', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => window.updateSession({mode:'default'}));
  await page.getByRole('button', {name:'permissions: ask',exact:true}).waitFor();
  await page.locator('textarea').focus(); await page.keyboard.press('Shift+Tab');
  await page.getByRole('button', {name:'permissions: edit',exact:true}).waitFor();
  await page.locator('textarea').focus(); await page.keyboard.press('Shift+Tab');
  await page.getByRole('button', {name:'permissions: yolo',exact:true}).waitFor();
  await page.locator('textarea').focus(); await page.keyboard.press('Shift+Tab');
  await page.getByRole('button', {name:'permissions: ask',exact:true}).waitFor();
  await page.evaluate(() => { window.sessionStatus = 'blocked'; window.emit('session.update', {session:{...window.currentSession,status:'blocked'}}); });
  await page.getByRole('button', {name:'permissions: ask',exact:true}).click();
  assert.equal(await page.getByRole('option', {name:'Edit freely',exact:true}).isDisabled(), true);
  await page.locator('textarea').focus(); await page.keyboard.press('Shift+Tab');
  assert.deepEqual(await page.evaluate(() => window.calls.map(c => c.params.mode)), ['acceptEdits','bypassPermissions','default']);
});
