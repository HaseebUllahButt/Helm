import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
let browser, script;
before(async () => {
  script = (await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Composer} from './apps/web/src/session/Composer';
    const root=createRoot(document.getElementById('root'));
    window.show=(text,waiting=false,sendNow=false)=>root.render(<Composer draft="" setDraft={()=>{}} onSend={()=>{}} working={waiting} waiting={waiting} ask={waiting?'approval':undefined}
      queued={text?[{turn:{id:'waiting',text,items:[]},text,attachments:0}]:[]}
      onEditQueued={()=>window.action='edit'} onWithdrawQueued={()=>window.action='withdraw'}
      onSendQueued={sendNow?()=>window.action='send':undefined} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' })).outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(() => browser?.close());
test('waiting slash commands return to the draft, while normal messages can be edited', async t => {
  const p = await browser.newPage(); t.after(() => p.close());
  await p.setContent('<div id="root"></div>'); await p.addScriptTag({ content: script });
  await p.evaluate(() => window.show('/compact keep the task'));
  const withdraw = p.getByRole('button', { name: 'Return waiting message to draft: /compact keep the task', exact: true });
  await withdraw.waitFor(); assert.equal(await p.getByRole('button', { name: /^Edit waiting message/ }).count(), 0);
  await withdraw.click(); assert.equal(await p.evaluate(() => window.action), 'withdraw');
  await p.evaluate(() => window.show('Keep this message'));
  const edit = p.getByRole('button', { name: 'Edit waiting message: Keep this message', exact: true });
  await edit.waitFor(); await edit.click(); assert.equal(await p.evaluate(() => window.action), 'edit');
});
for (const width of [390, 1280]) test(`approval replies explain their wait at ${width}px`, async t => {
  const p = await browser.newPage({ viewport: { width, height: 844 } }); t.after(() => p.close());
  await p.setContent('<div id="root"></div>'); await p.addScriptTag({ content: script });
  await p.evaluate(() => window.show('', true));
  await p.waitForFunction(() => document.querySelector('textarea')?.placeholder.includes('wait for approval'));
  await p.evaluate(() => window.show('Waiting reply', true, true));
  await p.waitForFunction(() => document.querySelector('textarea')?.placeholder.includes('Send now'));
  await p.getByRole('button', { name: 'Send now', exact: true }).waitFor();
});
