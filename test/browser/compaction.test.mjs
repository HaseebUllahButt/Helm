import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// Whatever CLI is compacting, the chat says so the same way: a line across
// the conversation while it runs, and a bar over the composer that counts.
let browser, page;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Transcript } from './apps/web/src/session/Transcript';
    import { Composer } from './apps/web/src/session/Composer';
    const root = createRoot(document.getElementById('root'));
    const t0 = Date.now() - 12_000;
    window.render = (live) => root.render(<>
      <Transcript status={live ? 'working' : 'idle'} loaded turns={[
        { id: 't1', text: '/compact', at: t0, items: [
          { id: 'c1', kind: 'tool', name: 'compact', text: '', startedAt: t0, status: live ? 'streaming' : 'ok', doneAt: live ? undefined : t0 + 9000 },
        ], ...(live ? {} : { done: { status: 'ok' } }) },
      ]} />
      <Composer draft="" setDraft={() => {}} onSend={() => {}} working={live} compacting={live ? t0 : undefined} />
    </>);
    window.renderMid = () => root.render(<Transcript status="working" loaded turns={[
      { id: 't2', text: 'fix it', at: t0, items: [
        { id: 's1', kind: 'command', command: 'npm run check', text: '', status: 'ok', exitCode: 0, startedAt: t0 },
        { id: 'c2', kind: 'tool', name: 'compact', text: '', status: 'ok', startedAt: t0 + 1000, doneAt: t0 + 4000 },
        { id: 's2', kind: 'command', command: 'npm test', text: '', status: 'streaming', startedAt: t0 + 5000 },
      ] },
    ]} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('http://helm.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('http://helm.test/');
  await page.setContent('<div class="main showing" style="height:100vh;width:100%;display:flex;flex-direction:column"><div id="root" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});
after(async () => { await browser?.close(); });

test('while compacting, the conversation and a counting bar over the composer say so', async () => {
  await page.evaluate(() => window.render(true));
  const bar = page.locator('.docked.compacting');
  await bar.waitFor();
  assert.match(await bar.innerText(), /Compacting conversation…\s*0:1\d/);
  assert.equal(await page.locator('.compaction.live').count(), 1);
  assert.equal(await page.locator('.working').count(), 0, 'the compaction line replaces the generic pulse');
  if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, 'compacting.png') });
});

test('once it is done the bar goes and the line says it compacted', async () => {
  await page.evaluate(() => window.render(false));
  await page.locator('.compaction:not(.live)').waitFor();
  assert.equal(await page.locator('.docked.compacting').count(), 0);
  assert.match(await page.locator('.compaction').innerText(), /Conversation compacted · 9s/);
});

test('steps after a compaction land below its line, the way a chat grows', async () => {
  await page.evaluate(() => window.renderMid());
  const line = await page.locator('.compaction').boundingBox();
  const live = await page.locator('.work.live').boundingBox();
  assert.ok(live.y > line.y, 'the running step sits below the line');
  assert.equal(await page.locator('.work').count(), 2, 'one block before the line, one after');
});
