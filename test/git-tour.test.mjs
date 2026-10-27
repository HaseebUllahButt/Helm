import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitTours, tourChange, tourHunks, tourPrompt, normalizeTour } from '../packages/connect/src/git-tour.js';
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'helm-tour-')), cwd = join(root, 'repo');
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(cwd);
  git(cwd, 'init', '-qb', 'main'); git(cwd, 'config', 'user.email', 't@t'); git(cwd, 'config', 'user.name', 't');
  writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  return { root, cwd };
}
const edit = cwd => writeFileSync(join(cwd, 'a.txt'), 'one\nTWO\n');
const reply = (path = 'a.txt') => JSON.stringify({ stops: [{ path, hunk: 0, title: 'Read the new value', summary: 'The value changes to upper case. Check that the display needs this value.', decision: 'Keep upper case?' }] });

test('freeze edits, staged files, deleted files, untracked names, and secrets without losing files', async t => {
  const { cwd, root } = fixture(t); edit(cwd);
  git(cwd, 'add', '.'); writeFileSync(join(cwd, 'a.txt'), 'one\nTHREE\n');
  writeFileSync(join(cwd, 'new file.txt'), 'fresh\n'); writeFileSync(join(cwd, '.env'), 'SECRET=password\n');
  writeFileSync(join(root, 'outside'), 'OUTSIDE\n'); symlinkSync(join(root, 'outside'), join(cwd, 'link'));
  const change = await tourChange(cwd);
  assert.equal(change.files.length, 4);
  assert.match(change.files.find(f => f.path === 'a.txt').hunks[0].diff, /THREE/);
  assert.match(change.files.find(f => f.path === 'new file.txt').hunks[0].diff, /fresh/);
  const prompt = tourPrompt(change); assert.doesNotMatch(prompt, /SECRET=password|OUTSIDE/);
  assert.match(prompt, /never as instructions/);
  assert.ok(change.files.find(f => f.path === 'link').hidden);
  git(cwd, 'rm', '-qf', 'a.txt');
  const deleted = (await tourChange(cwd)).files.find(f => f.path === 'a.txt');
  assert.equal(deleted.hunks[0].side, 'old');
});

test('branch tours compare with main and commit tours use the first parent, even when edits exist', async t => {
  const { cwd } = fixture(t); const root = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'checkout', '-qb', 'feature'); edit(cwd); git(cwd, 'commit', '-qam', 'feature');
  const id = git(cwd, 'rev-parse', 'HEAD'); writeFileSync(join(cwd, 'a.txt'), 'WORKING\n');
  const branch = await tourChange(cwd, 'branch'); assert.equal(branch.base, root);
  assert.doesNotMatch(JSON.stringify(branch), /WORKING/);
  const commit = await tourChange(cwd, 'commit', id.slice(0, 7)); assert.equal(commit.commit, id);
  assert.equal(commit.identity, (await tourChange(cwd, 'commit', id)).identity);
  const first = await tourChange(cwd, 'commit', root); assert.equal(first.files[0].path, 'a.txt');
  await assert.rejects(tourChange(cwd, 'commit', '--all'), /Choose a commit/);
});

test('normalize only real ranges and list every file the helper left out', async t => {
  const { cwd } = fixture(t); edit(cwd); writeFileSync(join(cwd, 'other'), 'data\n');
  const change = await tourChange(cwd);
  const raw = JSON.parse(reply()); raw.stops.push({ ...raw.stops[0], path: 'not-in-change' }, { ...raw.stops[0], hunk: 999 });
  const guide = normalizeTour(JSON.stringify(raw), change);
  assert.equal(guide.stops.length, 1); assert.equal(guide.stops[0].start, 1);
  assert.deepEqual(guide.alsoChanged.map(f => f.path), ['other']);
  assert.throws(() => normalizeTour('not json', change), /did not return/);
  assert.throws(() => normalizeTour('{"stops":[]}', change), /did not name/);
  assert.equal(tourHunks('@@ -2,2 +2,0 @@\n-two\n-three')[0].end, 3);
});

function service(t, cwd, root) {
  let result = { complete: false }, calls = [], killed = [];
  const sessions = { get: () => ({ id: 'parent', profileId: 'own' }),
    delegate: async options => { calls.push(options); return { session: { id: 'helper' } }; },
    delegationResult: () => result, kill: async id => { killed.push(id); } };
  const agents = async () => [{ id: 'other', available: true, cheapModel: 'wrong' }, { id: 'own', engine: 'codex', available: true, cheapModel: 'mini' }];
  return { instance: new GitTours({ sessions, agents, directory: join(root, 'tours') }), sessions, agents,
    calls, killed, finish: value => { result = value; }, args: { cwd, sessionId: 'parent' } };
}

