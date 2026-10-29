import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-canvas-browser-'));
process.env.HELM_DB = join(process.env.HELM_DIR, 'test.db');
const { SECURITY_HEADERS } = await import('../../apps/relay/src/http.js');
import { VISUAL_FRAME_HEADERS } from '../../apps/relay/src/visual-frame.js';
import { visualHostDocument } from '@helm/protocol/visual';

// A real chat screen with a fake machine: the canvas is driven through the
// chat's `canvas` record exactly as the machine sends it.
let browser, script, css;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {DrivenSession} from './apps/web/src/session/DrivenSession';
    const env={id:'canvas-test',name:'Laptop',online:true,info:{}};
    const base={cwd:'/project',engine:'claude',profileId:'claude',driver:'claude',status:'idle'};
    window.chats={a:{...base,id:'a',title:'Chat A'},b:{...base,id:'b',title:'Chat B'}};
    const page=(text)=>'<main><h1>'+text+'</h1><script>document.body.dataset.ran="yes"</script></main>';
    const pages={inline:page('Inline chart'),board:page('Agent board')};
    const visual=(ref,title,extra)=>({ref,title,height:300,bytes:100,...extra});
    window.visual=visual;
    const events=[
      {seq:1,at:1,type:'turn.start',turnId:'t1',text:'Draw it'},
      {seq:2,at:2,type:'item.start',turnId:'t1',id:'visual-1',kind:'visual',visual:visual('inline','Inline chart')},
      {seq:3,at:3,type:'item.done',turnId:'t1',id:'visual-1',status:'ok'},
      {seq:4,at:4,type:'item.start',turnId:'t1',id:'visual-2',kind:'visual',visual:visual('live','Live site',{placement:'canvas',url:'http://live.test/'})},
      {seq:5,at:5,type:'item.done',turnId:'t1',id:'visual-2',status:'ok'},
      {seq:6,at:6,type:'turn.done',turnId:'t1',status:'ok'},
    ];
    window.reads=[];
    const client={pendingActions:()=>[],resumeActions:async()=>[],on:()=>()=>{},subscribe:()=>{},rpc:async(_env,method,params)=>{
      if(method==='session.visual'){window.reads.push(params);if(params.ref!=='doc')return {html:pages[params.ref]};
        if(params.page===undefined)return {total:40,pages:Array.from({length:30},()=>({width:1600,height:900}))};
        return {image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII='};}
      if(method==='session.events')return {session:window.chats[params.id],events:params.since||params.id!=='a'?[]:events,pending:[],last:params.id==='a'?6:0};
      if(method==='session.watch')return {last:0};
      if(method==='model.list')return {models:[],modes:[]};
      if(method==='git.files')return {root:'/project',start:'',files:['notes/plan.md'],secret:[],truncated:false};
      if(method==='git.file')return {path:params.path,text:'# Plan\\n\\nShip the canvas.',hash:'h1'};
      return {ok:true};
    }};
    function Chat(){
      const [session,setSession]=useState(window.chats.a);
      window.show=(id,patch)=>{window.chats[id]={...window.chats[id],...patch};setSession(window.chats[id]);};
      return <DrivenSession key={session.id} client={client} env={env} session={session} onSession={()=>{}} onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}}/>;
    }
    createRoot(document.getElementById('root')).render(<Chat/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') + await readFile('apps/web/src/session/side-dock.css', 'utf8');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => { await browser?.close(); rmSync(process.env.HELM_DIR, { recursive: true, force: true }); });

async function open(t, width) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  t.after(() => page.close());
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => t.diagnostic(error.stack));
  await page.route('http://live.test/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Live site</h1><script>try{parent.document.title="owned"}catch{document.body.dataset.isolated="yes"};localStorage.setItem("live-storage","works");document.body.dataset.storage=localStorage.getItem("live-storage")</script>' }));
  await page.route('http://helm.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/helm/visual-frame') return route.fulfill({ headers: VISUAL_FRAME_HEADERS, body: visualHostDocument() });
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', headers: SECURITY_HEADERS, body: script });
    if (path === '/fixture.css') return route.fulfill({ contentType: 'text/css', headers: SECURITY_HEADERS, body: css });
    return route.fulfill({ headers: { ...SECURITY_HEADERS, 'content-type': 'text/html' }, body: '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><section class="main showing" id="root" style="height:100vh"></section>' });
  });
  await page.goto('http://helm.test/');
  await page.addScriptTag({ url: '/fixture.js' });
  await page.getByRole('button', { name: 'Open Inline chart in canvas' }).waitFor();
  return page;
}

