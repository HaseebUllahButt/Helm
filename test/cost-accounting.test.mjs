import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Scratch data dir, so database ledgers on the machine running this stay out.
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'helm-cost-xdg-'));

const { UsageReader } = await import('../packages/usage/src/index.js');
const { FileRollupCache } = await import('../packages/usage/src/scan-cache.js');
const { claudeParser, codexParser } = await import('../packages/usage/src/scanners.js');
const { priceBucket } = await import('../packages/usage/src/pricing.js');

// Each of these was a way the usage screen was wrong without looking wrong.

const tmp = () => mkdtempSync(join(tmpdir(), 'helm-cost-'));
const line = (id, u, model = 'claude-opus-5') => JSON.stringify({
  type: 'assistant', timestamp: '2026-09-20T10:00:00.000Z', cwd: '/w',
  message: { id, role: 'assistant', model, usage: u },
}) + '\n';
const sum = (cache) => [...cache.fold().values()].reduce((a, b) => {
  for (const k of Object.keys(b)) a[k] = (a[k] ?? 0) + b[k];
  return a;
}, {});

test('a Claude message written over several lines counts its final size once', async () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  const u = (output) => ({ input_tokens: 10, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 });
  writeFileSync(f, line('m1', u(8)) + line('m1', u(420)) + line('m2', u(5)));
  const cache = new FileRollupCache({ id: 'claude', parser: claudeParser });
  await cache.scan([f]);
  const t = sum(cache);
  assert.equal(t.output, 425, 'the grown output, not the first line\'s');
  assert.equal(t.input, 20, 'input once per message, not once per line');
  assert.equal(t.cacheRead, 2000);
  assert.equal(t.turns, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('a repeated Codex token_count is not a second turn', async () => {
  const dir = tmp();
  const f = join(dir, 'rollout.jsonl');
  const tc = (total, last) => JSON.stringify({
    timestamp: '2026-09-20T10:00:00Z', type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last } },
  }) + '\n';
  const last = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 };
  writeFileSync(f, tc(110, last) + tc(110, last) + tc(220, last));
  const cache = new FileRollupCache({ id: 'codex', parser: codexParser });
  await cache.scan([f]);
  assert.equal(sum(cache).turns, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('1-hour cache writes are priced at 2x input, and Opus 5.5 has a price', () => {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6, cacheWrite1h: 1e6 };
  assert.equal(priceBucket('claude', 'claude-opus-5', tokens, '2026-09-20').total, 10);
  const fiveMin = { ...tokens, cacheWrite1h: 0 };
  assert.equal(priceBucket('claude', 'claude-opus-5', fiveMin, '2026-09-20').total, 6.25);
  const opus55 = priceBucket('claude', 'claude-opus-5-5', { input: 1e6, output: 1e6, cacheRead: 1e6 }, '2026-09-20');
  assert.ok(opus55, 'claude-opus-5-5 must not be unpriced');
  assert.ok(Math.abs(opus55.total - 24.2) < 1e-9);
  // Claude through another CLI is still Claude.
  assert.ok(priceBucket('devin', 'claude-opus-5', { input: 1e6 }, '2026-09-20'));
});

test('an old transcript that is resumed is counted again', async () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  const u = { input_tokens: 10, output_tokens: 10 };
  writeFileSync(f, line('m1', u));
  const old = (Date.now() - 30 * 86400e3) / 1000;
  utimesSync(f, old, old);
  const cache = new FileRollupCache({ id: 'claude', parser: claudeParser });
  await cache.scan([f]);
  await cache.scan([f]); // seals it
  appendFileSync(f, line('m2', u));
  await cache.scan([f]);
  assert.equal(sum(cache).turns, 2, 'the resumed turn must be read');
  rmSync(dir, { recursive: true, force: true });
});

test('two reports at once do not count the same bytes twice', async () => {
  // Codex has no per-message id to hide a double read behind, which is where
  // two overlapping scans folding the same tail showed up.
  const dir = tmp();
  const home = join(dir, 'codex');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const f = join(home, 'sessions', 'rollout.jsonl');
  const tc = (n) => JSON.stringify({
    timestamp: '2026-09-20T10:00:00Z', type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: n * 110 }, last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
  }) + '\n';
  writeFileSync(f, tc(1));
  const profiles = [{ id: 'x', engine: 'codex', env: { CODEX_HOME: home } }];
  const reader = new UsageReader();
  await reader.report(profiles);
  for (let i = 2; i <= 400; i++) appendFileSync(f, tc(i));
  const all = await Promise.all([1, 2, 3, 4].map(() => reader.report(profiles)));
  for (const r of all) assert.equal(r.totals.turns, 400);
  rmSync(dir, { recursive: true, force: true });
});
