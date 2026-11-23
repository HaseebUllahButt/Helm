import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-visual-browser-'));
for (const [key, name] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(process.env.HELM_DIR, name);
const { validateVisual } = await import('../../packages/connect/src/visual.js');
const { SECURITY_HEADERS } = await import('../../apps/relay/src/http.js');
const { VISUAL_FRAME_HEADERS } = await import('../../apps/relay/src/visual-frame.js');
const { visualHostDocument } = await import('@helm/protocol/visual');
let browser, script, css;
const source = validateVisual({ renderId: '0'.repeat(24), html: `<style>main{padding:20px}h1{font-size:24px}input{max-width:100%}</style><main><h1>Desk clamp clearance</h1><label>Desk thickness <input type="range" min="10" max="80" value="25"></label><output>25 mm</output><p id="guard"></p><a href="https://example.com/clearance">Reference</a><script>const slider=document.querySelector('input'),out=document.querySelector('output');slider.oninput=()=>out.textContent=slider.value+' mm';try{parent.document.body.dataset.compromised='yes'}catch{document.querySelector('#guard').textContent='Isolated'};try{localStorage.setItem('compromised','yes')}catch{};</script></main>` }).html;
before(async () => {
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Transcript} from './apps/web/src/session/Transcript';
    const root=createRoot(document.getElementById('root'));
    const read=async ref=>{if(window.failRead)throw Error('Machine offline');return {html:window.visualHtml||${JSON.stringify(source)}}};
    window.render=(ref='ref')=>root.render(<Transcript status="idle" loaded readVisual={read} turns={[{id:'local-visual-1',local:true,text:'',at:1,done:{status:'ok'},items:[{id:'visual-1',kind:'visual',text:'',status:'ok',startedAt:1,visual:{ref,title:'Desk clamp clearance',height:420,bytes:1000}}]}]}/>);
    window.render();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', minify: true, jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => { await browser?.close(); rmSync(process.env.HELM_DIR, { recursive: true, force: true }); });
async function open(t) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  t.after(() => page.close());
  page.on('pageerror', error => t.diagnostic(error.message));
  await page.route('http://helm.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/helm/visual-frame') return route.fulfill({ headers: VISUAL_FRAME_HEADERS, body: visualHostDocument() });
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', headers: SECURITY_HEADERS, body: script });
    if (path === '/fixture.css') return route.fulfill({ contentType: 'text/css', headers: SECURITY_HEADERS, body: css });
    return route.fulfill({ headers: { ...SECURITY_HEADERS, 'content-type': 'text/html' }, body: '<link rel="stylesheet" href="/fixture.css"><div id="root" style="height:100vh;display:flex;flex-direction:column"></div>' });
  });
  await page.goto('http://helm.test/');
  await page.addScriptTag({ url: '/fixture.js' });
  try { await page.frameLocator('.visual-frame').getByText('Isolated').waitFor({ timeout: 5000 }); }
  catch (error) { t.diagnostic(await page.locator('#root').innerText()); throw error; }
  return page;
}

test('a finished chat shows its interactive page on a phone, sandboxed and outside folded tool steps', async t => {
  const page = await open(t);
  assert.equal(await page.locator('.working').count(), 0);
  assert.equal(await page.locator('.steps').count(), 0);
  assert.equal(await page.locator('.visual-frame').getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await page.evaluate(() => document.body.dataset.compromised), undefined);
  assert.equal(await page.evaluate(() => localStorage.getItem('compromised')), null);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const frame = page.frameLocator('.visual-frame');
  await frame.locator('input').fill('40');
  assert.equal(await frame.locator('output').innerText(), '40 mm');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await frame.locator('html[data-theme="light"]').waitFor();
  assert.equal(await frame.locator('output').innerText(), '40 mm', 'theme changes preserve interaction state');
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, 'visual-mobile.png') });
  const popup = page.waitForEvent('popup');
  await frame.getByText('Reference').click();
  const tab = await popup; t.after(() => tab.close());
  assert.equal(tab.url().startsWith('https://example.com/'), true);
});

test('an offline read has an explicit retry; forged resize messages cannot control the frame', async t => {
  const page = await open(t);
  const height = await page.locator('.visual-frame').evaluate(el => el.offsetHeight);
  await page.evaluate(() => window.postMessage({ type: 'helm.visual', height: 1200 }, '*'));
  assert.equal(await page.locator('.visual-frame').evaluate(el => el.offsetHeight), height);
  await page.reload();
  await page.evaluate(() => { window.failRead = true; });
  await page.addScriptTag({ url: '/fixture.js' });
  await page.getByRole('alert').getByText('This machine is not connected. Check the connection. Try again.').waitFor();
  await page.evaluate(() => { window.failRead = false; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.frameLocator('.visual-frame').getByText('Isolated').waitFor();
});

test('snapshot policy blocks fetches and external scripts while allowing inline interaction', async t => {
  const page = await open(t);
  let requests = 0;
  await page.route('https://visual-test.invalid/**', route => { requests++; return route.abort(); });
  const html = validateVisual({ renderId: '2'.repeat(24), html: '<script src="https://visual-test.invalid/external.js"></script><script>fetch("https://visual-test.invalid/state").catch(()=>document.documentElement.dataset.blocked="yes")</script><button onclick="this.textContent=\'Works\'">Adjust</button>' }).html;
  await page.evaluate(html => { window.visualHtml = html; window.render('policy'); }, html);
  await page.frameLocator('.visual-frame').locator('html[data-blocked="yes"]').waitFor();
  await page.frameLocator('.visual-frame').getByText('Adjust').click();
  assert.equal(await page.frameLocator('.visual-frame').getByText('Works').count(), 1);
  assert.equal(requests, 0);
});