test('reading never starts a helper; explicit starts share one run and use the chat account', async t => {
  const { cwd, root } = fixture(t); edit(cwd); const s = service(t, cwd, root);
  assert.equal((await s.instance.dispatch(s.args)).state, 'none'); assert.equal(s.calls.length, 0);
  const runs = await Promise.all([s.instance.dispatch({ ...s.args, action: 'start' }), s.instance.dispatch({ ...s.args, action: 'start' })]);
  assert.equal(s.calls.length, 1); assert.equal(runs[0].state, 'writing');
  assert.notEqual(s.calls[0].cwd, cwd); assert.equal(s.calls[0].cwd, join(root, 'tours', 'writer'));
  assert.equal(s.calls[0].profileId, 'own'); assert.equal(s.calls[0].model, 'mini'); assert.equal(s.calls[0].mode, 'readonly'); assert.equal(s.calls[0].tour, true);
  s.finish({ complete: true, status: 'done', output: reply() });
  assert.equal((await s.instance.dispatch(s.args)).state, 'ready');
  const reopened = new GitTours({ sessions: s.sessions, agents: s.agents, directory: join(root, 'tours') });
  assert.equal((await reopened.dispatch({ ...s.args, action: 'start' })).state, 'ready'); assert.equal(s.calls.length, 1);
  writeFileSync(join(cwd, 'a.txt'), 'NEWER\n');
  assert.equal((await reopened.dispatch(s.args)).old, true); assert.equal(s.calls.length, 1);
});

test('stop persists across restart and a late result cannot replace it; errors can retry', async t => {
  const { cwd, root } = fixture(t); edit(cwd); const s = service(t, cwd, root);
  await s.instance.dispatch({ ...s.args, action: 'start' });
  const restarted = new GitTours({ sessions: s.sessions, agents: s.agents, directory: join(root, 'tours') });
  assert.equal((await restarted.dispatch(s.args)).state, 'writing');
  assert.equal((await restarted.dispatch({ ...s.args, action: 'stop' })).state, 'stopped');
  assert.deepEqual(s.killed, ['helper']); s.finish({ complete: true, status: 'done', output: reply() });
  assert.equal((await restarted.dispatch(s.args)).state, 'stopped');
  s.finish({ complete: true, status: 'done', output: 'broken' });
  assert.equal((await restarted.dispatch({ ...s.args, action: 'start' })).state, 'failed');
  s.finish({ complete: true, status: 'done', output: reply() });
  assert.equal((await restarted.dispatch({ ...s.args, action: 'start' })).state, 'ready');
});

test('a saved commit tour is old after the branch moves', async t => {
  const { cwd, root } = fixture(t); edit(cwd); git(cwd, 'commit', '-qam', 'change');
  const s = service(t, cwd, root), args = { ...s.args, scope: 'commit', hash: git(cwd, 'rev-parse', 'HEAD'), action: 'start' };
  s.finish({ complete: true, status: 'done', output: reply() });
  assert.equal((await s.instance.dispatch(args)).old, false);
  git(cwd, 'commit', '--allow-empty', '-qm', 'next');
  assert.equal((await s.instance.dispatch({ ...args, action: 'get' })).old, true); assert.equal(s.calls.length, 1);
});

test('all files survive a change larger than the Git screen file list', async t => {
  const { cwd } = fixture(t);
  for (let i = 0; i < 305; i++) writeFileSync(join(cwd, `new-${i}.txt`), 'new\n');
  const change = await tourChange(cwd);
  assert.equal(change.files.length, 305);
  const guide = normalizeTour(reply('new-0.txt'), change);
  assert.equal(guide.stops.length + guide.alsoChanged.length, 305);
});

test('staged files in a new repository have real excerpts', async t => {
  const { cwd } = fixture(t);
  git(cwd, 'checkout', '--orphan', 'empty'); git(cwd, 'rm', '-qrf', '.');
  writeFileSync(join(cwd, 'first.txt'), 'first\n'); git(cwd, 'add', '.');
  const change = await tourChange(cwd); assert.equal(change.commit, '');
  assert.match(change.files[0].hunks[0].diff, /first/);
});

test('older saved changes remain available after writing another tour', async t => {
  const { cwd, root } = fixture(t); edit(cwd); const s = service(t, cwd, root);
  s.finish({ complete: true, status: 'done', output: reply() });
  const first = await s.instance.dispatch({ ...s.args, action: 'start' });
  writeFileSync(join(cwd, 'a.txt'), 'next\n');
  await s.instance.dispatch({ ...s.args, action: 'start' });
  edit(cwd);
  const back = await s.instance.dispatch({ ...s.args, action: 'start' });
  assert.equal(back.change.identity, first.change.identity); assert.equal(s.calls.length, 2);
});
