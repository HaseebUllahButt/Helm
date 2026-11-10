import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// "[Image #1]" in the message box is one letter to the caret.
test('the arrow keys and Shift+arrow pass a picture tag in one step', async t => {
  const bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Composer} from './apps/web/src/session/Composer';
    const pic = [{ name: 'a.png', mime: 'image/png', url: 'data:image/png;base64,' }];
    function App(){const [draft,setDraft]=useState('see [Image #1] now');return <Composer draft={draft} setDraft={setDraft} engine="fake" keys={false} attachments={pic} onSend={()=>{}}/>;}
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
  const caret = () => page.evaluate(() => [document.activeElement.selectionStart, document.activeElement.selectionEnd]);
  const settled = async (want) => { try { await page.waitForFunction((w) => document.activeElement.selectionStart === w[0] && document.activeElement.selectionEnd === w[1], want, { timeout: 2000 }); } catch { assert.deepEqual(await caret(), want); } };
  await page.evaluate(() => document.activeElement.setSelectionRange(4, 4));
  await page.keyboard.press('ArrowRight');
  await settled([14, 14]);
  await page.keyboard.press('ArrowLeft');
  await settled([4, 4]);
  await page.keyboard.press('Shift+ArrowRight');
  await settled([4, 14]);
  await page.keyboard.press('ArrowRight');
  await settled([14, 14]);
  await page.keyboard.press('ArrowLeft');
  await settled([4, 4]);
  await page.keyboard.press('ArrowLeft');
  await settled([3, 3]);
  assert.deepEqual(await caret(), [3, 3]);
});
