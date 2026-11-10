import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A new chat swaps its "starting" box for the live chat's box while the
// owner types. The caret must stay where it was, so the next keys land in
// order and not at the start of the text.
test('the live chat box keeps the caret of the starting box it replaces', async t => {
  const bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Composer} from './apps/web/src/session/Composer';
    function Box({name}){const [draft,setDraft]=useState(window.text);return <Composer key={name} draft={draft} setDraft={(v)=>{window.text=v;setDraft(v);}} engine="fake" keys={false} canAttach={false} onSend={()=>{}}/>;}
    function App(){const [name,setName]=useState('starting');window.swap=()=>setName('live');return <Box key={name} name={name}/>;}
    window.text='';
    createRoot(document.getElementById('root')).render(<App/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(6000);
  await page.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div class="session" id="root"></div>' }));
  await page.goto('http://helm.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const box = page.locator('textarea[data-composer]');
  await box.waitFor();
  await box.click();
  await page.keyboard.type('hello world');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.evaluate(() => window.swap());
  await page.waitForFunction(() => document.activeElement?.matches('textarea[data-composer]'));
  assert.deepEqual(await page.evaluate(() => { const el = document.activeElement; return [el.selectionStart, el.selectionEnd]; }), [9, 9]);
  await page.keyboard.type('XY');
  assert.equal(await box.inputValue(), 'hello worXYld');
});

test('a box that opens with words puts the caret at their end', async t => {
  const bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Composer} from './apps/web/src/session/Composer';
    function App(){const [draft,setDraft]=useState('saved words');return <Composer draft={draft} setDraft={setDraft} engine="fake" keys={false} canAttach={false} onSend={()=>{}}/>;}
    createRoot(document.getElementById('root')).render(<App/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(6000);
  await page.route('http://helm.test/**', r => r.fulfill({ contentType: 'text/html', body: '<div class="session" id="root"></div>' }));
  await page.goto('http://helm.test/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => document.activeElement?.matches('textarea[data-composer]'));
  await page.keyboard.type('!');
  assert.equal(await page.locator('textarea[data-composer]').inputValue(), 'saved words!');
});
