import test from 'node:test';
import assert from 'node:assert/strict';
import { priceBucket, otherRatesFor } from '../packages/usage/src/pricing.js';

const million = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 };

test("Devin's dashed, effort-suffixed names price as the model they are", () => {
  assert.equal(priceBucket('devin', 'gpt-6-1-sol-high', million, '2026-10-06').total, 12.1);
  assert.equal(priceBucket('devin', 'deepseek-v4-1-flash-high', million, '2026-10-06').total, 1.506);
});

test('free OpenCode models cost nothing rather than reading as unknown', () => {
  const c = priceBucket('opencode2', 'muse-spark-1.2-contributor-free', million, '2026-10-06');
  assert.ok(c && c.total === 0);
});

test('a cache write bills at input where the provider has no write rate', () => {
  const c = priceBucket('opencode', 'grok-4.5', { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6 }, '2026-10-06');
  assert.equal(c.cacheWrite, 2);
});

test('models nobody publishes a rate for stay unpriced', () => {
  for (const [engine, id] of [['opencode', 'union-alpha'], ['devin', 'swe-2-medium'], ['devin', 'compactor'], ['codex', 'codex-auto-review']]) {
    assert.equal(priceBucket(engine, id, million, '2026-10-06'), null, id);
  }
  assert.equal(otherRatesFor(''), undefined);
});
