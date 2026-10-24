import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'helm-usage-xdg-'));
const { UsageReader, ESTIMATED_FOLDER } = await import('../packages/usage/src/index.js');
const bundle = await build({ entryPoints: ['apps/web/src/usageCache.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { mergeReports } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

// Claude Code deletes transcripts after 30 days but keeps daily totals in
// stats-cache.json. Those totals count each transcript line, so they run
// about twice the real figure; days with both give the scale.

const tmp = () => mkdtempSync(join(tmpdir(), 'helm-usage-est-'));
const MODEL = 'claude-opus-5-5';

/** One deduplicated turn worth `tokens`, mostly cache reads like real work. */
const turn = (id, day, tokens) => JSON.stringify({
  type: 'assistant', timestamp: `${day}T10:00:00.000Z`, cwd: '/work',
  message: { id, role: 'assistant', model: MODEL, usage: { input_tokens: 0, output_tokens: tokens / 10, cache_read_input_tokens: tokens * 9 / 10, cache_creation_input_tokens: 0 } },
}) + '\n';

/**
 * A Claude home: transcripts for `kept` days, and Claude's daily totals at
 * twice the real figure for every day in `stats`.
 */
function home(dir, { kept, stats }) {
  const proj = join(dir, 'projects', '-work');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 's.jsonl'), kept.map(([day, t], i) => turn(`m${i}`, day, t)).join(''));
  writeFileSync(join(dir, 'stats-cache.json'), JSON.stringify({
    version: 5, lastComputedDate: stats.at(-1)[0],
    dailyModelTokens: stats.map(([date, t]) => ({ date, tokensByModel: { [MODEL]: t * 2 } })),
    modelUsage: { [MODEL]: { inputTokens: 0, outputTokens: 1, cacheReadInputTokens: 9, cacheCreationInputTokens: 0 } },
  }));
  return { id: dir, engine: 'claude', env: { CLAUDE_CONFIG_DIR: dir } };
}

const DAYS = [['2026-08-01', 1e6], ['2026-08-02', 2e6], ['2026-09-20', 4e6], ['2026-09-21', 8e6], ['2026-09-22', 1e6]];

test('a day with deleted transcripts is filled from Claude daily totals at the measured scale', async () => {
  const dir = tmp();
  const profile = home(join(dir, 'claude'), { kept: DAYS.slice(2), stats: DAYS });
  const r = await new UsageReader().report([profile], { by: ['engine', 'model', 'project'] });

  const est = r.groups.filter((g) => g.project === ESTIMATED_FOLDER);
  assert.equal(est.length, 1);
  assert.equal(est[0].total, 3e6, 'the two deleted days, at half of Claude\'s doubled total');
  assert.equal(r.totals.total, DAYS.reduce((n, [, t]) => n + t, 0), 'days with transcripts are not filled again');
  assert.ok(est[0].costUsd > 0);
  assert.equal(r.estimates.length, 2, 'one fingerprint per filled day');
  rmSync(dir, { recursive: true, force: true });
});

test('a Claude folder copied from another machine adds no estimate', async () => {
  // The copy holds the other machine's history and no day this machine ran.
  const dir = tmp();
  const profile = home(join(dir, 'claude'), { kept: [['2026-10-02', 5e6]], stats: DAYS });
  const r = await new UsageReader().report([profile], {});
  assert.equal(r.totals.total, 5e6);
  assert.equal(r.estimates, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('one estimated day counts once, on one machine and across machines', async () => {
  const dir = tmp();
  const a = home(join(dir, 'a'), { kept: DAYS.slice(2), stats: DAYS });
  cpSync(join(dir, 'a'), join(dir, 'b'), { recursive: true });
  const b = { ...a, id: 'b', env: { CLAUDE_CONFIG_DIR: join(dir, 'b') } };
  const by = ['engine', 'account', 'model', 'provider', 'project'];

  const one = await new UsageReader().report([a], { by });
  const both = await new UsageReader().report([a, b], { by });
  assert.equal(both.totals.total, one.totals.total * 2 - 3e6, 'two homes with one copied file estimate once');

  const merged = mergeReports([{ env: 'laptop', report: one }, { env: 'pc', report: one }]);
  assert.equal(merged.totals.total, one.totals.total * 2 - 3e6, 'two machines with one copied file estimate once');
  assert.ok(Math.abs(merged.totals.costUsd - (one.totals.costUsd * 2 - one.estimates.reduce((n, e) => n + e.costUsd, 0))) < 1e-9);
  const estGroup = merged.groups.find((g) => g.project === ESTIMATED_FOLDER);
  assert.equal(estGroup.total, 3e6);
  assert.equal(merged.daily.find((d) => d.date === '2026-08-02').total, 2e6);
  rmSync(dir, { recursive: true, force: true });
});

test('Claude daily totals survive Claude rewriting its file with fewer days', async () => {
  const dir = tmp();
  const indexPath = join(dir, 'usage-index.json');
  const profile = home(join(dir, 'claude'), { kept: DAYS.slice(2), stats: DAYS });
  const reader = new UsageReader({ indexPath });
  const before = await reader.report([profile], {});
  await reader.persist();

  writeFileSync(join(dir, 'claude', 'stats-cache.json'), JSON.stringify({ version: 5, dailyModelTokens: [], modelUsage: {} }));
  const after = await new UsageReader({ indexPath }).report([profile], {});
  assert.equal(after.totals.total, before.totals.total);
  rmSync(dir, { recursive: true, force: true });
});
