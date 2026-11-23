import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

// Database engines read their ledgers from the data dir whether or not a
// profile names them - so point it at scratch space, or the machine this
// suite happens to run on would leak its own history into every total.
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'helm-usage-xdg-'));

const { UsageReader, foldBuckets } = await import('../packages/usage/src/index.js');
const { FileRollupCache, foldLinesFrom, bucketKey } =
  await import('../packages/usage/src/scan-cache.js');
const { claudeParser, codexParser } = await import('../packages/usage/src/scanners.js');
const { claudeRatesFor, priceBucket } =
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
  assert.equal(incremental.fold().get(bucketKey({ date: '2026-09-10T10', model: 'claude-opus-5', project: '/work/repo' })).turns, 35);
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
  assert.deepEqual(keys, [bucketKey({ date: '2026-09-10T09', model: 'gpt-5.6-sol', project: '/srv/app' })],
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

test('the index survives a restart', async () => {
  const m = machine();
  const indexPath = join(m.dir, 'usage-index.json');
  // report starts a background save. Track those exact promises so cleanup
  // cannot delete the directory while either reader is creating a temp file.
  const saves = [];
  const trackSaves = (reader) => {
    const persist = reader.persist.bind(reader);
    reader.persist = () => { const save = persist(); saves.push(save); return save; };
    return reader;
  };
  const before = trackSaves(new UsageReader({ indexPath }));
  const first = await before.report(m.profiles, {});
  await before.persist();

  // A fresh reader is what a restarted daemon has.
  const after = trackSaves(new UsageReader({ indexPath }));
  const second = await after.report(m.profiles, {});
  assert.equal(second.totals.costUsd, first.totals.costUsd);
  assert.equal(second.scan.parsed, 0, 'a restored index must not re-parse the transcripts');
  await Promise.all(saves);
  rmSync(m.dir, { recursive: true, force: true });
});

test('a transcript the CLI deleted keeps its counts, and a restored one counts once', async () => {
  // Claude Code deletes transcripts after 30 days. Forgetting their counts
  // made "All" only ever show the last month.
  const m = machine();
  const indexPath = join(m.dir, 'usage-index.json');
  const reader = new UsageReader({ indexPath });
  const before = await reader.report(m.profiles, {});
  const file = join(m.profiles[0].env.CLAUDE_CONFIG_DIR, 'projects', '-work-repo', 's.jsonl');
  const kept = readFileSync(file);
  rmSync(file);

  const after = await reader.report(m.profiles, {});
  assert.equal(after.totals.turns, before.totals.turns, 'a deleted transcript is still usage');
  assert.equal(after.totals.costUsd, before.totals.costUsd);
  await reader.persist();
  const restarted = await new UsageReader({ indexPath }).report(m.profiles, {});
  assert.equal(restarted.totals.turns, before.totals.turns, 'the deleted counts survive a restart');

  writeFileSync(file, kept);
  const back = await reader.report(m.profiles, {});
  assert.equal(back.totals.turns, before.totals.turns, 'a restored transcript must not count twice');
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

test('a database ledger counts even with no profile naming it', async () => {
  // An engine whose CLI was uninstalled still spent tokens. Its ledger lives
  // at a fixed place in the data dir, so the evidence is the file, not a
  // surviving profile - this is also how an opencode2 store with no alias
  // still ends up inside the total.
  const dir = join(process.env.XDG_DATA_HOME, 'devin-test', 'cli');
  mkdirSync(dir, { recursive: true });
  const conn = new DatabaseSync(join(dir, 'sessions.db'));
  conn.exec('CREATE TABLE message_nodes (session_id TEXT, chat_message TEXT, created_at INTEGER)');
  conn.prepare('INSERT INTO message_nodes VALUES (?, ?, ?)').run('s1', JSON.stringify({
    role: 'assistant',
    metadata: {
      request_id: 'r1', generation_model: 'swe-2',
      metrics: { input_tokens: 5000, output_tokens: 500, cache_read_tokens: 40000, cache_creation_tokens: 0 },
    },
  }), 1757000000);
  conn.close();

  try {
    const reader = new UsageReader();
    const r = await reader.report([], {});
    assert.equal(r.totals.input, 5000);
    assert.equal(r.totals.cacheRead, 40000);
    assert.equal(r.totals.turns, 1);
    assert.equal(r.accounts.length, 1);
    assert.equal(r.accounts[0].engine, 'devin');
    assert.equal(r.accounts[0].profileId, null, 'nothing launched it - nothing to name');
  } finally {
    rmSync(join(process.env.XDG_DATA_HOME, 'devin-test'), { recursive: true, force: true });
  }
});

test('a remembered rollup folds exactly like the live report', async () => {
  // The hub answering for a sleeping machine must produce the same numbers
  // the daemon would have - that is the whole reason the rollup crosses the
  // wire raw rather than as a finished report.
  const m = machine();
  const reader = new UsageReader();
  const rollup = await reader.buckets(m.profiles);
  const live = await reader.report(m.profiles, { since: '2026-09-11' });
  const folded = foldBuckets(JSON.parse(JSON.stringify(rollup.buckets)), {
    since: '2026-09-11', accounts: rollup.accounts, scan: rollup.scan, at: rollup.at,
  });
  // `scan` is bookkeeping for the read that produced the rollup, so it
  // legitimately differs between the two passes - the numbers must not.
  const strip = ({ at: _a, scan: _s, ...rest }) => rest;
  assert.deepEqual(strip(folded), strip(live));
  rmSync(m.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------- reading them

test("today ends at the asker's midnight, not UTC's", () => {
  // 00:30 on the 18th in Pakistan (UTC+5) is 19:30 on the 17th in UTC.
  // Work done in that half hour is "today" for the phone asking.
  const bucket = (total) => ({ engine: 'claude', account: 'one', input: total, output: 0, total, turns: 1 });
  const rows = {
    ['one\x002026-10-17T18|claude-opus-5|/work']: bucket(100),
    ['one\x002026-10-17T19|claude-opus-5|/work']: bucket(200),
    // A machine not yet updated still sends whole UTC days.
    ['one\x002026-10-16|claude-opus-5|/work']: bucket(5),
  };
  const pk = foldBuckets(rows, { since: '2026-10-18', tz: 300 });
  assert.equal(pk.totals.total, 200);
  assert.deepEqual(pk.daily.map(d => d.date), ['2026-10-18']);
  const all = foldBuckets(rows, { tz: 300 });
  assert.deepEqual(all.daily.map(d => [d.date, d.total]), [['2026-10-16', 5], ['2026-10-17', 100], ['2026-10-18', 200]]);
  assert.equal(foldBuckets(rows, { since: '2026-10-18' }).totals.total, 0, 'without a zone, days stay UTC');
  assert.equal(foldBuckets(rows, { since: '2026-10-18', tz: -420 }).totals.total, 0,
    'west of UTC the same hours are still the 17th, before noon');
});

test('model drill-down filters totals, daily series and groups before folding', () => {
  const bucket = (engine, total) => ({ engine, account: 'one', input: total, output: 0, total, turns: 1 });
  const rows = {
    ['one\x002026-10-01|claude-opus-5|/work']: bucket('claude', 100),
    ['one\x002026-10-02|claude-opus-5|/work']: bucket('claude', 200),
    ['one\x002026-10-02|claude-sonnet-4|/work']: bucket('claude', 900),
  };
  const report = foldBuckets(rows, { model: 'claude-opus-5', since: '2026-10-02' });
  assert.equal(report.totals.total, 200);
  assert.deepEqual(report.daily.map(d => [d.date, d.total]), [['2026-10-02', 200]]);
  assert.deepEqual(report.groups.map(g => g.model), ['claude-opus-5']);
  assert.equal(foldBuckets(rows, { model: '' }).totals.total, 0, 'unknown model is a filter too');
});

// ------------------------------------------------------------------ pi

/** A Pi home: one session on a free model, one priced, and a failed call. */
function piMachine() {
  const dir = tmp();
  const home = join(dir, 'pi');
  const sess = join(home, 'sessions', '--work-game--');
  mkdirSync(sess, { recursive: true });
  const msg = (ts, model, u, cost) => JSON.stringify({
    type: 'message', timestamp: ts,
    message: { role: 'assistant', model, usage: { ...u, totalTokens: u.input + u.output + u.cacheRead, cost: { total: cost } } },
  }) + '\n';
  writeFileSync(join(sess, 'a.jsonl'),
    JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-11-10T19:30:02Z', cwd: '/work/game' }) + '\n'
    + msg('2026-11-10T19:30:09Z', 'zai-glm-5-3-flash', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 0)
    + msg('2026-11-10T19:31:00Z', 'zai-glm-5-3-flash', { input: 4000, output: 300, cacheRead: 20000, cacheWrite: 0 }, 0)
    + msg('2026-11-10T19:32:00Z', 'pi-made-up-model', { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, 0.25));
  return { dir, home, profiles: [{ id: 'pi', engine: 'pi', env: { PI_CODING_AGENT_DIR: home } }] };
}

test('Pi chats are counted, priced from what Pi wrote', async () => {
  const m = piMachine();
  const r = await new UsageReader().report(m.profiles, { by: ['engine', 'model', 'project'] });
  assert.equal(r.totals.turns, 2, 'a failed call with no tokens is not a turn');
  assert.equal(r.totals.cacheRead, 20000);
  assert.equal(r.totals.unpriced, false, 'a free model Pi priced at zero is priced, not unknown');
  assert.ok(Math.abs(r.totals.costUsd - 0.25) < 1e-9);
  assert.deepEqual(r.groups.map((g) => g.project), ['/work/game', '/work/game']);
  assert.ok(r.groups.every((g) => g.engine === 'pi'));
  rmSync(m.dir, { recursive: true, force: true });
});

test('Pi usage survives a restart without reading the files again', async () => {
  const m = piMachine();
  const indexPath = join(m.dir, 'usage-index.json');
  const saves = [];
  const track = (reader) => {
    const persist = reader.persist.bind(reader);
    reader.persist = () => { const save = persist(); saves.push(save); return save; };
    return reader;
  };
  const before = track(new UsageReader({ indexPath }));
  const first = await before.report(m.profiles, {});
  await before.persist();
  const after = track(new UsageReader({ indexPath }));
  const second = await after.report(m.profiles, {});
  assert.equal(second.scan.parsed, 0, 'a restored index must not re-parse Pi sessions');
  assert.equal(second.totals.turns, first.totals.turns);
  assert.ok(Math.abs(second.totals.costUsd - first.totals.costUsd) < 1e-9);
  await Promise.all(saves);
  rmSync(m.dir, { recursive: true, force: true });
});

// ------------------------------------------------------- accounts on screen

// The Accounts panel, drawn to markup with no browser.
const panel = await build({ stdin: { contents: `
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { AccountLimits } from './apps/web/src/AccountLimits';
  export const draw = (props) => renderToStaticMarkup(createElement(AccountLimits, props));
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react-dom'] });
const panelModule = { exports: {} };
new Function('module', 'exports', 'require', panel.outputFiles[0].text)(panelModule, panelModule.exports, createRequire(import.meta.url));

/** Each account row of the panel for these machine reports, with its meters by name. */
function accountRows(reports, spend) {
  const html = panelModule.exports.draw({ targets: [{ id: 'laptop', name: 'Laptop' }, { id: 'vm', name: 'VM' }],
    limits: { now: Date.now(), failed: {}, reports }, spend, win: '7d' });
  const rows = html.split(/<div class="usage-account(?: idle)?">/).slice(1).map(row => ({ html: row,
    meters: Object.fromEntries([...row.matchAll(/aria-label="([^"]+) remaining"[^>]*aria-valuenow="([^"]+)"/g)].map(m => [m[1], Number(m[2])])) }));
  return { html, rows };
}
const resetsAt = Date.now() / 1000 + 3.5 * 86400;
const week = (used, at) => [{ label: '7d', used, resetsAt, at }];

test('logins sharing a home keep separate allowances and no borrowed full-week worth', () => {
  const { html, rows } = accountRows({ vm: { unsupported: 0, accounts: [] }, laptop: { unsupported: 0, accounts: [
    { account: 'claude|~/.claude-personal|TOKEN_A', engine: 'claude', label: 'personal', displayLabel: 'personal (claudea)', aliases: ['claudea'], windows: week(60, Date.now() - 60000) },
    { account: 'claude|~/.claude-personal|TOKEN_S', engine: 'claude', label: 'personal', displayLabel: 'personal (claudes)', aliases: ['claudes'], windows: week(20, Date.now() - 60000) }] } },
  [{ key: 'claude|~/.claude-personal', engine: 'claude', profileId: 'claudea', costUsd: 9.9, unpriced: false }]);
  assert.equal(rows[0].meters['claude personal (claudea) 7d'], 40);
  assert.equal(rows[1].meters['claude personal (claudes) 7d'], 80);
  assert.match(html, /Shared by personal \(claudea\), personal \(claudes\)/);
  assert.doesNotMatch(html, /full week/, "shared spend is not priced against either login's allowance");
});

test('one credential read on two machines is one row that keeps both report times', () => {
  const row = at => ({ account: 'claude|~/.claude|TOKEN_A', engine: 'claude', label: 'personal', aliases: ['claudea'], windows: week(30, at) });
  const { rows } = accountRows({ laptop: { unsupported: 0, accounts: [row(Date.now() - 150000)] },
    vm: { unsupported: 0, accounts: [row(Date.now() - 3.2 * 3600000)] } });
  assert.equal(rows.length, 1);
  // The row shows the newest report time; each machine's time is in the tooltip.
  assert.match(rows[0].html, /<small title="Laptop 2m ago · VM 3h ago">2m ago<\/small>/);
  // Pace is measured from the newer reading: 30% at half the week is 60%.
  assert.match(rows[0].html, /title="At this pace: 60% used by the reset"/);
});

test('the same account on two machines is one row showing the newest reading of each allowance', () => {
  const now = Date.now() / 1000;
  // Different home folders, report times and numbers - but the same account,
  // as both machines' fingerprints say.
  const { rows } = accountRows({
    vm: { unsupported: 0, accounts: [{ account: 'claude|/home/ubuntu/.claude|TOKEN_A', engine: 'claude', label: 'default', aliases: ['claude'], identity: 'f1',
      windows: [{ label: '5h', used: 70, resetsAt: now + 3600, at: Date.now() - 60000 }, { label: '7d', used: 40, resetsAt: now + 3 * 86400, at: Date.now() - 5 * 3600000 }] }] },
    laptop: { unsupported: 0, accounts: [
      { account: 'claude|~/.claude-personal|TOKEN_A', engine: 'claude', label: 'personal', aliases: ['claudea'], identity: 'f1',
        windows: [{ label: '5h', used: 20, resetsAt: now + 600, at: Date.now() - 4 * 3600000 }, { label: '7d', used: 55, resetsAt: now + 3 * 86400, at: Date.now() - 120000 }] },
      { account: 'claude|~/.claude-personal|TOKEN_S', engine: 'claude', label: 'personal', aliases: ['claudes'], identity: 'f2',
        windows: [{ label: '7d', used: 10, resetsAt: now + 86400, at: Date.now() - 60000 }] }] },
  });
  assert.equal(rows.length, 2, 'one row per account, not per machine');
  assert.match(rows[0].html, /title="Laptop [^"]* · VM [^"]*"/);
  // 5h from the VM (newer), the week from the laptop (newer).
  assert.deepEqual(rows[0].meters, { 'claude personal 5h': 30, 'claude personal 7d': 45 });
});
