import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('Claude picker selects Opus 5.5 immediately and receives later catalog additions', async () => {
  const bundle = await build({
    stdin: { contents: `
      import React, { useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Controls } from './apps/web/src/session/Controls';
      import { followModelRefresh } from './apps/web/src/modelRefresh';
      let release;
      const published = new Promise(resolve => { release = resolve; });
      window.completeCatalog = () => release({
        models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
        labels: { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5' },
        refreshing: false,
      });
      function Picker() {
        const [options, setOptions] = useState(null);
        const [model, setModel] = useState('claude-opus-5');
        useEffect(() => {
          let calls = 0;
          const catalog = followModelRefresh(async () => ++calls === 1 ? {
            models: ['claude-opus-5-5'], labels: { 'claude-opus-5-5': 'Claude Opus 5.5' }, refreshing: true,
          } : published, setOptions, error => { throw error; }, 5);
          return catalog.stop;
        }, []);
        const controls = Controls({ options, session: { engine: 'claude', model },
          onPick: (kind, id) => { window.picked = id; setModel(id); } });
        return <>{controls.chips}{controls.sheet}</>;
      }
      createRoot(document.getElementById('root')).render(<Picker />);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
  });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator('button[title^="model:"]').click();
    await page.getByRole('option', { name: 'Claude Opus 5.5', exact: true }).click();
    assert.equal(await page.evaluate(() => window.picked), 'claude-opus-5-5');
    await page.evaluate(() => window.completeCatalog());
    await page.locator('button[title^="model:"]').click();
    await page.getByRole('option', { name: 'Claude Sonnet 5.5', exact: true }).click();
    assert.equal(await page.evaluate(() => window.picked), 'claude-sonnet-5-5');
  } finally { await browser.close(); }
});