const canvas = page => page.getByRole('complementary', { name: 'Canvas' });
const request = (page, id, canvasRecord, patch = {}) => page.evaluate(([id, canvasRecord, patch]) => window.show(id, { canvas: canvasRecord, ...patch }), [id, canvasRecord, patch]);
const agentBoard = { requestId: 'r1', visual: { ref: 'board', title: 'Agent board', height: 300, bytes: 100, placement: 'canvas' } };

test('a visual moves into a column beside the chat, and the composer stays usable', async t => {
  const page = await open(t, 1280);
  await page.getByRole('button', { name: 'Open Inline chart in canvas' }).click();
  const frame = canvas(page).locator('iframe.visual-frame');
  await page.frameLocator('.canvas iframe.visual-frame').locator('body[data-ran="yes"] h1', { hasText: 'Inline chart' }).waitFor();
  assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts', 'the saved page keeps its sealed frame');
  // While the canvas shows the page, the chat keeps only one line for it.
  const line = page.locator('.visual-folded', { hasText: 'Inline chart' });
  await line.getByText('Shown in canvas').waitFor();
  assert.equal(await line.locator('iframe').count(), 0);
  assert.equal(await page.locator('.messages iframe.visual-frame, .visual-reply iframe.visual-frame').count(), 0, 'the page is not shown twice');
  const side = await canvas(page).boundingBox();
  const composer = page.locator('textarea').first();
  const box = await composer.boundingBox();
  assert.ok(box.x + box.width <= side.x + 1, 'the composer sits left of the canvas, not under it');
  await composer.fill('typing beside the canvas');
  assert.equal(await composer.inputValue(), 'typing beside the canvas');
  assert.equal(await canvas(page).isVisible(), true);
  // A live page is a card in the chat, never a running site inline.
  const card = page.locator('.visual-link');
  assert.equal(await card.locator('iframe').count(), 0);
  assert.equal(await card.getByRole('link', { name: 'Open in new tab' }).getAttribute('href'), 'http://live.test/');
  await card.getByRole('button', { name: 'Open in canvas' }).click();
  const live = canvas(page).locator('iframe.canvas-live');
  assert.equal(await live.getAttribute('sandbox'), 'allow-scripts allow-forms allow-popups allow-same-origin');
  assert.equal(await live.getAttribute('src'), 'http://live.test/');
  await page.frameLocator('.canvas-live').locator('body[data-isolated="yes"]').waitFor();
  // The canvas shows another page now, so the chart comes back in the chat.
  await page.frameLocator('.visual-reply iframe.visual-frame').locator('h1', { hasText: 'Inline chart' }).waitFor();
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, 'canvas-wide.png') });
  assert.notEqual(await page.title(), 'owned');
  assert.equal(await page.frameLocator('.canvas-live').locator('body').getAttribute('data-storage'), 'works');
  assert.equal(await page.evaluate(() => localStorage.getItem('live-storage')), null, 'the live site cannot write Helm storage');
  assert.equal(await canvas(page).getByRole('link', { name: 'Open in new tab' }).getAttribute('href'), 'http://live.test/');
  await request(page, 'a', { requestId: 'same-origin', visual: { ...agentBoard.visual, url: 'http://helm.test/' } });
  await canvas(page).getByText('Open this Helm address in a new tab.').waitFor();
  assert.equal(await canvas(page).locator('iframe').count(), 0);

});

