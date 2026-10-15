import './automation-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGithubRepos, parseStatus } from '../packages/connect/src/github-repos.js';

/**
 * "Clone from GitHub" in the new chat box. What has to hold: the app sees
 * repo and account names but never a token, a bad repo name can never
 * reach a path, a folder already holding that repo opens instead of
 * failing, and an older gh without --json is still read as signed in.
 */

const cache = () => join(mkdtempSync(join(tmpdir(), 'helm-ghcache-')), 'github-repos.json');
const status = (logins) => JSON.stringify({ hosts: { 'github.com': logins.map((login, i) => ({ login, active: i === 0, state: 'success' })) } });
function gh({ logins = ['me'], missing = false, origin = '' } = {}) {
  const calls = [];
  const command = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    if (missing) throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    if (cmd === 'gh' && args[1] === 'status') return { stdout: status(logins) };
    if (cmd === 'gh' && args[1] === 'token') return { stdout: `secret-${args.at(-1)}\n` };
    if (cmd === 'git') return { stdout: origin };
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  return { command, calls };
}
const repo = (owner, name, extra = {}) => ({ full_name: `${owner}/${name}`, name, owner: { login: owner }, private: true, fork: false, archived: false, description: 'd', pushed_at: '2026-10-01T00:00:00Z', ...extra });

test('repos: names only, the chosen login, and no token in the answer', async () => {
  const { command } = gh({ logins: ['me', 'work'] });
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(init.headers.authorization);
    return new Response(JSON.stringify([repo('me', 'app'), repo('acme', 'site'), repo('../x', 'evil'), repo('me', '..')]), { status: 200 });
  };
  const r = await createGithubRepos({ cacheFile: cache(), command, fetch }).repos({ login: 'work' });
  assert.equal(r.login, 'work');
  assert.deepEqual(r.accounts, [{ login: 'me', active: true }, { login: 'work', active: false }]);
  assert.deepEqual(r.repos.map((x) => x.full), ['me/app', 'acme/site']);
  assert.deepEqual(seen, ['Bearer secret-work']);
  assert.doesNotMatch(JSON.stringify(r), /secret/);
});

test('repos: no gh, or no login, says so instead of failing', async () => {
  const none = await createGithubRepos({ cacheFile: cache(), command: gh({ missing: true }).command }).repos();
  assert.equal(none.installed, false);
  const out = await createGithubRepos({ cacheFile: cache(), command: gh({ logins: [] }).command }).repos();
  assert.equal(out.installed, true);
  assert.equal(out.login, null);
});

test('clone: bad names never reach a path', async () => {
  const g = createGithubRepos({ cacheFile: cache(), command: gh().command, start: () => { throw new Error('must not run'); } });
  for (const name of ['../etc', 'a/b/c', 'a/..', 'onlyname', 'a /b', '']) {
    await assert.rejects(g.clone({ repo: name, parent: tmpdir() }), /Not a GitHub repo name/);
  }
});

test('clone: the same repo already there opens; another folder there is refused', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'helm-clone-'));
  mkdirSync(join(parent, 'app'));
  const same = createGithubRepos({ cacheFile: cache(), command: gh({ origin: 'git@github.com:Me/App.git' }).command });
  assert.deepEqual(await same.clone({ repo: 'me/app', parent }), { state: 'done', percent: 100, path: join(parent, 'app'), existed: true });
  const other = createGithubRepos({ cacheFile: cache(), command: gh({ origin: 'https://github.com/someone/app' }).command });
  await assert.rejects(other.clone({ repo: 'me/app', parent }), /already there/);
});

test('clone: runs gh, reports progress, and tells the folder index', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'helm-clone-'));
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  let ran, noted;
  const g = createGithubRepos({ cacheFile: cache(), command: gh({ logins: ['me', 'work'] }).command, start: (cmd, args, opts) => { ran = { cmd, args, env: opts.env, opts }; return child; },
    noteFolder: async (path, repoFlag) => { noted = [path, repoFlag]; } });
  const started = await g.clone({ repo: 'acme/site', parent, login: 'work' });
  assert.equal(started.state, 'cloning');
  assert.deepEqual(ran.args, ['repo', 'clone', 'acme/site', join(parent, 'site'), '--', '--progress']);
  assert.equal(ran.opts.detached, true, 'its own process group, so stopping it stops git too');
  assert.equal(ran.env.GH_TOKEN, 'secret-work', 'a login other than the active one clones as itself');
  child.stderr.emit('data', 'Receiving objects:  50% (5/10)\r');
  assert.equal((await g.clone({ job: started.job })).percent, 40);
  child.emit('close', 0);
  const done = await g.clone({ job: started.job });
  assert.equal(done.state, 'done');
  assert.equal(done.percent, 100);
  assert.deepEqual(noted, [join(parent, 'site'), true]);
});

test('repos: an organization\'s repo is marked as one', async () => {
  const fetch = async () => new Response(JSON.stringify([repo('me', 'app', { owner: { login: 'me', type: 'User' } }), repo('acme', 'site', { owner: { login: 'acme', type: 'Organization' } })]), { status: 200 });
  const r = await createGithubRepos({ cacheFile: cache(), command: gh().command, fetch }).repos();
  assert.deepEqual(r.repos.map((x) => [x.full, x.org]), [['me/app', false], ['acme/site', true]]);
});

