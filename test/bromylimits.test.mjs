import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { broMyLimitsUrl, broMyLimitsBuckets, connectBroMyLimits } from '../packages/usage/src/bromylimits.js';
import { foldBuckets } from '../packages/usage/src/index.js';

const fixture = () => ({ fetchedAt: '2026-10-04T12:00:00Z', accounts: [
  { id: 'codex-default', provider: 'codex', daily: [{ date: '2026-10-04', tokens: 1000, cost: 2 }] },
  { id: 'agy-default', provider: 'antigravity', daily: [{ date: '2026-10-04', tokens: 200, cost: 0, unpriced: true }] },
  { id: 'remote-codex', provider: 'codex', remote: true, daily: [{ date: '2026-10-04', tokens: 9999, cost: 99 }] },
] });
const native = () => ({ buckets: {
  'codex|\x002026-10-04|gpt-6-sol|/project': { engine: 'codex', total: 1000 },
  'other|\x002026-10-04|unknown|/project': { engine: 'other', total: 5 },
}, accounts: [{ account: 'codex|', engine: 'codex' }, { account: 'other|', engine: 'other' }], at: 123, scan: {} });

test('dashboard totals replace overlapping engines, preserve others, exclude mesh echoes', async () => {
  let request;
  const rollup = await connectBroMyLimits(native(), { machineId: 'laptop', url: 'http://localhost:47291/',
    fetchImpl: async (url) => { request = url; return { ok: true, json: async () => fixture() }; } });
  assert.equal(request.searchParams.get('scope'), 'local');
  const report = foldBuckets(rollup.buckets, { accounts: rollup.accounts, by: ['engine', 'model'] });
  assert.equal(report.totals.total, 1205);
  assert.equal(report.totals.costUsd, 2);
  assert.equal(report.totals.unpriced, true);
  assert.equal(report.totals.summaryOnly, true);
  assert.equal(report.groups.find((g) => g.engine === 'codex').model, 'not reported');
  assert.equal(report.accounts.filter((a) => a.source === 'bromylimits').length, 2);
});

test('duplicate account aliases and another machine never inflate totals', () => {
  const data = fixture();
  data.accounts.push(data.accounts[0]);
  data.accounts.push({ ...data.accounts[0], id: 'foreign', machineId: 'why' });
  const r = broMyLimitsBuckets(data, { machineId: 'laptop' });
  assert.equal(foldBuckets(r.buckets).totals.total, 1200);
});

test('partial unpriced daily cost is retained and zero cost is valid', () => {
  const data = fixture();
  data.accounts[0].daily[0].unpriced = true;
  const report = foldBuckets(broMyLimitsBuckets(data).buckets);
  assert.equal(report.totals.costUsd, 2);
  assert.equal(report.totals.unpriced, true);
});

test('archived usage is included only in all time, never assigned an invented date', () => {
  const data = fixture();
  data.accounts[0].allTime = { tokens: 1100, cost: 3 };
  const { buckets } = broMyLimitsBuckets(data);
  const all = foldBuckets(buckets);
  assert.equal(all.totals.total, 1300);
  assert.equal(all.totals.undated, true);
  assert.equal(all.daily[0].total, 1200);
  assert.equal(foldBuckets(buckets, { since: '2026-10-04' }).totals.total, 1200);
  assert.equal(foldBuckets(buckets, { since: '2026-10-05' }).totals.total, 0);
});

test('failed or malformed dashboard data retains native records with visible failure', async () => {
  for (const fetchImpl of [async () => { throw new Error('connection refused'); },
    async () => ({ ok: true, json: async () => ({ accounts: [] }) }),
    async () => { const d = fixture(); d.accounts[0].daily[0].tokens = -1; return { ok: true, json: async () => d }; }]) {
    const base = native();
    const r = await connectBroMyLimits(base, { url: 'http://localhost/', fetchImpl });
    assert.deepEqual(r.buckets, base.buckets);
    assert.ok(r.accounts.at(-1).sourceError);
  }
});

test('discover installed service port, then systemd drop-ins, then explicit override', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helm-bml-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = join(home, '.config/systemd/user');
  await mkdir(`${dir}/cc-usage-dashboard.service.d`, { recursive: true });
  await writeFile(`${dir}/cc-usage-dashboard.service`, '[Service]\nEnvironment=PORT=47800\n');
  assert.equal(await broMyLimitsUrl({ home, env: {} }), 'http://127.0.0.1:47800/');
  await writeFile(`${dir}/cc-usage-dashboard.service.d/port.conf`, 'Environment="PORT=47900"\n');
  assert.equal(await broMyLimitsUrl({ home, env: {} }), 'http://127.0.0.1:47900/');
  assert.equal(await broMyLimitsUrl({ home, env: { HELM_BROMYLIMITS_URL: 'http://localhost:1/' } }), 'http://localhost:1/');
  assert.equal(await broMyLimitsUrl({ home, env: { HELM_BROMYLIMITS_URL: 'off' } }), null);
});
