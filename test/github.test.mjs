import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGithubMonitor, checkState } from '../packages/connect/src/github.js';

const sha = 'a'.repeat(40), mergedSha = 'b'.repeat(40);
const ctx = { host: 'github.com', repository: 'owner/repo', headRepository: 'owner/repo', headOwner: 'owner', branch: 'feature', sha };
function fixture(extra = {}) {
  let time = 1_800_000_000_000, failure = false, merged = false, token = 'private-token', mode = '', etags = false;
  const calls = [], notifications = [], events = [];
  const response = (data, status = 200, headers = {}) => new Response(status === 304 ? null : JSON.stringify(data), { status, headers });
  const request = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ url, init, path });
    if (mode === 'auth') return response({ message: 'Bad credentials' }, 401);
    if (mode === 'secondary') return response({ message: 'You have exceeded a secondary rate limit' }, 403, { 'retry-after': '120' });
    if (mode === 'throttled-text') return new Response('Too many requests', { status: 429 });
    if (mode === 'graphql' && path === '/graphql') return response({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((time + 60000) / 1000) });
    if (mode === 'checks' && path.includes('check-runs')) return response({ message: 'down' }, 503);
    if (mode === 'access' && path.includes('check-runs')) return response({ message: 'Resource not accessible' }, 403);
    if (etags && init.headers['If-None-Match']) return response(null, 304);
    const headers = etags ? { etag: '"same"' } : {};
    if (path === '/graphql') return response({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{
      number: 42, title: 'Ship feature', url: 'https://github.com/owner/repo/pull/42', state: merged ? 'MERGED' : 'OPEN', isDraft: false,
      reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: sha,
      headRepository: { nameWithOwner: 'owner/repo' }, mergeCommit: { oid: mergedSha },
    }] } } } });
    if (path.includes('/pulls?')) return response([{ number: 42, title: 'Ship feature', html_url: 'https://github.com/owner/repo/pull/42', state: 'open',
      head: { sha, repo: { full_name: 'owner/repo' } } }], 200, headers);
    if (path.includes('check-runs')) return response({ total_count: mode === 'pages' ? 301 : 1, check_runs: [{ id: 1, name: 'Tests', status: 'completed',
      conclusion: mode === 'unknown-conclusion' ? null : failure ? 'failure' : 'success', details_url: 'https://github.com/owner/repo/runs/1', output: { title: 'Unit tests' } }] }, 200, headers);
    if (path.includes('/status?')) return response({ total_count: 0, statuses: [] }, 200, headers);
    if (path.includes('/jobs?')) return response({ total_count: 1, jobs: [{ id: 7, name: 'Build', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/owner/repo/actions/runs/6/job/7',
      steps: [{ number: 2, name: 'Compile', status: 'completed', conclusion: 'failure' }] }] }, 200, headers);
    if (path.includes('/actions/runs?')) return response({ total_count: 1, workflow_runs: [{ id: 6, workflow_id: 1, name: 'CI', status: 'completed', conclusion: failure ? 'failure' : 'success',
      head_sha: merged ? mergedSha : sha, run_attempt: 1, event: 'push', html_url: 'https://github.com/owner/repo/actions/runs/6' }] }, 200, headers);
    if (path.includes('/deployments?')) return response([{ id: 9, environment: 'production', sha: merged ? mergedSha : sha }], 200, headers);
    if (path.includes('/deployments/9/statuses')) return response([{ state: merged ? 'success' : 'in_progress', environment_url: 'https://example.com', log_url: 'https://github.com/owner/repo/actions/runs/6' }], 200, headers);
    throw new Error(`Unexpected ${path}`);
  };
  const monitor = createGithubMonitor({ context: async () => ({ ...ctx }), credential: async () => token, fetch: request, now: () => time,
    session: id => ({ id, cwd: '/project', title: 'Ship feature', envId: 'laptop' }), notify: value => notifications.push(value), emit: value => events.push(value), ...extra });
  return { monitor, calls, notifications, events, advance: ms => { time += ms; }, fail: () => { failure = true; }, merge: () => { merged = true; },
    recover: () => { failure = false; }, mode: value => { mode = value; }, token: value => { token = value; }, etags: () => { etags = true; } };
}

