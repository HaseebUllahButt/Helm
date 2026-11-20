import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A message the machine has not confirmed shows its words and a note after
// a few seconds; a slow link says so; a failure offers Retry (2026-11-18).
let browser, script;
before(async () => {
  const result = await build({
    stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { DeliveryStatus } from './apps/web/src/session/DeliveryStatus';
      window.pending=[]; window.failed=[]; window.retried=[]; window.watching=0; window.ms=null;
      const listeners=new Set();
      window.fire=(kind,payload)=>listeners.forEach(fn=>fn('laptop',kind,payload||{}));
      window.retryEvents=[]; window.addEventListener('helm:retried-send',e=>window.retryEvents.push(e.detail));
      const client={
        pendingActions:()=>window.pending, failedActions:()=>window.failed, resumeActions:async()=>[],
        on:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
        watchLatency:()=>{window.watching++;return()=>{window.watching--;};}, latency:()=>window.ms,
        retryFailedAction:async(id)=>{window.retried.push(id);window.failed=[];},
        dismissFailedAction:()=>{window.failed=[];window.fire('delivery');},
      };
      createRoot(document.getElementById('root')).render(<DeliveryStatus client={client} env="laptop" id="chat" machine="Laptop" />);
    `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

async function page(t) {
  const p = await browser.newPage(); t.after(() => p.close());
  await p.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await p.goto('http://helm.test/'); await p.addScriptTag({ content: script });
  return p;
}
const message = (savedAt) => ({ env: 'laptop', method: 'session.deliver', actionId: 'a'.repeat(32), savedAt,
  params: { id: 'chat', data: 'first words', messageId: 'a'.repeat(32) } });

test('an unconfirmed message gets a note after 3 s, and loses it when confirmed', async t => {
  const p = await page(t);
  await p.evaluate((m) => { window.pending = [m]; window.fire('delivery'); }, message(Date.now()));
  await p.waitForFunction(() => window.watching === 1);
  assert.equal(await p.getByText('first words').count(), 0, 'a quick send shows nothing');
  await p.getByText('Sending to Laptop…').waitFor({ timeout: 6000 });
  await p.getByText('first words').waitFor();
  await p.evaluate(() => window.fire('latency', { ms: 8000 }));
  await p.getByText("Laptop's link is slow. Your message waits to send.").waitFor();
  await p.evaluate(() => { window.pending = []; window.fire('delivery'); });
  await p.getByText('first words').waitFor({ state: 'detached' });
  await p.waitForFunction(() => window.watching === 0);
});

test('a failed message offers Retry, which clears the same words from the box', async t => {
  const p = await page(t);
  await p.evaluate((m) => { window.failed = [{ ...m, failure: { message: 'unknown session: chat' } }]; window.fire('delivery'); }, message(1));
  await p.getByText('Laptop no longer has this chat. Your message did not send. Start a new chat.').waitFor();
  await p.getByRole('button', { name: 'Retry' }).click();
  await p.waitForFunction(() => window.retried.length === 1);
  assert.deepEqual(await p.evaluate(() => window.retryEvents), [{ env: 'laptop', id: 'chat', text: 'first words' }]);
});
