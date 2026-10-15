import './automation-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGithubRepos } from '../packages/connect/src/github-repos.js';

/**
 * "Clone from GitHub" in the new chat box. What has to hold: the app sees
 * repo and account names but never a token, a bad repo name can never
 * reach a path, a folder already holding that repo opens instead of
 * failing, and a sign-in hands back gh's code and later its result.
 */

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
  const r = await createGithubRepos({ command, fetch }).repos({ login: 'work' });
  assert.equal(r.login, 'work');
  assert.deepEqual(r.accounts, [{ login: 'me', active: true }, { login: 'work', active: false }]);
  assert.deepEqual(r.repos.map((x) => x.full), ['me/app', 'acme/site']);
  assert.deepEqual(seen, ['Bearer secret-work']);
  assert.doesNotMatch(JSON.stringify(r), /secret/);
});

test('repos: no gh, or no login, says so instead of failing', async () => {
  const none = await createGithubRepos({ command: gh({ missing: true }).command }).repos();
  assert.equal(none.installed, false);
  const out = await createGithubRepos({ command: gh({ logins: [] }).command }).repos();
  assert.equal(out.installed, true);
  assert.equal(out.login, null);
});

test('clone: bad names never reach a path', async () => {
  const g = createGithubRepos({ command: gh().command, start: () => { throw new Error('must not run'); } });
  for (const name of ['../etc', 'a/b/c', 'a/..', 'onlyname', 'a /b', '']) {
    await assert.rejects(g.clone({ repo: name, parent: tmpdir() }), /Not a GitHub repo name/);
  }
});

test('clone: the same repo already there opens; another folder there is refused', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'helm-clone-'));
  mkdirSync(join(parent, 'app'));
  const same = createGithubRepos({ command: gh({ origin: 'git@github.com:Me/App.git' }).command });
  assert.deepEqual(await same.clone({ repo: 'me/app', parent }), { state: 'done', percent: 100, path: join(parent, 'app'), existed: true });
  const other = createGithubRepos({ command: gh({ origin: 'https://github.com/someone/app' }).command });
  await assert.rejects(other.clone({ repo: 'me/app', parent }), /already there/);
});

test('clone: runs gh, reports progress, and tells the folder index', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'helm-clone-'));
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  let ran, noted;
  const g = createGithubRepos({ command: gh({ logins: ['me', 'work'] }).command, start: (cmd, args, opts) => { ran = { cmd, args, env: opts.env }; return child; },
    noteFolder: async (path, repoFlag) => { noted = [path, repoFlag]; } });
  const started = await g.clone({ repo: 'acme/site', parent, login: 'work' });
  assert.equal(started.state, 'cloning');
  assert.deepEqual(ran.args, ['repo', 'clone', 'acme/site', join(parent, 'site'), '--', '--progress']);
  assert.equal(ran.env.GH_TOKEN, 'secret-work', 'a login other than the active one clones as itself');
  child.stderr.emit('data', 'Receiving objects:  50% (5/10)\r');
  assert.equal((await g.clone({ job: started.job })).percent, 40);
  child.emit('close', 0);
  const done = await g.clone({ job: started.job });
  assert.equal(done.state, 'done');
  assert.equal(done.percent, 100);
  assert.deepEqual(noted, [join(parent, 'site'), true]);
});

test('sign-in: hands back gh\'s code, then who signed in', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  const g = createGithubRepos({ command: gh().command, start: () => {
    setTimeout(() => child.stderr.emit('data', '\n! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n'), 10);
    return child;
  } });
  const first = await g.signIn({ start: true });
  assert.equal(first.state, 'waiting');
  assert.equal(first.code, 'AB12-CD34');
  assert.equal(first.url, 'https://github.com/login/device');
  assert.equal((await g.signIn({ start: true })).code, 'AB12-CD34', 'a second tap shows the same code');
  child.stderr.emit('data', '✓ Logged in as octo\n');
  child.emit('close', 0);
  const done = await g.signIn();
  assert.equal(done.state, 'done');
  assert.equal(done.login, 'octo');
  assert.equal((await g.signIn()).state, 'idle');
});
