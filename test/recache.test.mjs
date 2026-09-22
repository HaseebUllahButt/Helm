import test from 'node:test';
import assert from 'node:assert/strict';

const { cacheRatesFor } = await import('../packages/usage/src/pricing.js');
const { recacheCost, recacheWarning, cachedTokens, WORTH_SAYING } =
  await import('../packages/usage/src/recache.js');

// The composer's model and thinking chips are one tap, and both break the
// provider's prompt-cache prefix: the whole conversation is written to cache
// again on the next turn. The warning exists so that tap is not silent - and
// so it stays quiet on the threads where it would be noise.
//
// This exercises the code the app actually calls, not a copy of it - which is
// why the logic lives in packages/usage rather than beside the component.

/** A session log whose last turn reported this much cached context. */
const threadWith = (cacheRead) => [
  { done: { usage: { cacheRead: 1000 } } },
  { done: { usage: { cacheRead } } },
];
const at = '2026-09-17';

test('a short thread is not worth a dialog', () => {
  // Re-caching 100k tokens is well under a cent or two; a confirmation on
  // every model switch would train people to dismiss it without reading.
  assert.equal(recacheCost(threadWith(100_000), 'claude-opus-5', 'claude', at), null);
  assert.equal(recacheCost([], 'claude-opus-5', 'claude', at), null);
  assert.equal(recacheCost(threadWith(249_999), 'claude-opus-5', 'claude', at), null);
});

test('a long thread reports what re-caching it would cost', () => {
  const r = recacheCost(threadWith(1_300_000), 'claude-opus-5', 'claude', at);
  assert.ok(r);
  assert.equal(r.tokens, 1_300_000);
  // Opus 5 writes cache at $6.25/Mtok, so 1.3M is $8.13 - the kind of number
  // worth seeing before a tap, not after the turn comes back.
  assert.ok(Math.abs(r.costUsd - 8.125) < 1e-9, `expected 8.125, got ${r.costUsd}`);
});

test('the cache-write rate is above the fresh rate, which is why this costs', () => {
  const rates = cacheRatesFor('claude-opus-5', 'claude', '2026-09-17');
  assert.ok(rates.cacheWrite > rates.input,
    'writing the cache is billed above fresh input - that premium is the whole warning');
  assert.ok(rates.cacheRead < rates.input);
});

test('a model with no published rate warns in tokens and claims no dollars', () => {
  const r = recacheCost(threadWith(2_000_000), 'some-unreleased-model', 'claude', at);
  assert.ok(r, 'the size of the cache is still worth saying');
  assert.equal(r.costUsd, null, 'a rate we do not have must not be invented');
});

test('the estimate follows the rate card of the day', () => {
  // Codex re-cut its card on 2026-07-30, so the same thread would have been
  // quoted differently on either side of it.
  const before = cacheRatesFor('gpt-5.6-luna', 'codex', '2026-07-01');
  const after = cacheRatesFor('gpt-5.6-luna', 'codex', '2026-09-17');
  assert.ok(before && after);
  assert.ok(before.input !== after.input || before.cacheWrite !== after.cacheWrite,
    'the pre-cutover card should differ from the current one');
});

test('new GPT-6 Codex models use their published rates', () => {
  assert.deepEqual(cacheRatesFor('gpt-6-luna', 'codex', '2026-09-22'), {
    input: 0.1, cacheRead: 0.01, cacheWrite: 0.1,
  });
  assert.deepEqual(cacheRatesFor('gpt-6-sol', 'codex', '2026-09-22'), {
    input: 2, cacheRead: 0.2, cacheWrite: 2,
  });
});

test('engines that report no per-channel rates decline to quote', () => {
  // OpenCode reports a billed total and Grok only a tick cost, so neither can
  // say what a cache write costs. The warning degrades to a token figure.
  const r = recacheCost(threadWith(5_000_000), 'anything', 'opencode', at);
  assert.ok(r);
  assert.equal(r.costUsd, null);
});

test('the cached size comes from the newest turn that reported one', () => {
  // A turn can end without usage (interrupted, or an error before the model
  // answered); the warning should fall back to the last real figure rather
  // than deciding the conversation has nothing cached.
  assert.equal(cachedTokens(threadWith(900_000)), 900_000);
  assert.equal(cachedTokens([{ done: { usage: { cacheRead: 5000 } } }, { done: {} }]), 5000);
  assert.equal(cachedTokens([]), 0);
  assert.equal(cachedTokens([{ done: undefined }]), 0);
});

test('the warning says what happens before what it costs', () => {
  const r = recacheCost(threadWith(1_300_000), 'claude-opus-5', 'claude', at);
  const model = recacheWarning('model', r);
  const effort = recacheWarning('effort', r);
  assert.match(model, /caches belong to one model/);
  assert.match(effort, /thinking level/);
  for (const text of [model, effort]) {
    assert.match(text, /1\.3M cached tokens/);
    assert.match(text, /\$8\.13/);
    assert.match(text, /Continue\?$/);
  }
  // A model with no rate must not print a dollar figure at all.
  const unpriced = recacheWarning('model', { tokens: 2_000_000, costUsd: null });
  assert.ok(!unpriced.includes('$'), 'no invented price');
  assert.match(unpriced, /no published rate/);
});

test('the threshold is where it says it is', () => {
  assert.equal(WORTH_SAYING, 250_000);
  assert.equal(recacheCost(threadWith(WORTH_SAYING - 1), 'claude-opus-5', 'claude', at), null);
  assert.ok(recacheCost(threadWith(WORTH_SAYING), 'claude-opus-5', 'claude', at));
});
