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
const { validateVisual, previewVisual } = await import('../../packages/connect/src/visual.js');
let browser, script, css;
const source = validateVisual({ renderId: '0'.repeat(24), html: `<style>main{padding:20px}h1{font-size:24px}input{max-width:100%}</style><main><h1>Desk clamp clearance</h1><label>Desk thickness <input type="range" min="10" max="80" value="25"></label><output>25 mm</output><p id="guard"></p><a href="https://example.com/clearance">Reference</a><script>const slider=document.querySelector('input'),out=document.querySelector('output');slider.oninput=()=>out.textContent=slider.value+' mm';try{parent.document.body.dataset.compromised='yes'}catch{document.querySelector('#guard').textContent='Isolated'};try{localStorage.setItem('compromised','yes')}catch{};</script></main>` }).html;
before(async () => {
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Transcript} from './apps/web/src/session/Transcript';
    import {SessionView} from './apps/web/src/App';
    const root=createRoot(document.getElementById('root'));
    const read=async ref=>{window.reads=(window.reads||0)+1;if(window.failRead)throw Error('Machine offline');return {html:${JSON.stringify(source)}}};
    window.render=()=>root.render(<Transcript status="idle" loaded readVisual={read} turns={[{id:'local-visual-1',local:true,text:'',at:1,done:{status:'ok'},items:[{id:'visual-1',kind:'visual',text:'',status:'ok',startedAt:1,visual:{ref:'ref',title:'Desk clamp clearance',height:420,bytes:1000}}]}]}/>);
    const client={subscribe:()=>()=>{},on:()=>()=>{},rpc:async(env,method,p)=>{
      if(method==='session.visual'){window.lastVisualRead={env,...p};return read(p.ref)};
      if(method==='session.messages')return {messages:[{role:'assistant',text:'',tools:[],visual:{ref:'ref',title:'Native diagram',height:420,bytes:1000}}],status:'idle'};
      if(method==='session.events')return {events:[],pending:[],last:0,session:{status:'idle'}};
      if(method==='model.list')return {models:[],default:null};return {pending:[],ok:true};
    }};
    window.native=()=>root.render(<SessionView client={client} env={{id:'remote',name:'VM',online:true}} session={{id:'native1',engine:'claude',nativeCli:true,nativeChat:true,pty:true,status:'idle',title:'Native',cwd:'/tmp'}} onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}}/>);
    window.render();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', minify: true, jsx: 'automatic', plugins: [{ name: 'native-view-fixture', setup(b) { b.onLoad({ filter: /\/App\.tsx$/ }, async a => ({ contents: (await readFile(a.path, 'utf8')) + '\nexport { SessionView };', loader: 'tsx' })); } }] });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => { await browser?.close(); rmSync(process.env.HELM_DIR, { recursive: true, force: true }); });
async function open(t, width = 390) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  t.after(() => page.close());
  page.on('pageerror', error => t.diagnostic(error.message));
  await page.route('http://helm.test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root" style="height:100vh;display:flex;flex-direction:column"></div>' }));
  await page.goto('http://helm.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  try { await page.frameLocator('.visual-frame').getByText('Isolated').waitFor({ timeout: 5000 }); }
  catch (error) { t.diagnostic(await page.locator('#root').innerText()); throw error; }
  return page;
}

test('a finished chat shows its interactive page on a phone, sandboxed and outside folded tool steps', async t => {
  const page = await open(t);
  assert.equal(await page.getByText('Working…').count(), 0);
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

test('Expand, Source, Escape, and Save work with focus restored to the launcher', async t => {
  const page = await open(t, 1100);
  await page.getByRole('button', { name: 'Expand', exact: true }).click();
  const expanded = page.getByRole('dialog');
  await expanded.waitFor();
  assert.ok((await expanded.boundingBox()).width > 900);
  await page.frameLocator('.visual-dialog iframe').locator('input').focus();
  await page.keyboard.press('Escape');
  await expanded.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Expand', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  assert.match(await page.locator('.visual-source').innerText(), /slider.oninput/);
  await page.keyboard.press('Escape');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), 'Desk clamp clearance.html');
  assert.match(await readFile(await download.path(), 'utf8'), /Desk thickness/);
});

test('an offline read has an explicit retry; forged resize messages cannot control the frame', async t => {
  const page = await open(t);
  const height = await page.locator('.visual-frame').evaluate(el => el.offsetHeight);
  await page.evaluate(() => window.postMessage({ type: 'helm.visual', height: 1200 }, '*'));
  assert.equal(await page.locator('.visual-frame').evaluate(el => el.offsetHeight), height);
  await page.reload();
  await page.addStyleTag({ content: css });
  await page.evaluate(() => { window.failRead = true; });
  await page.addScriptTag({ content: script });
  await page.getByRole('alert').getByText('Machine offline').waitFor();
  await page.evaluate(() => { window.failRead = false; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.frameLocator('.visual-frame').getByText('Isolated').waitFor();
});

test('CLI preview screenshots the same sandbox and reports JavaScript errors', async () => {
  const output = join(process.env.HELM_DIR, 'preview.png');
  const html = validateVisual({ renderId: '1'.repeat(24), html: '<h1>Preview</h1><script>console.log("hello");throw Error("diagram failed")</script>' }).html;
  const result = await previewVisual(html, { output, width: 390, appearance: 'light' });
  assert.equal(result.width, 390);
  assert.ok((await readFile(output)).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  assert.ok(result.messages.some(msg => msg.text === 'hello'));
  assert.ok(result.errors.some(msg => /diagram failed/.test(msg)));
});

test('native CLI conversations load their saved visual from the correct remote machine', async t => {
  const page = await open(t);
  await page.evaluate(() => window.native());
  await page.getByRole('button', { name: 'Expand', exact: true }).waitFor({ state: 'visible' });
  await page.frameLocator('.visual-frame').getByText('Isolated').waitFor();
  assert.deepEqual(await page.evaluate(() => window.lastVisualRead), { env: 'remote', id: 'native1', ref: 'ref' });
  assert.equal(await page.getByText('Working…').count(), 0);
});

test('snapshot policy blocks fetches and external scripts while allowing inline interaction', async t => {
  const page = await browser.newPage(); t.after(() => page.close());
  const { visualDocument } = await import('@helm/protocol/visual');
  let requests = 0;
  await page.route('https://visual-test.invalid/**', route => { requests++; return route.abort(); });
  const html = validateVisual({ renderId: '2'.repeat(24), html: '<script src="https://visual-test.invalid/external.js"></script><script>fetch("https://visual-test.invalid/state").catch(()=>document.documentElement.dataset.blocked="yes")</script><button onclick="this.textContent=\'Works\'">Adjust</button>' }).html;
  await page.setContent('<iframe sandbox="allow-scripts"></iframe>');
  await page.locator('iframe').evaluate((frame, html) => { frame.srcdoc = html; }, visualDocument(html));
  await page.frameLocator('iframe').locator('html[data-blocked="yes"]').waitFor();
  await page.frameLocator('iframe').getByText('Adjust').click();
  assert.equal(await page.frameLocator('iframe').getByText('Works').count(), 1);
  assert.equal(requests, 0);
});
