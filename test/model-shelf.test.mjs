import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/session/modelShelf.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { foldTiers, variantFor } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('devin variant pick keeps the other setting and lands on a real model', () => {
  const ids = ['claude-opus-5-5-medium', 'claude-opus-5-5-low', 'claude-opus-5-5-high', 'claude-opus-5-5-high-fast',
    'claude-opus-5-5-low-fast', 'swe-1-7', 'swe-1-7-medium'];
  const { variants, baseOf } = foldTiers(ids, {});
  // A real model with the bare name keeps its own rows.
  assert.equal(baseOf.has('swe-1-7-medium'), false);
  const list = variants.get('claude-opus-5-5');
  const now = list.find((v) => v.id === 'claude-opus-5-5-high-fast');
  assert.equal(variantFor(list, { effort: 'low' }, now).id, 'claude-opus-5-5-low-fast');
  assert.equal(variantFor(list, { effort: 'medium' }, now).id, 'claude-opus-5-5-medium');
  assert.equal(variantFor(list, { speed: '' }, now).id, 'claude-opus-5-5-high');
  assert.equal(variantFor(list, {}).id, 'claude-opus-5-5-medium');
});
