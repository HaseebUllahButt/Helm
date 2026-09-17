import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { UsageReader, hitRate } = await import('../packages/usage/src/index.js');
const { FileRollupCache, foldLinesFrom, splitKey, bucketKey } =
  await import('../packages/usage/src/scan-cache.js');
const { claudeParser, codexParser } = await import('../packages/usage/src/scanners.js');
const { claudeRatesFor, priceBucket, cacheRatesFor } =
  await import('../packages/usage/src/pricing.js');

// The usage screen is a bill. Every number on it is derived from files helm
// does not own and cannot re-read cheaply, so the things worth pinning down are
// the ones that would be wrong quietly: a resumed scan that double counts, a
// model that loses its name halfway through a file, a rate that moved, an
// account reached twice under two names.

const tmp = () => mkdtempSync(join(tmpdir(), 'helm-usage-'));

/** One Claude assistant turn, as the CLI writes it. */
const claudeTurn = (id, date, model, u, cwd = '/work/repo') => JSON.stringify({
  type: 'assistant', timestamp: `${date}T10:00:00.000Z`, cwd,
  message: { id, role: 'assistant', model, usage: u },
}) + '\n';

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input, output_tokens: output,
  cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
});

// ----------------------------------------------------------- reading files

test('a torn last line is left for the next pass, not lost', async () => {
  // A log being appended to can be stat'ed mid-line. Recording the file size
  // would skip past the remainder and that turn's tokens would never be counted.
  const dir = tmp();
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, 'one\ntwo\nthree-still-being-written');
  const seen = [];
  const first = await foldLinesFrom(f, 0, (l) => seen.push(l));
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(first.consumed, 'one\ntwo\n'.length);

  appendFileSync(f, '\n');
  const more = [];
  const second = await foldLinesFrom(f, first.consumed, (l) => more.push(l));
  assert.deepEqual(more, ['three-still-being-written'], 'the completed line must arrive whole');
  assert.equal(second.consumed, statSync(f).size);
  rmSync(dir, { recursive: true, force: true });
});

test('resuming a grown transcript counts exactly what a cold read would', async () => {
  const dir = tmp();
  const f = join(dir, 'b.jsonl');
  let body = '';
  for (let i = 0; i < 20; i++) body += claudeTurn(`m${i}`, '2026-09-10', 'claude-opus-5', usage(10, 5, 100, 0));
  writeFileSync(f, body);

  const incremental = new FileRollupCache({ id: 'claude', parser: claudeParser });
  const first = await incremental.scan([f]);
  assert.equal(first.parsed, 1);

  let more = '';
  for (let i = 20; i < 35; i++) more += claudeTurn(`m${i}`, '2026-09-10', 'claude-opus-5', usage(10, 5, 100, 0));
  appendFileSync(f, more);
  const second = await incremental.scan([f]);
  assert.equal(second.appended, 1, 'a grown transcript is read from where the last scan stopped');
  assert.ok(second.bytesSkipped > 0, 'the prefix it already read must not be re-read');

  const cold = new FileRollupCache({ id: 'claude', parser: claudeParser });
  await cold.scan([f]);
  assert.deepEqual(
    Object.fromEntries(incremental.fold()), Object.fromEntries(cold.fold()),
    'an incremental fold and a cold fold must agree exactly',
  );
  assert.equal(incremental.fold().get(bucketKey({ date: '2026-09-10', model: 'claude-opus-5', project: '/work/repo' })).turns, 35);
  rmSync(dir, { recursive: true, force: true });
});

test('a Codex rollout keeps its model across an incremental boundary', async () => {
  // A rollout names its model once, in a turn_context near the top. A tail
  // parsed without carrying that forward bills the whole session to the
  // default model - which on this table is a different price.
  const dir = tmp();
  const f = join(dir, 'rollout.jsonl');
  const ctx = JSON.stringify({ type: 'turn_context', timestamp: '2026-09-10T09:00:00.000Z', payload: { model: 'gpt-5.6-sol', cwd: '/srv/app' } }) + '\n';
  const count = (n) => JSON.stringify({
    type: 'event_msg', timestamp: '2026-09-10T09:0' + n + ':00.000Z',
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } } },
  }) + '\n';
  writeFileSync(f, ctx + count(1) + count(2));

  const cache = new FileRollupCache({ id: 'codex', parser: codexParser });
  await cache.scan([f]);
  appendFileSync(f, count(3) + count(4));
  await cache.scan([f]);

  const keys = [...cache.fold().keys()];
  assert.deepEqual(keys, [bucketKey({ date: '2026-09-10', model: 'gpt-5.6-sol', project: '/srv/app' })],
    'the appended turns must not fall back to the default model');
  assert.equal(cache.fold().get(keys[0]).turns, 4);
  rmSync(dir, { recursive: true, force: true });
});

