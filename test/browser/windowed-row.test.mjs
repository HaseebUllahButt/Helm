import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

let browser, script, css;
before(async () => {
  const result = await build({ stdin: { contents: `
    import React, {useLayoutEffect} from 'react';
    import {WindowedRow} from './apps/web/src/session/WindowedRow';
    import { createRoot } from 'react-dom/client';
    import { Transcript } from './apps/web/src/session/Transcript';
    import { apply, emptyLog } from './apps/web/src/session/types';
    const log = emptyLog(); let seq = 0;
    const emit = e => apply(log, {seq: ++seq, at: seq, ...e});
    for (let i = 0; i < 300; i++) {
      emit({type:'turn.start',turnId:'t'+i,text:'Question '+i});
      emit({type:'item.start',turnId:'t'+i,id:'tool'+i,kind:'tool',name:'Read',input:{path:'/repo/file'+i}});
      emit({type:'item.done',id:'tool'+i,status:'ok'});
      emit({type:'item.start',turnId:'t'+i,id:'a'+i,kind:'text'});
      emit({type:'item.delta',id:'a'+i,text:'Answer '+i+'. '+ 'Some readable words. '.repeat(20)});
      emit({type:'turn.done',turnId:'t'+i,status:'ok'});
    }
    const root = createRoot(document.getElementById('root'));
    window.selectionList=()=>root.render(<SelectedList />);
    function SelectedList() {
      useLayoutEffect(()=>{
        const range=document.createRange();
        range.setStart(document.querySelector('[data-select="0"]').firstChild,0);
        range.setEndAfter(document.querySelector('[data-select="39"]'));
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      },[]);
      return <div className="chat"><div className="timeline">{Array.from({length:40},(_,i)=><WindowedRow key={i} enabled eager><p data-select={i} style={{height:100}}>Selected words {i}</p></WindowedRow>)}</div></div>;
    }
    root.render(<Transcript place="long" turns={log.turns} status="idle" loaded />);
  `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = result.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(() => browser?.close());
async function open(t, width = 390) {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  t.after(() => page.close());
  await page.setContent('<div id="root" style="height:100vh;display:flex;flex-direction:column;min-height:0"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await page.locator('[data-turn-id="t299"]').first().waitFor({ state: 'visible' });
  return page;
}
for (const width of [390, 1280]) test(`long chats draw nearby turns and reveal older turns while scrolling at ${width}px`, async t => {
  const page = await open(t, width);
  assert.equal(await page.locator('[data-row-turn]').count(), 300);
  assert.ok(await page.locator('.turn.user').count() < 35, 'only nearby messages build their content');
  await page.locator('.chat').evaluate(el => { el.scrollTop = 0; });
  await page.locator('.turn.user[data-turn-id="t0"]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-turn-id="t299"]'));
  assert.ok(await page.locator('.turn.user').count() < 35);
  await page.getByRole('button', { name: 'Scroll to the latest message' }).click();
  await page.locator('.turn.user[data-turn-id="t299"]').waitFor({ state: 'visible' });
  assert.ok(await page.locator('.turn.user').count() < 35);
});

test('selected words and open tools survive offscreen cleanup', async t => {
  const page = await open(t);
  await page.locator('[data-row-turn="t299"] .work-head').click();
  await page.locator('[data-item-id="tool299"]').waitFor({ state: 'visible' });
  await page.evaluate(() => {
    document.activeElement?.blur();
    const text = document.querySelector('[data-row-turn="t298"] .prose');
    const range = document.createRange(); range.selectNodeContents(text);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  await page.locator('.chat').evaluate(el => el.scrollTop = 0);
  await page.locator('.turn.user[data-turn-id="t0"]').waitFor({ state: 'visible' });
  assert.match(await page.evaluate(() => window.getSelection().toString()), /Answer 298/);
  assert.equal(await page.locator('[data-row-turn="t299"] .work-head').getAttribute('aria-expanded'), 'true');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.waitForFunction(() => !document.querySelector('[data-turn-id="t298"]'));
});


test('a selection across many messages keeps every selected row when the reader scrolls', async t => {
  const page = await open(t);
  await page.evaluate(() => window.selectionList());
  await page.locator('[data-select="39"]').waitFor({ state: 'attached' });
  const before = await page.evaluate(() => window.getSelection().toString());
  await page.locator('.chat').evaluate(el => el.scrollTop = el.scrollHeight);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.equal(await page.locator('[data-select]').count(), 40);
  assert.equal(await page.evaluate(() => window.getSelection().toString()), before);
});

test('opening a completed turn fold keeps its heading in place', async t => {
  const page = await open(t);
  const heading = page.locator('[data-row-turn="t299"] .work-head');
  await heading.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const before = await heading.boundingBox();
  await heading.click();
  await page.locator('[data-item-id="tool299"]').waitFor({ state: 'visible' });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const after = await heading.boundingBox();
  assert.ok(Math.abs(after.y - before.y) < 2, `heading moved from ${before.y} to ${after.y}`);
});