test('simultaneous panels share one read; cached and conditional reads avoid repeated quota use', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); f.etags();
  const [a, b] = await Promise.all([f.monitor.get('/project'), f.monitor.get('/other-worktree')]);
  assert.equal(a.pr.number, 42); assert.deepEqual(a, b); assert.equal(a.checksState, 'success');
  const n = f.calls.length; await f.monitor.get('/project'); assert.equal(f.calls.length, n);
  f.advance(61000); await f.monitor.get('/project');
  assert.ok(f.calls.filter(c => c.path !== '/graphql').slice(n - 1).every(c => c.init.headers['If-None-Match'] === '"same"'));
  assert.ok(!JSON.stringify(a).includes('private-token'));
});

test('primary GraphQL exhaustion falls back to REST without claiming review readiness', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); f.mode('graphql');
  const value = await f.monitor.get('/project'); assert.equal(value.pr.number, 42); assert.equal(value.pr.review, null);
  assert.equal(value.pr.mergeState, 'UNKNOWN'); assert.equal(value.errors.length, 0);
  assert.equal(f.calls.filter(c => c.path === '/graphql').length, 1);
  f.advance(10000); await f.monitor.get('/project', { force: true });
  assert.equal(f.calls.filter(c => c.path === '/graphql').length, 1, 'the exhausted quota is not retried');
});

test('secondary throttling pauses both API kinds and resumes only after Retry-After', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); f.mode('secondary');
  const value = await f.monitor.get('/project'); assert.equal(f.calls.length, 1); assert.ok(value.errors.every(e => e.code === 'rate_limit'));
  f.advance(61000); await f.monitor.get('/project', { force: true }); assert.equal(f.calls.length, 1);
  f.advance(60000); f.mode(''); const fresh = await f.monitor.get('/project', { force: true }); assert.equal(fresh.checksState, 'success');
});

test('429 text responses without headers back off exponentially across both APIs', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); f.mode('throttled-text');
  await f.monitor.get('/project'); assert.equal(f.calls.length, 1);
  f.advance(61000); const second = await f.monitor.get('/project', { force: true }); assert.equal(f.calls.length, 2);
  f.advance(61000); await f.monitor.get('/project', { force: true }); assert.equal(f.calls.length, 2, 'the second pause lasts two minutes');
  assert.ok(second.retryAt > second.checkedAt + 100000);
  f.advance(60000); f.mode(''); assert.equal((await f.monitor.get('/project', { force: true })).checksState, 'success');
});

test('a completed check with no conclusion is unknown rather than passed', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); f.mode('unknown-conclusion');
  const value = await f.monitor.get('/project'); assert.equal(value.checks[0].state, 'unknown'); assert.equal(value.checksState, 'unknown');
});

test('authentication failures are explicit and permission failures never turn checks green', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); f.mode('auth');
  const denied = await f.monitor.get('/project'); assert.ok(denied.errors.some(e => e.code === 'auth')); assert.equal(denied.checksState, 'unknown');
  f.advance(61000); f.mode('access'); const access = await f.monitor.get('/project'); assert.equal(access.checksState, 'unknown');
  assert.ok(access.errors.some(e => e.section === 'Checks' && e.code === 'access'));
});

test('failed refresh retains last results as stale, with unknown aggregate check state', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); const first = await f.monitor.get('/project');
  f.advance(61000); f.mode('checks'); const stale = await f.monitor.get('/project');
  assert.deepEqual(stale.checks, first.checks); assert.equal(stale.stale, true); assert.equal(stale.checksState, 'unknown');
  assert.ok(stale.errors.some(e => e.section === 'Checks'));
});

test('incomplete check pagination cannot report success; cancelled checks stay cancelled', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); f.mode('pages');
  const value = await f.monitor.get('/project'); assert.equal(value.truncated, true); assert.equal(value.checksState, 'unknown');
  assert.equal(f.calls.filter(c => c.path.includes('check-runs')).length, 3);
  assert.equal(checkState([{ state: 'cancelled' }]), 'cancelled'); assert.equal(checkState([], true), 'unknown');
});

test('merged PR follows merge SHA for deployments, while checks remain tied to local HEAD', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); f.merge(); const value = await f.monitor.get('/project');
  assert.equal(value.deploymentSha, mergedSha); assert.equal(value.sha, sha); assert.equal(value.pr.state, 'MERGED');
  assert.ok(f.calls.some(c => c.path.includes(`actions/runs?head_sha=${mergedSha}`)));
  assert.ok(f.calls.some(c => c.path.includes(`/commits/${sha}/check-runs`)));
});

