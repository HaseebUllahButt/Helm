import './automation-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGithubMonitor, checkState } from '../packages/connect/src/github.js';

const sha = 'a'.repeat(40), mergedSha = 'b'.repeat(40);
const ctx = { host: 'github.com', repository: 'owner/repo', headRepository: 'owner/repo', headOwner: 'owner', branch: 'feature', sha };
function fixture(extra = {}) {
  let commentRevision = 0, conflict = false;
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
      reviewDecision: 'APPROVED', mergeable: conflict ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: sha,
      headRepository: { nameWithOwner: 'owner/repo' }, mergeCommit: { oid: mergedSha },
    }] } } } });
    if (/\/(comments|reviews)\?/.test(path)) return response(commentRevision ? [{ id: 8, body: `Comment ${commentRevision}`, updated_at: String(commentRevision), user: { login: 'reviewer' } }] : [], 200, headers);
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
    comment: () => { commentRevision++; }, conflict: () => { conflict = true; }, recover: () => { failure = false; }, mode: value => { mode = value; }, token: value => { token = value; }, etags: () => { etags = true; } };
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

function prFixture(extra = {}) {
  const calls = [], commands = [];
  const pr = { number: 42, title: 'Feature', body: 'Details', state: 'open', head: { sha, ref: 'feature' }, base: { ref: 'main' }, user: { login: 'author' }, html_url: 'https://github.com/owner/repo/pull/42' };
  const request = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, body: init.body && JSON.parse(init.body), headers: init.headers });
    const reply = value => new Response(JSON.stringify(value), { status: 200 });
    if (init.method === 'PUT') return reply({ merged: true });
    if (init.method === 'POST') return reply(path.endsWith('/pulls') ? pr : { id: 99 });
    if (path === '/repos/owner/repo') return reply({ default_branch: 'main' });
    if (path.endsWith('/pulls')) return reply([pr]);
    if (path.endsWith('/pulls/42')) return reply(pr);
    if (path.endsWith('/files')) return reply([{ filename: 'code.js', patch: '+new', additions: 1, deletions: 0, status: 'modified' }]);
    if (path.endsWith('/comments') || path.endsWith('/reviews')) return reply([{ id: 1, body: 'Please fix', user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }]);
    if (path.endsWith('/check-runs')) return reply({ total_count: 1, check_runs: [{ id: 1, name: 'Tests', status: 'completed', conclusion: 'success' }] });
    throw new Error(`unexpected ${path}`);
  };
  const monitor = createGithubMonitor({ context: async () => ({ ...ctx }), credential: async (_, login) => `token-${login}`,
    accounts: async () => [{ login: 'work', valid: true }], fetch: request, command: async (file, args, options) => { commands.push({ file, args, options }); return { stdout: args.includes('ls-files') ? 'code.js\0:(glob)*\0' : '' }; }, ...extra });
  return { monitor, calls, commands, pr };
}

test('PR list, discussion, diffs and mutations use the selected credentials and explicit head', async t => {
  const f = prFixture(); t.after(() => f.monitor.stop()); await f.monitor.selectAccount('/project', 'work');
  assert.equal((await f.monitor.pullRequests('/project')).pullRequests[0].number, 42);
  const detail = await f.monitor.pullRequest('/project', 42); assert.equal(detail.files[0].patch, '+new'); assert.equal(detail.comments.length, 3);
  await f.monitor.prAction('/project', { number: 42, action: 'comment', body: 'Looks good' });
  await f.monitor.prAction('/project', { number: 42, action: 'review', event: 'APPROVE', headSha: sha, comments: [{ path: 'code.js', line: 1, side: 'RIGHT', body: 'Good' }] });
  const review = f.calls.find(c => c.method === 'POST' && c.path.endsWith('/reviews')); assert.equal(review.body.commit_id, sha); assert.equal(review.body.comments[0].line, 1);
  await f.monitor.prAction('/project', { number: 42, action: 'merge', mergeMethod: 'squash', headSha: sha });
  assert.equal(f.calls.at(-1).body.sha, sha); assert.ok(f.calls.every(c => c.headers.Authorization === 'Bearer token-work'));
  const n = f.calls.length;
  await assert.rejects(f.monitor.prAction('/project', { number: 42, action: 'merge', mergeMethod: 'squash' }), /refresh/);
  await assert.rejects(f.monitor.prAction('/project', { number: 42, action: 'review', event: 'APPROVE', headSha: mergedSha }), /head changed/);
  assert.equal(f.calls.slice(n).filter(c => c.method !== 'GET').length, 0);
  await assert.rejects(f.monitor.pullRequests('/project', { state: '../bad' }), /filter/);
});

