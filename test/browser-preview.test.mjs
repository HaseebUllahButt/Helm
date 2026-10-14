import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../apps/web/src/session/browserPreview.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { previewForLink, previewWait, previewDelay, previewLease } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test('Auto picks the smooth tier only for a quick, measured link on a wide screen', () => {
  assert.equal(previewForLink(0, false), 'full', 'unmeasured starts at full');
  assert.equal(previewForLink(8, false), 'smooth');
  assert.equal(previewForLink(8, false, { effectiveType: '4g' }), 'smooth');
  assert.equal(previewForLink(8, true), 'balanced', 'a phone screen keeps the lighter tier');
  assert.equal(previewForLink(120, false), 'full');
  assert.equal(previewForLink(400, false), 'balanced');
  assert.equal(previewForLink(1200, false), 'low');
  assert.equal(previewForLink(8, false, { saveData: true }), 'low', 'data saver always wins');
});

test('a held request needs no pause, an unheld one is paced, and text never holds', () => {
  assert.ok(previewWait('smooth') > 0 && previewWait('low') > 0); assert.equal(previewWait('text'), 0);
  assert.equal(previewDelay('smooth', 5, true), 0);
  assert.ok(previewDelay('low', 5) >= 1000 && previewDelay('smooth', 5) < previewDelay('full', 5));
  assert.ok(previewLease(100) >= 15000);
});