test('the agent opens the canvas once per request, a closed canvas stays closed, and chats stay apart', async t => {
  const page = await open(t, 1280);
  assert.equal(await canvas(page).count(), 0);
  // A project file first.
  await request(page, 'a', { requestId: 'r0', path: 'notes/plan.md' });
  await canvas(page).getByRole('heading', { name: 'Plan' }).waitFor();
  // Then a page that is not in the loaded conversation at all: the request alone opens it, in place of the file.
  await request(page, 'a', agentBoard);
  await page.frameLocator('.canvas iframe.visual-frame').getByText('Agent board').waitFor();
  assert.equal(await canvas(page).getByRole('heading', { name: 'Plan' }).count(), 0);
  assert.ok(await page.evaluate(() => window.reads.some(read => read.ref === 'board')));
  await canvas(page).getByRole('button', { name: 'Close canvas' }).click();
  await canvas(page).waitFor({ state: 'detached' });
  await request(page, 'a', agentBoard, { title: 'Chat A renamed' });
  await page.evaluate(() => window.show('b', {}));
  await page.evaluate(() => window.show('a', {}));
  await page.getByRole('button', { name: 'Open Inline chart in canvas' }).waitFor();
  assert.equal(await canvas(page).count(), 0, 'the same request does not reopen a closed canvas, even after the chat remounts');
  await page.reload();
  await page.addScriptTag({ url: '/fixture.js' });
  await page.getByRole('button', { name: 'Open Inline chart in canvas' }).waitFor();
  await request(page, 'a', agentBoard);
  assert.equal(await canvas(page).count(), 0, 'or after a reload');
  // The Canvas button brings back what it showed.
  await page.locator('.session-bar').getByRole('button', { name: 'Canvas', exact: true }).click();
  await page.frameLocator('.canvas iframe.visual-frame').getByText('Agent board').waitFor();
  await canvas(page).getByRole('button', { name: 'Close canvas' }).click();
  await canvas(page).waitFor({ state: 'detached' });
  // A newer request opens even though the owner closed the last one: here a live page.
  await request(page, 'a', { requestId: 'r2', visual: { ref: 'live', title: 'Live site', height: 420, bytes: 100, placement: 'canvas', url: 'http://live.test/' } });
  await page.frameLocator('.canvas-live').getByText('Live site').waitFor();
  // And the owner can still put any visual from the chat there.
  await page.getByRole('button', { name: 'Open Inline chart in canvas' }).click();
  await page.frameLocator('.canvas iframe.visual-frame').getByText('Inline chart').waitFor();
  assert.equal(await canvas(page).locator('.canvas-live').count(), 0);
  // Another chat neither sees A's canvas nor acts on A's request.
  await page.evaluate(() => window.show('b', {}));
  await page.locator('.session-bar').getByText('Chat B').waitFor();
  assert.equal(await canvas(page).count(), 0);
  await request(page, 'b', { requestId: 'r3', path: 'notes/plan.md' });
  await canvas(page).getByRole('heading', { name: 'Plan' }).waitFor();
  await page.evaluate(() => window.show('a', {}));
  await page.frameLocator('.canvas iframe.visual-frame').getByText('Inline chart').waitFor();
});