test('accounts: a gh too old for --json is read from its own words', async () => {
  const words = 'github.com\n  ✓ Logged in to github.com account Me (/home/u/.config/gh/hosts.yml)\n  - Active account: true\n  - Token: gho_****\n';
  const command = async (cmd, args) => {
    if (args.includes('--json')) throw Object.assign(new Error('Command failed'), { code: 1, stdout: '', stderr: 'unknown flag: --json\n' });
    if (args[1] === 'status') return { stdout: words, stderr: '' };
    if (args[1] === 'token') return { stdout: 'secret\n' };
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const fetch = async () => new Response('[]', { status: 200 });
  const r = await createGithubRepos({ cacheFile: cache(), command, fetch }).repos();
  assert.equal(r.login, 'Me');
  assert.deepEqual(r.accounts, [{ login: 'Me', active: true }]);
});

test('parseStatus: both wordings, the active one, and failed logins left out', () => {
  assert.deepEqual(parseStatus('github.com\n  ✓ Logged in to github.com as old (~/.config/gh/hosts.yml)\n'), [{ login: 'old', active: true }]);
  assert.deepEqual(parseStatus([
    '  ✓ Logged in to github.com account a (keyring)', '  - Active account: false',
    '  X Failed to log in to github.com account gone (keyring)', '  - Active account: false',
    '  ✓ Logged in to github.com account b (keyring)', '  - Active account: true',
  ].join('\n')), [{ login: 'a', active: false }, { login: 'b', active: true }]);
  assert.deepEqual(parseStatus('You are not logged into any GitHub hosts. To log in, run: gh auth login'), []);
});

test('repos: kept on disk, shown at once next time, and fetched again only when asked', async () => {
  const cacheFile = cache();
  let fetched = 0;
  const fetch = async () => { fetched++; return new Response(JSON.stringify([repo('me', 'app')]), { status: 200 }); };
  let clock = 1_000_000;
  const first = await createGithubRepos({ cacheFile, command: gh().command, fetch, now: () => clock }).repos();
  assert.equal(fetched, 1);
  assert.equal(first.stale, false);
  // A restart: a new instance reads the list from disk without asking GitHub.
  clock += 11 * 60_000;
  const again = createGithubRepos({ cacheFile, command: gh().command, fetch, now: () => clock });
  const held = await again.repos();
  assert.equal(fetched, 1);
  assert.deepEqual(held.repos.map((r) => r.full), ['me/app']);
  assert.equal(held.stale, true, 'old enough that the app asks again, quietly');
  await again.repos({ refresh: true });
  assert.equal(fetched, 2);
});

test('find: a miss fetches the list again and asks GitHub, known owners first', async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    if (url.includes('/user/repos')) return new Response(JSON.stringify([repo('me', 'app'), repo('acme', 'site')]), { status: 200 });
    if (url.includes('/repos/acme/tool')) return new Response('{}', { status: 404 });
    if (url.includes('/search/')) return new Response(JSON.stringify({ items: [repo('stranger', 'tool'), repo('acme', 'tool'), repo('..', 'x')] }), { status: 200 });
    throw new Error(url);
  };
  let clock = 5_000_000;
  const g = createGithubRepos({ cacheFile: cache(), command: gh().command, fetch, now: () => clock });
  await g.repos();
  clock += 60_000;
  const r = await g.find({ query: 'acme/tool' });
  assert.equal(urls.filter((u) => u.includes('/user/repos')).length, 2, 'the list is fetched again');
  assert.deepEqual(r.found.map((x) => x.full), ['acme/tool', 'stranger/tool']);
  assert.match(urls.find((u) => u.includes('/search/')), /q=acme%20tool%20in%3Aname/);
  await assert.rejects(g.find({ query: '  ' }), /Type part/);
});

test('begin: a half-finished clone is cleared only when asked, and a finished one is used', async () => {
  const target = join(mkdtempSync(join(tmpdir(), 'helm-clone-')), 'app');
  mkdirSync(target);
  let head = false;
  const command = async (cmd, args) => {
    if (cmd === 'git' && args.includes('get-url')) return { stdout: 'https://github.com/me/app.git' };
    if (cmd === 'git' && args.includes('rev-parse')) { if (head) return { stdout: 'abc' }; throw new Error('no HEAD'); }
    return gh().command(cmd, args);
  };
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {}, pid: 999999 });
  const g = createGithubRepos({ cacheFile: cache(), command, start: () => child });
  await assert.rejects(g.begin({ repo: 'me/app', target }), /already there/);
  const job = await g.begin({ repo: 'me/app', target, partialOk: true });
  assert.equal(job.state, 'cloning');
  assert.equal(existsSync(target), false, 'the half-made folder was cleared');
  child.emit('close', 0);
  assert.equal((await job.done).state, 'done');
  mkdirSync(target);
  head = true;
  assert.equal((await g.begin({ repo: 'me/app', target })).state, 'done');
});
