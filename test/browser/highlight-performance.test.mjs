import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('repeated code blocks reuse colors; changed code and languages stay distinct and cache evicts', async t => {
  const bundle = await build({ stdin: { contents: `
    import hljs from 'highlight.js/lib/core';
    import { highlight } from './apps/web/src/highlight';
    const original = hljs.highlight;
    let calls = 0;
    hljs.highlight = (...args) => { calls++; return original(...args); };
    window.exercise = () => {
      const code = 'const answer = 42;';
      const first = highlight(code, 'js');
      for (let n = 0; n < 100; n++) if (highlight(code, 'js') !== first) throw Error('changed colors');
      const repeated = calls;
      const changed = highlight('const answer = 43;', 'js');
      const plain = highlight(code, 'diff');
      const unknown = highlight(code, 'unknown');
      for (let n = 0; n < 70; n++) highlight('const value = ' + n, 'js');
      const beforeEvicted = calls;
      const again = highlight(code, 'js');
      const huge = '// ' + 'x'.repeat(600000);
      highlight(huge, 'js');
      const beforeHuge = calls;
      highlight(huge, 'js');
      return { repeated, changed, first, plain, unknown, evicted: beforeHuge - beforeEvicted - 1,
        hugeRecomputed: calls - beforeHuge, sameAfterEviction: again === first };
    };
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(() => window.exercise());
  assert.equal(result.repeated, 1, '101 renders should tokenize the unchanged code only once');
  assert.notEqual(result.changed, result.first);
  assert.notEqual(result.plain, result.first);
  assert.equal(result.unknown, null);
  assert.equal(result.evicted, 1);
  assert.equal(result.hugeRecomputed, 1, 'oversized highlighted output must not be retained');
  assert.equal(result.sameAfterEviction, true);
});