test('a PDF shows as page pictures, read-only, loading only the pages near the view', async t => {
  const pdf = { requestId: 'p1', visual: { ref: 'doc', title: 'Before and Now', height: 420, bytes: 2048, kind: 'pdf', pages: 30, total: 40, placement: 'canvas' } };
  for (const width of [1280, 390]) {
    const page = await open(t, width);
    await request(page, 'a', pdf);
    const dock = page.locator('.canvas');
    await dock.getByText('First 30 of 40 pages').waitFor();
    assert.equal(await dock.locator('.pdf-page').count(), 30);
    await dock.getByRole('img', { name: 'Page 1', exact: true }).waitFor();
    const loaded = () => page.evaluate(() => [...new Set(window.reads.filter(r => r.ref === 'doc' && r.page !== undefined).map(r => r.page))]);
    assert.ok(!(await loaded()).includes(29), 'the last page waits until it is near the view');
    assert.equal(await dock.locator('img').count() < 30, true);
    await dock.locator('.pdf-page').last().scrollIntoViewIfNeeded();
    await dock.getByRole('img', { name: 'Page 30', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.pdf-page[data-page="1"] img'));
    await dock.getByRole('button', { name: 'Zoom' }).click();
    assert.ok(await dock.locator('.pdf-page').first().evaluate(el => el.getBoundingClientRect().width > el.parentElement.clientWidth), 'Zoom makes a page wider than the canvas');
    await dock.getByRole('button', { name: 'Fit width' }).click();
    assert.equal(await dock.locator('iframe, textarea, [contenteditable]').count(), 0);
    assert.equal(await dock.getByRole('button', { name: /^(Save|Edit|Create file)$/ }).count(), 0, 'a PDF has no edit or save controls');
  }
});

test('the owner collapses a page to one line, the device remembers it, and Show brings it back', async t => {
  const page = await open(t, 1280);
  const chart = page.frameLocator('.visual-reply iframe.visual-frame').locator('h1', { hasText: 'Inline chart' });
  await chart.waitFor();
  await page.getByRole('button', { name: 'Collapse Inline chart' }).click();
  const line = page.locator('.visual-folded', { hasText: 'Inline chart' });
  await line.getByText('Collapsed').waitFor();
  assert.equal(await page.locator('.visual-reply iframe.visual-frame').count(), 0);
  await page.reload();
  await page.addScriptTag({ url: '/fixture.js' });
  await line.getByRole('button', { name: 'Show' }).waitFor();
  assert.equal(await page.locator('.visual-reply iframe.visual-frame').count(), 0, 'it stays collapsed after a reload');
  // Open in canvas works from the line, and closing the canvas keeps the line.
  await line.getByRole('button', { name: 'Open in canvas' }).click();
  await page.frameLocator('.canvas iframe.visual-frame').getByText('Inline chart').waitFor();
  await canvas(page).getByRole('button', { name: 'Close canvas' }).click();
  await canvas(page).waitFor({ state: 'detached' });
  await line.getByRole('button', { name: 'Show' }).click();
  await chart.waitFor();
  assert.equal(await page.locator('.visual-folded').count(), 0);
});

test('on a phone the canvas covers the chat and closes back to it', async t => {
  const page = await open(t, 390);
  await request(page, 'a', agentBoard);
  const sheet = page.getByRole('dialog', { name: 'Canvas' });
  await page.frameLocator('.canvas iframe.visual-frame').getByText('Agent board').waitFor();
  const box = await sheet.boundingBox();
  assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 390, 844]);
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, 'canvas-phone.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await sheet.getByRole('button', { name: 'Close canvas' }).click();
  await sheet.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Open Inline chart in canvas' }).click();
  await page.frameLocator('.canvas iframe.visual-frame').getByText('Inline chart').waitFor();
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });
});

test('beside the chat, Escape closes the canvas from anywhere, but not while a menu is open', async t => {
  const page = await open(t, 1280);
  const bar = page.locator('.session-bar');
  await bar.getByRole('button', { name: 'Canvas', exact: true }).click();
  await canvas(page).waitFor();
  const composer = page.locator('textarea').first();
  await composer.fill('still here');
  await page.keyboard.press('Escape');
  await canvas(page).waitFor({ state: 'detached' });
  assert.equal(await composer.inputValue(), 'still here', 'Escape leaves the draft alone');
  await bar.getByRole('button', { name: 'Canvas', exact: true }).click();
  await canvas(page).waitFor();
  await bar.getByRole('button', { name: 'more', exact: true }).click();
  await bar.locator('.menu').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await canvas(page).isVisible(), true, 'an open menu keeps the canvas');
});
