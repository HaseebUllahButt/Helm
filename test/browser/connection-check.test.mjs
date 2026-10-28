import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
let browser, script;
before(async () => {
  script = (await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ConnectionCheck } from './apps/web/src/ConnectionCheck';
    const client = { connected: true, rpc: async (id) => {
      if (id === 'lost') throw Error('secret-error');
      return { machines: [{env:'lost',name:'Laptop',url:null,lastSeen:Date.now()-120000}],
        history:[{env:'lost',state:'disconnected',at:Date.now()}] };
    }};
    createRoot(document.getElementById('root')).render(<ConnectionCheck client={client} envs={[{id:'home',name:'Home'}, {id:'lost',name:'Laptop'}]} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' })).outputFiles[0].text;
  browser = await chromium.launch({headless:true, ...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM}: {})});
});
after(async () => browser?.close());
test('connection check reports the broken step and exports no private data', async t => {
  const page = await browser.newPage({ viewport: { width:390, height:844 }, acceptDownloads:true });
  t.after(() => page.close());
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({content:script});
  await page.getByRole('button', {name:'Check connection',exact:true}).click();
  await page.getByText('Laptop has no connection from here.', {exact:false}).waitFor();
  await page.getByText('This device cannot read this machine through a Helm home.', {exact:false}).waitFor();
  await page.getByText('Recent connection changes', {exact:true}).click();
  await page.getByText('Laptop: connection lost', {exact:false}).waitFor();
  const download = page.waitForEvent('download');
  await page.getByRole('button', {name:'Save support report'}).click();
  const stream = await (await download).createReadStream(); const parts=[];
  for await (const part of stream) parts.push(part);
  const data=Buffer.concat(parts).toString();
  assert.doesNotMatch(data,/Laptop|Home|secret|https|chat/);
  assert.equal(JSON.parse(data).machines[1].failed,true);
});