test('a message the CLI wrote twice is counted once', async () => {
  const dir = tmp();
  const f = join(dir, 'dup.jsonl');
  const turn = claudeTurn('same-id', '2026-09-10', 'claude-opus-5', usage(100, 10, 0, 0));
  writeFileSync(f, turn + turn + claudeTurn('other', '2026-09-10', 'claude-opus-5', usage(100, 10, 0, 0)));
  const cache = new FileRollupCache({ id: 'claude', parser: claudeParser });
  await cache.scan([f]);
  const b = [...cache.fold().values()][0];
  assert.equal(b.turns, 2, 'the repeated message id must not be counted a second time');
  assert.equal(b.input, 200);
  rmSync(dir, { recursive: true, force: true });
});

test('a synthetic turn carries no cost and is skipped', async () => {
  const dir = tmp();
  const f = join(dir, 's.jsonl');
  writeFileSync(f, claudeTurn('x', '2026-09-10', '<synthetic>', usage(0, 0, 0, 0)));
  const cache = new FileRollupCache({ id: 'claude', parser: claudeParser });
  await cache.scan([f]);
  assert.equal(cache.fold().size, 0);
  rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------- pricing

test('a rate that moved is applied by the day the tokens were spent', () => {
  // Sonnet 5 had introductory pricing until 2026-09-01. Pricing the whole
  // history at today's card would quietly overstate everything before that.
  const intro = claudeRatesFor('claude-sonnet-5', '2026-08-15');
  const after = claudeRatesFor('claude-sonnet-5', '2026-09-15');
  assert.equal(intro.input, 2);
  assert.equal(after.input, 3);

  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(priceBucket('claude', 'claude-sonnet-5', tokens, '2026-08-15').total, 2);
  assert.equal(priceBucket('claude', 'claude-sonnet-5', tokens, '2026-09-15').total, 3);
});

test('a dated model id resolves to its rate', () => {
  assert.ok(claudeRatesFor('claude-haiku-4-5-20251001', '2026-09-15'), 'the date suffix must be stripped');
});

test('the cache rate lookup honours the day it is asked about', () => {
  // priceBucket honoured Codex's 2026-07-30 re-cut and cacheRatesFor did not,
  // so cache savings on tokens spent before it were understated fivefold.
  const before = cacheRatesFor('gpt-5.6-luna', 'codex', '2026-07-01');
  const after = cacheRatesFor('gpt-5.6-luna', 'codex', '2026-09-17');
  assert.equal(before.input, 1);
  assert.equal(after.input, 0.2);
});

test('a model with no published rate is unpriced, never zero', () => {
  assert.equal(priceBucket('claude', 'some-unreleased-model', { input: 1e6 }, '2026-09-15'), null);
  assert.equal(cacheRatesFor('some-unreleased-model', 'claude', '2026-09-15'), null);
  // OpenCode reports a billed total rather than per-channel rates, so it
  // contributes tokens and declines to claim a saving.
  assert.equal(cacheRatesFor('anything', 'opencode', '2026-09-15'), null);
});

test('cached input is billed at the cached rate, not the fresh one', () => {
  const rates = cacheRatesFor('claude-opus-5', 'claude', '2026-09-15');
  assert.ok(rates.cacheRead < rates.input, 'a cached token must cost less than a fresh one');
  const fresh = priceBucket('claude', 'claude-opus-5', { input: 1e6 }, '2026-09-15').total;
  const cached = priceBucket('claude', 'claude-opus-5', { cacheRead: 1e6 }, '2026-09-15').total;
  assert.ok(cached < fresh);
  assert.equal(cached, rates.cacheRead);
});

// ------------------------------------------------------------ the report

/** A machine with one Claude account and one Codex account. */
function machine() {
  const dir = tmp();
  const claudeHome = join(dir, 'claude');
  const proj = join(claudeHome, 'projects', '-work-repo');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 's.jsonl'),
    claudeTurn('a', '2026-09-10', 'claude-opus-5', usage(1000, 100, 9000, 500), '/work/repo')
    + claudeTurn('b', '2026-09-11', 'claude-opus-5', usage(1000, 100, 9000, 0), '/work/other'));

  const codexHome = join(dir, 'codex');
  mkdirSync(join(codexHome, 'sessions'), { recursive: true });
  writeFileSync(join(codexHome, 'sessions', 'r.jsonl'),
    JSON.stringify({ type: 'turn_context', timestamp: '2026-09-11T09:00:00Z', payload: { model: 'gpt-5.6-sol', cwd: '/srv' } }) + '\n'
    + JSON.stringify({ type: 'event_msg', timestamp: '2026-09-11T09:01:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 200 } } } }) + '\n');

  return {
    dir,
    profiles: [
      { id: 'claudea', engine: 'claude', env: { CLAUDE_CONFIG_DIR: claudeHome } },
      { id: 'codex', engine: 'codex', env: { CODEX_HOME: codexHome } },
    ],
  };
}

test('the report adds up, and says where it went', async () => {
  const m = machine();
  const reader = new UsageReader();
  const r = await reader.report(m.profiles, { by: ['engine', 'model', 'project'] });

  assert.equal(r.accounts.length, 2);
  assert.equal(r.daily.length, 2, 'two days of work');
  assert.ok(r.totals.costUsd > 0);
  assert.equal(r.totals.turns, 3);
  assert.equal(r.totals.cacheRead, 9000 + 9000 + 1500);

  const folders = r.groups.filter((g) => g.project).map((g) => g.project).sort();
  assert.deepEqual(folders, ['/srv', '/work/other', '/work/repo'],
    'the folder the work happened in survives into the breakdown');

  // The totals must equal the sum of the days, or the screen contradicts itself.
  const summed = r.daily.reduce((n, d) => n + d.costUsd, 0);
  assert.ok(Math.abs(summed - r.totals.costUsd) < 1e-9);
  rmSync(m.dir, { recursive: true, force: true });
});

test('a window narrows every figure together', async () => {
  const m = machine();
  const reader = new UsageReader();
  const all = await reader.report(m.profiles, {});
  const day2 = await reader.report(m.profiles, { since: '2026-09-11' });

  assert.equal(day2.daily.length, 1);
  assert.ok(day2.totals.costUsd < all.totals.costUsd);
  assert.equal(day2.totals.turns, 2, 'only the turns inside the window');
  // The breakdown is windowed at the source, so it cannot disagree with the
  // headline above it.
  const inWindow = day2.groups.reduce((n, g) => n + g.costUsd, 0);
  assert.ok(Math.abs(inWindow - day2.totals.costUsd) < 1e-9,
    'the breakdown must describe the same span as the total');
  rmSync(m.dir, { recursive: true, force: true });
});

test('two aliases onto one account are counted once', async () => {
  const m = machine();
  const reader = new UsageReader();
  const once = await reader.report(m.profiles, {});
  const twice = await reader.report([
    ...m.profiles,
    // Same home, different alias - a real shape, since helm reads profiles
    // out of shell aliases and several can point at one login.
    { id: 'claudeb', engine: 'claude', env: { CLAUDE_CONFIG_DIR: m.profiles[0].env.CLAUDE_CONFIG_DIR } },
  ], {});
  assert.equal(twice.totals.costUsd, once.totals.costUsd, 'an alias must not double the bill');
  assert.equal(twice.totals.total, once.totals.total);
  assert.equal(twice.accounts.length, 2);
  rmSync(m.dir, { recursive: true, force: true });
});

test('a second report reads no bytes and still agrees', async () => {
  const m = machine();
  const reader = new UsageReader();
  const first = await reader.report(m.profiles, {});
  const second = await reader.report(m.profiles, {});
  assert.equal(second.scan.bytesRead, 0, 'nothing changed, so nothing should be read');
  assert.ok(second.scan.hits + second.scan.sealed > 0);
  assert.equal(second.totals.costUsd, first.totals.costUsd);
  rmSync(m.dir, { recursive: true, force: true });
});

test('the index survives a restart', async () => {
  const m = machine();
  const indexPath = join(m.dir, 'usage-index.json');
  const before = new UsageReader({ indexPath });
  const first = await before.report(m.profiles, {});
  await before.persist();

  // A fresh reader is what a restarted daemon has.
  const after = new UsageReader({ indexPath });
  const second = await after.report(m.profiles, {});
  assert.equal(second.totals.costUsd, first.totals.costUsd);
  assert.equal(second.scan.parsed, 0, 'a restored index must not re-parse the transcripts');
  rmSync(m.dir, { recursive: true, force: true });
});

test('an unreadable account does not lose the others', async () => {
  const m = machine();
  const reader = new UsageReader();
  const withGhost = await reader.report([
    ...m.profiles,
    { id: 'gone', engine: 'claude', env: { CLAUDE_CONFIG_DIR: '/nonexistent/path/nowhere' } },
  ], {});
  assert.ok(withGhost.totals.costUsd > 0, 'the machines that answered still report');
  rmSync(m.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------- reading them

test('the hit rate is the share of input that came from cache', () => {
  assert.equal(hitRate({ input: 0, cacheRead: 0 }), 0, 'no traffic is not a full cache');
  assert.equal(hitRate({ input: 100, cacheRead: 900 }), 0.9);
  assert.equal(hitRate({ input: 0, cacheRead: 500 }), 1);
});

test('a bucket key round-trips, including a folder with no value', () => {
  const k = bucketKey({ date: '2026-09-10', model: 'claude-opus-5', project: '/a/b' });
  assert.deepEqual(splitKey(k), { date: '2026-09-10', model: 'claude-opus-5', project: '/a/b' });
  assert.deepEqual(splitKey(bucketKey({ date: '2026-09-10', model: 'm' })),
    { date: '2026-09-10', model: 'm', project: '' });
});