test('publishing commits only selected literal paths then pushes and creates PR with selected gh auth', async t => {
  const f = prFixture(); t.after(() => f.monitor.stop()); await f.monitor.selectAccount('/project', 'work');
  const result = await f.monitor.publish('/project', { action: 'publish', message: 'Commit feature', paths: ['code.js', ':(glob)*'], title: 'Feature', body: 'Details', draft: true });
  assert.deepEqual(result.completed, ['commit', 'push', 'create']); assert.equal(f.commands.length, 4);
  assert.ok(f.commands[1].args.includes('--literal-pathspecs')); assert.ok(f.commands[2].args.includes('--only'));
  const push = f.commands[3]; assert.ok(push.args.includes('https://github.com/owner/repo.git')); assert.equal(push.options.env.GH_TOKEN, 'token-work');
  assert.ok(!JSON.stringify(push.args).includes('token-work')); assert.ok(!push.args.includes('--force'));
  assert.equal(f.calls.at(-1).body.draft, true); assert.equal(f.calls.at(-1).body.base, 'main');
  const n = f.commands.length;
  await assert.rejects(f.monitor.publish('/project', { action: 'publish', message: 'Invalid', paths: ['code.js'], title: '', body: 'Details' }), /title/);
  await assert.rejects(f.monitor.publish('/project', { action: 'commit', message: 'Invalid', paths: ['../secret'] }), /files/);
  assert.equal(f.commands.length, n, 'all validation precedes writes');
});

test('publish failures report completed steps without leaking CLI stderr or retrying pushes', async t => {
  let writes = 0;
  const f = prFixture({ command: async () => { if (++writes === 4) throw new Error('secret-token-from-cli'); return { stdout: writes === 1 ? 'code.js\0' : '' }; } });
  t.after(() => f.monitor.stop());
  await assert.rejects(f.monitor.publish('/project', { action: 'publish', message: 'Feature', paths: ['code.js'], title: 'Feature', body: '' }), error => {
    assert.match(error.message, /Completed commit/); assert.ok(!error.message.includes('secret-token')); return true;
  });
  assert.equal(writes, 4); assert.ok(!f.calls.some(c => c.method === 'POST'));
});

test('agent watches persist pending wakes, guard busy and approvals, dedupe and enforce caps', async t => {
  const watchFile = join(mkdtempSync(join(tmpdir(), 'helm-agent-watch-')), 'watches.json');
  let idle = false; const wakes = [];
  const f = fixture({ watchFile, session: id => ({ id, cwd: '/project', driver: 'codex' }), canWake: () => idle,
    wake: async (id, prompt, options) => wakes.push({ id, prompt, options }) }); t.after(() => f.monitor.stop());
  f.monitor.watch('thread', true, { agent: true, maxWakes: 1 });
  for (let i = 0; i < 30 && !f.events.length; i++) await new Promise(r => setTimeout(r, 5));
  f.advance(301000); f.fail(); f.comment(); f.conflict(); await f.monitor.tick();
  assert.equal(wakes.length, 0); assert.equal(f.monitor.watchState('thread').pending, true);
  assert.ok(readFileSync(watchFile, 'utf8').includes('local-gh-'));
  idle = true; await f.monitor.tick(); assert.equal(wakes.length, 1);
  assert.match(wakes[0].prompt, /CONFLICTING/); assert.match(wakes[0].prompt, /comment:8 changed/); assert.equal(wakes[0].options.source, 'github-watch');
  await f.monitor.tick(); assert.equal(wakes.length, 1);
  f.advance(301000); f.comment(); await f.monitor.tick(); assert.equal(wakes.length, 1); assert.equal(f.monitor.watchState('thread').pending, true);
  f.monitor.watch('thread', true, { agent: false }); assert.equal(f.monitor.watchState('thread').pending, false);
  f.advance(86400000); await f.monitor.tick(); assert.equal(wakes.length, 1);
});

test('pending agent wake survives restart once and user Stop cancels later pending changes', async t => {
  const watchFile = join(mkdtempSync(join(tmpdir(), 'helm-watch-restart-')), 'watches.json');
  let idle = false, stoppedAt = null; const wakes = [], seen = new Set();
  const options = { watchFile, session: id => ({ id, cwd: '/project', driver: 'codex', stoppedAt }), canWake: () => idle,
    wake: async (id, prompt, opts) => { if (!seen.has(opts.turnId)) { seen.add(opts.turnId); wakes.push(opts); } } };
  const f = fixture(options); f.monitor.watch('thread', true, { agent: true });
  for (let i = 0; i < 30 && !f.events.length; i++) await new Promise(r => setTimeout(r, 5));
  f.advance(301000); f.fail(); await f.monitor.tick(); assert.equal(f.monitor.watchState('thread').pending, true); f.monitor.stop();
  const restarted = fixture(options); t.after(() => restarted.monitor.stop()); restarted.fail(); idle = true;
  await restarted.monitor.tick(); await restarted.monitor.tick(); assert.equal(wakes.length, 1);
  idle = false; restarted.advance(301000); restarted.comment(); await restarted.monitor.tick(); assert.equal(restarted.monitor.watchState('thread').pending, true);
  stoppedAt = 1; await restarted.monitor.tick(); assert.equal(restarted.monitor.watchState('thread').pending, false);
  stoppedAt = null; idle = true; await restarted.monitor.tick(); assert.equal(wakes.length, 1);
});