test('unpublished commits do not borrow passing PR-head checks', async t => {
  const f = fixture({ context: async () => ({ ...ctx, sha: 'c'.repeat(40) }) }); t.after(() => f.monitor.stop());
  const value = await f.monitor.get('/project'); assert.equal(value.unpublished, true);
  assert.ok(f.calls.some(c => c.path.includes(`/commits/${'c'.repeat(40)}/check-runs`)));
});

test('workflow job detail carries failing steps and a direct log link', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); const data = await f.monitor.jobs('/project', 6);
  assert.equal(data.jobs[0].steps[0].state, 'failure'); assert.match(data.jobs[0].url, /job\/7$/);
  await assert.rejects(f.monitor.jobs('/project', '../secrets'), /not a workflow run/);
});

test('explicit watches notify only transitions, survive restart, and stop when disabled', async t => {
  const watchFile = join(mkdtempSync(join(tmpdir(), 'helm-github-')), 'watches.json');
  const f = fixture({ watchFile }); t.after(() => f.monitor.stop()); f.monitor.watch('thread', true);
  // watch() starts an asynchronous tick; wait for its initial persisted baseline.
  for (let i = 0; i < 30 && !f.events.length; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(f.notifications.length, 0);
  f.advance(61000); f.fail(); await f.monitor.tick();
  assert.equal(f.notifications.filter(n => n.title === 'Helm · CI checks failed').length, 1);
  const firstFailureTag = f.notifications[0].tag;
  f.advance(61000); f.recover(); await f.monitor.tick();
  f.advance(61000); f.fail(); await f.monitor.tick();
  assert.equal(f.notifications.filter(n => n.title === 'Helm · CI checks failed').length, 2);
  assert.notEqual(f.notifications.at(-1).tag, firstFailureTag, 'a fresh failure is not swallowed by notification deduplication');
  f.advance(61000); f.merge(); await f.monitor.tick();
  assert.ok(f.notifications.some(n => n.title === 'Helm · Deployment succeeded'));
  assert.ok(f.notifications.some(n => n.title === 'Helm · PR merged'));
  assert.ok(!readFileSync(watchFile, 'utf8').includes('private-token'));
  f.monitor.stop();
  const restarted = fixture({ watchFile }); t.after(() => restarted.monitor.stop()); restarted.fail(); restarted.merge();
  await restarted.monitor.tick(); assert.equal(restarted.notifications.length, 0, 'restart does not repeat old notifications');
  restarted.monitor.watch('thread', false); restarted.advance(61000); const n = restarted.calls.length;
  await restarted.monitor.tick(); assert.equal(restarted.calls.length, n); assert.equal(restarted.monitor.watching('thread'), false);
});

test('credential changes isolate response caches', async t => {
  const f = fixture(); t.after(() => f.monitor.stop()); f.etags(); await f.monitor.get('/project');
  const n = f.calls.length; f.advance(61000); f.token('other-token'); await f.monitor.get('/project');
  assert.ok(f.calls.slice(n).every(c => !c.init.headers['If-None-Match']));
});

test('per-repository account selection uses explicit gh identities and persists no credentials', async t => {
  const accountFile = join(mkdtempSync(join(tmpdir(), 'helm-github-accounts-')), 'accounts.json');
  const identities = [];
  const options = { accountFile, accounts: async () => [{login:'personal',active:true,valid:true},{login:'work',active:false,valid:true}],
    credential: async (host, login) => { identities.push(login); return `token-for-${login}`; } };
  const f = fixture(options); t.after(() => f.monitor.stop()); f.etags();
  assert.equal((await f.monitor.accounts('/project')).selected, 'auto');
  await f.monitor.get('/project'); const n = f.calls.length;
  await f.monitor.selectAccount('/project', 'work'); const result = await f.monitor.get('/project');
  assert.equal(result.account, 'work'); assert.deepEqual(identities, ['auto', 'work']);
  assert.ok(f.calls.slice(n).every(c => !c.init.headers['If-None-Match']), 'accounts never reuse each other’s cached responses');
  assert.ok(f.calls.slice(n).every(c => c.init.headers.Authorization === 'Bearer token-for-work'));
  assert.ok(!readFileSync(accountFile,'utf8').includes('token-for'));
  await assert.rejects(f.monitor.selectAccount('/project', 'not-signed-in'), /Sign in/);
  const restarted = fixture(options); t.after(() => restarted.monitor.stop());
  assert.equal((await restarted.monitor.accounts('/project')).selected, 'work');
});
