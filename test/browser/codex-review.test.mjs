import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

test('Codex review mode, quiet results and denial answers reuse the existing controls', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Controls } from './apps/web/src/session/Controls';
    import { Transcript } from './apps/web/src/session/Transcript';
    import { PermissionSheet } from './apps/web/src/session/PermissionSheet';
    import { MODES } from './packages/connect/src/modes';
    function App() {
      const [engine, setEngine] = useState('codex');
      const [mode, setMode] = useState('ask');
      window.setEngine = setEngine;
      const controls = Controls({ session: { engine, mode }, options: { models: [], modes: MODES[engine], defaultMode: engine === 'codex' ? 'full' : 'auto' },
        onPick: (_, value) => { window.picked = value; setMode(value); } });
      const items = ['approved','denied'].map((reviewStatus, i) => ({ id: 'review-'+i, kind: 'tool', name: 'codexReview', status: reviewStatus === 'approved' ? 'ok' : 'error',
        input: { action: i ? 'Remove files' : 'Read app.ts', reviewStatus }, output: i ? 'This step can remove files.' : 'This step only reads files.', text: '', startedAt: 1, doneAt: 2 }));
      items.push({id:'answer',kind:'text',status:'ok',text:'The checks finished.',startedAt:1,doneAt:2});
      return <>{controls.chips}{controls.sheet}
        <Transcript loaded status="idle" turns={[{id:'t',text:'Check the project',at:1,items,done:{status:'ok'}}]} onBranch={()=>{}} />
        <PermissionSheet variant="banner" busy={false} permission={{requestId:'review-1',kind:'tool',title:'Codex denied this step',detail:'Remove files',reason:'This step can remove files.',defaultTo:'deny',
          options:[{id:'deny',role:'deny',label:'Keep denied'},{id:'allow',role:'allow',label:'Allow anyway'}]}} onAnswer={value=>window.answer=value} />
      </>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  try {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.setContent('<div class="session"><div id="root"></div></div>');
        await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.locator('button[title^="permissions:"]').click();
        await page.getByRole('option', { name: /Codex reviews/ }).click();
        assert.equal(await page.evaluate(() => window.picked), 'auto-review');
        await page.locator('.work-head').click();
        await page.getByRole('button', { name: 'Codex approved: Read app.ts', exact: true }).click();
        assert.equal(await page.getByText('This step only reads files.', { exact: true }).count(), 1);
        await page.getByRole('button', { name: 'Allow anyway', exact: true }).click();
        assert.equal(await page.evaluate(() => window.answer.option), 'allow');
        await page.getByRole('button', { name: 'Keep denied', exact: true }).click();
        assert.equal(await page.evaluate(() => window.answer.option), 'deny');
        await page.evaluate(() => window.setEngine('claude'));
        await page.locator('button[title^="permissions:"]').click();
        assert.equal(await page.getByRole('option', { name: /Codex reviews/ }).count(), 0);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});