test('long PR discussions read the latest pages within a fixed request cap', async t => {
  const f = prFixture({ fetch: async (url, init) => {
    const parsed = new URL(url), path = parsed.pathname;
    if (path.endsWith('/pulls/42')) return new Response(JSON.stringify({ number: 42, state: 'open', head: { sha }, base: {} }));
    if (path.endsWith('/files')) return new Response('[]');
    if (path.endsWith('/check-runs')) return new Response('{"check_runs":[],"total_count":0}');
    const page = parsed.searchParams.get('page');
    return new Response(JSON.stringify([{ id: page ? Number(page) : 1, body: page === '5' ? 'Latest comment' : 'Older' }]),
      { headers: page ? {} : { link: '<https://api.github.com/unused?page=2>; rel="next", <https://api.github.com/unused?page=5>; rel="last"' } });
  } }); t.after(() => f.monitor.stop());
  const detail = await f.monitor.pullRequest('/project', 42);
  assert.equal(detail.truncated, true); assert.ok(detail.comments.some(c => c.body === 'Latest comment'));
});

test('real commits handle repo subfolders and renames while preserving unrelated staged files', async t => {
  const { execFileSync, execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { writeFileSync, mkdirSync, renameSync, rmSync } = await import('node:fs');
  const { githubContext } = await import('../packages/connect/src/git.js');
  const root = mkdtempSync(join(tmpdir(), 'helm-publish-repo-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git(['init', '-b', 'feature']); git(['config', 'user.name', 'Isolated test']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.hooksPath', '/dev/null']);
  writeFileSync(join(root, 'old.js'), 'original'); writeFileSync(join(root, 'other.js'), 'original'); git(['add', '.']); git(['commit', '-m', 'Initial']);
  git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']); mkdirSync(join(root, 'subfolder'));
  renameSync(join(root, 'old.js'), join(root, 'new.js')); writeFileSync(join(root, 'other.js'), 'unrelated'); git(['add', '-A']);
  const monitor = createGithubMonitor({ context: githubContext, credential: async () => 'fake-token', command: promisify(execFile) }); t.after(() => monitor.stop());
  const result = await monitor.publish(join(root, 'subfolder'), { action: 'commit', paths: ['new.js', 'old.js'], message: 'Rename only' });
  assert.deepEqual(result.completed, ['commit']); assert.equal(git(['show', 'HEAD:new.js']), 'original');
  assert.equal(git(['diff', '--cached', '--name-only']), 'other.js'); assert.equal(git(['show', 'HEAD:other.js']), 'original');
});

test('explicit PR actions can use reserved quota while hard rate limits still reject them', async t => {
  let limited = false;
  const f = prFixture({ fetch: async (_, init) => new Response(JSON.stringify(limited ? { message: 'rate limit' } : init.method === 'GET' ? [] : { id: 1 }),
    { status: limited ? 429 : 200, headers: limited ? { 'retry-after': '60' } : { 'x-ratelimit-remaining': '5', 'x-ratelimit-limit': '100', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } }) });
  t.after(() => f.monitor.stop());
  await f.monitor.pullRequests('/project'); await f.monitor.prAction('/project', { number: 42, action: 'comment', body: 'Reserved quota action' });
  limited = true;
  await assert.rejects(f.monitor.prAction('/project', { number: 42, action: 'comment', body: 'Now rate limited' }), /rate limit/);
});

test('agent watches and notification watches can be toggled independently', async t => {
  const f = fixture({ session: id => ({ id, cwd: '/project', driver: 'codex' }) }); t.after(() => f.monitor.stop());
  f.monitor.watch('thread', true, { agent: true }); assert.equal(f.monitor.watching('thread'), false); assert.equal(f.monitor.watchState('thread').enabled, true);
  f.monitor.watch('thread', true); assert.equal(f.monitor.watching('thread'), true);
  f.monitor.watch('thread', false); assert.equal(f.monitor.watching('thread'), false); assert.equal(f.monitor.watchState('thread').enabled, true);
  f.monitor.watch('thread', true, { agent: false }); assert.equal(f.monitor.watchState('thread').enabled, false);
});

test('archive wins when it happens while a pending wake is resolving repository context', async t => {
  let idle = false, archived = false, hold = false, release;
  const wakes = [];
  const f = fixture({ context: async () => { if (hold) await new Promise(resolve => { release = resolve; }); return { ...ctx }; },
    session: id => ({ id, cwd: '/project', driver: 'codex', archived }), canWake: () => idle, wake: async (...args) => wakes.push(args) }); t.after(() => f.monitor.stop());
  f.monitor.watch('thread', true, { agent: true });
  for (let i = 0; i < 30 && !f.events.length; i++) await new Promise(r => setTimeout(r, 5));
  f.advance(301000); f.fail(); await f.monitor.tick(); assert.equal(f.monitor.watchState('thread').pending, true);
  idle = true; hold = true; const pending = f.monitor.tick();
  for (let i = 0; i < 30 && !release; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(release); archived = true; hold = false; release(); await pending; assert.equal(wakes.length, 0);
});
