import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/session/modelShelf.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { shelve, foldTiers, variantFor, levelsOf, prettyName } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('Claude shows the newest of each line; older and dated copies wait behind more', () => {
  const labels = {
    'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-fable-5-1': 'Claude Fable 5.1',
    'claude-opus-4-8': 'Claude Opus 4.8', 'claude-fable-5': 'Claude Fable 5', 'claude-opus-4-5': 'Claude Opus 4.5 (latest)',
    'claude-opus-4-5-20251101': 'Claude Opus 4.5',
  };
  const { main, rest } = shelve(Object.keys(labels), labels, []);
  assert.deepEqual(main, ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-fable-5-1']);
  // The dated copy of Opus 4.5 is the same model: it shows once.
  assert.deepEqual(rest, ['claude-opus-4-8', 'claude-fable-5', 'claude-opus-4-5']);
  // The model in use and the default always show, however old.
  assert.ok(shelve(Object.keys(labels), labels, ['claude-opus-4-8']).main.includes('claude-opus-4-8'));
});

test('an older generation of a brand waits behind more; its newest lines all show', () => {
  const labels = { 'gpt-6.1-sol': 'GPT-6.1-Sol', 'gpt-6-astra': 'GPT-6-Astra', 'gpt-6-luna': 'GPT-6-Luna',
    'gpt-6-sol': 'GPT-6-Sol', 'gpt-5.6-terra': 'GPT-5.6-Terra', 'gpt-5.5': 'GPT-5.5' };
  assert.deepEqual(shelve(Object.keys(labels), labels, []).main, ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']);
});

test('a long list from many providers shows only what is kept, for searching', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `p${i % 3}/model-${String.fromCharCode(97 + i)}`);
  const { main, rest } = shelve(ids, {}, [ids[7]]);
  assert.deepEqual(main, [ids[7]]);
  assert.equal(rest.length, 29);
});

test('devin folds thinking levels and speeds into one row per model', () => {
  const ids = ['claude-opus-5-5-medium', 'claude-opus-5-5-low', 'claude-opus-5-5-high', 'claude-opus-5-5-high-fast',
    'claude-opus-5-5-low-fast', 'swe-1-7', 'swe-1-7-medium', 'adaptive'];
  const labels = { 'claude-opus-5-5-medium': 'Claude Opus 5.5 Medium' };
  const { variants, baseOf, names } = foldTiers(ids, labels);
  assert.equal(baseOf.get('claude-opus-5-5-high-fast'), 'claude-opus-5-5');
  assert.equal(names['claude-opus-5-5'], 'Claude Opus 5.5');
  // A real model with the bare name keeps its own rows.
  assert.equal(baseOf.has('swe-1-7-medium'), false);
  const list = variants.get('claude-opus-5-5');
  assert.deepEqual(levelsOf(list, ''), ['low', 'medium', 'high']);
  assert.deepEqual(levelsOf(list, 'fast'), ['low', 'high']);
  const now = list.find((v) => v.id === 'claude-opus-5-5-high-fast');
  assert.equal(variantFor(list, { effort: 'low' }, now).id, 'claude-opus-5-5-low-fast');
  assert.equal(variantFor(list, { effort: 'medium' }, now).id, 'claude-opus-5-5-medium');
  assert.equal(variantFor(list, { speed: '' }, now).id, 'claude-opus-5-5-high');
  assert.equal(variantFor(list, {}).id, 'claude-opus-5-5-medium');
});

test('devin fusion pairs never show first', () => {
  const labels = { 'fusion-a-sidekick-b': 'Fusion (A + B)', 'swe-2': 'SWE-2' };
  const { main, rest, shelf } = shelve(Object.keys(labels), labels, []);
  assert.deepEqual(main, ['swe-2']);
  assert.deepEqual(rest, ['fusion-a-sidekick-b']);
  assert.equal(shelf('fusion-a-sidekick-b'), 'fusion pairs');
});

test('bare ids and hyphen-joined labels read as names', () => {
  assert.equal(prettyName('claude-haiku-5-5'), 'Claude Haiku 5.5');
  assert.equal(prettyName('gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(prettyName('gpt-6.1-sol', 'GPT-6.1-Sol'), 'GPT-6.1 Sol');
  assert.equal(prettyName('devin/claude-opus-5-5-high'), 'Claude Opus 5.5 High');
  assert.equal(prettyName('claude-opus-5-5', 'Claude Opus 5.5'), 'Claude Opus 5.5');
  // Names with no version are names already.
  assert.equal(prettyName('claude-opus-4-5', 'Claude Opus 4.5 (latest)'), 'Claude Opus 4.5');
  assert.equal(prettyName('sonnet'), 'sonnet');
  assert.equal(prettyName('big-pickle', 'Big Pickle'), 'Big Pickle');
});
