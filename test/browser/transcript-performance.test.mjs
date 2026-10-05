import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, page;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { Transcript } from './apps/web/src/session/Transcript';
    import { apply, emptyLog } from './apps/web/src/session/types';
    const log = emptyLog();
    let seq = 0, reads = 0, update;
    const emit = (event) => apply(log, { seq: ++seq, at: Date.now(), ...event });
    for (let n = 0; n < 120; n++) {
      emit({ type: 'turn.start', turnId: 't' + n, text: 'Question ' + n });
      for (let k = 0; k < 6; k++) {
        emit({ type: 'item.start', turnId: 't' + n, id: n + '-' + k, kind: 'tool', name: 'Read', input: { path: '/repo/app.ts' } });
        emit({ type: 'item.done', id: n + '-' + k, status: 'ok' });
        Object.defineProperty(log.turns[n].items[k], 'name', { get: () => { reads++; return 'Read'; } });
      }
      emit({ type: 'turn.done', turnId: 't' + n, status: 'ok' });
    }
    emit({ type: 'turn.start', turnId: 'live', text: 'Now continue' });
    emit({ type: 'item.start', turnId: 'live', id: 'answer', kind: 'text' });
    function App() {
      const [, bump] = useState(0);
      update = () => bump(n => n + 1);
      return <Transcript turns={log.turns} status="working" loaded onBranch={() => {}} />;
    }
    const root = createRoot(document.getElementById('root'));
    flushSync(() => root.render(<App />));
    window.refresh = (delta) => {
      reads = 0;
      const start = performance.now();
      if (delta) emit({ type: 'item.delta', id: 'answer', text: delta });
      flushSync(update);
      return { reads, ms: performance.now() - start };
    };
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent('<div class="main showing" style="height:100vh;display:flex;flex-direction:column"><div id="root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});
after(async () => { await browser?.close(); });

test('parent refreshes do not rebuild completed turns in a long chat', async () => {
  const result = await page.evaluate(() => window.refresh());
  console.log('long-chat parent refresh', result);
  assert.equal(result.reads, 0, 'completed tool summaries should be reused');
});

test('streamed text stays live without rebuilding history or pulling a reader to the bottom', async () => {
  await page.locator('.chat').evaluate((el) => { el.scrollTop = 200; el.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const before = await page.locator('.chat').evaluate(el => el.scrollTop);
  const result = await page.evaluate(() => window.refresh('New streamed answer'));
  console.log('long-chat streamed update', result);
  await page.getByText('New streamed answer', { exact: true }).waitFor();
  assert.equal(result.reads, 0, 'only the changed turn should render');
  assert.ok(Math.abs(await page.locator('.chat').evaluate(el => el.scrollTop) - before) < 2);
});
