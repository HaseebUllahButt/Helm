import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * The git half of `helm self-update`, against real checkouts: a remote repo
 * stands in for origin/main and a clone of it stands in for the deployed
 * ~/.helm-src. rebuild and restart stay off - they are npm and systemd, and
 * what needs proving here is that only a clean main checkout ever moves.
 */
const { selfUpdate, unsafeRestartSessions } = await import('../packages/connect/src/update.js');
const { codexProcId } = await import('../packages/connect/src/hosted-process.js');

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-update-'));
  const remote = join(dir, 'remote');
  const installed = join(dir, 'installed');
  execFileSync('git', ['init', '-b', 'main', remote]);
  git(remote, ['config', 'user.email', 't@t']);
  git(remote, ['config', 'user.name', 't']);
  writeFileSync(join(remote, 'v'), 'one\n');
  git(remote, ['add', '.']);
  git(remote, ['commit', '-qm', 'one']);
  execFileSync('git', ['clone', '-q', remote, installed]);
  return { remote, installed };
};
const commit = (remote, text) => {
  writeFileSync(join(remote, 'v'), `${text}\n`);
  git(remote, ['add', '.']);
  git(remote, ['commit', '-qm', text]);
};

const update = (dir) => selfUpdate(dir, { rebuild: false, restart: false });

test('update restart waits for busy unhosted agents while hosted threads continue', () => {
  const sessions = [
    { id: 'hosted', driver: 'claude', status: 'working' },
    { id: 'working', driver: 'agy', status: 'working' },
    { id: 'question', driver: 'claude', status: 'blocked' },
    { id: 'idle', driver: 'claude', status: 'idle' },
    { id: 'shell', pty: true, status: 'shell' },
    { id: 'external', driver: 'codex', external: true, status: 'working' },
  ];
  assert.deepEqual(unsafeRestartSessions(sessions, (id) => id === 'hosted').map((s) => s.id), ['working', 'question']);
  assert.deepEqual(unsafeRestartSessions(sessions.map((s) => ({ ...s, status: 'idle' })), () => false), []);
});

test('restart guard recognizes Codex threads in their shared account process', () => {
  const profiles = [{ id: 'codex', engine: 'codex', cmd: '/usr/bin/codex', env: { CODEX_HOME: '/tmp/account' } }];
  const sessions = [{ id: 'thread', profileId: 'codex', driver: 'codex', status: 'working' }];
  const procId = codexProcId('/usr/bin/codex', profiles[0].env);
  assert.deepEqual(unsafeRestartSessions(sessions, (id) => id === procId, profiles), []);
  assert.deepEqual(unsafeRestartSessions(sessions, () => false, profiles), sessions);
  assert.deepEqual(unsafeRestartSessions(sessions, () => false), sessions);
  const blocked = sessions.map((s) => ({ ...s, status: 'blocked' }));
  assert.deepEqual(unsafeRestartSessions(blocked, (id) => id === procId, profiles), blocked);
});

test('a current checkout is a no-op', async () => {
  const { installed } = make();
  const r = await update(installed);
  assert.equal(r.updated, false);
  assert.match(r.reason, /already at/);
});

test('a new commit lands as a hard reset to it', async () => {
  const { remote, installed } = make();
  commit(remote, 'two');
  const r = await update(installed);
  assert.equal(r.updated, true);
  assert.equal(readFileSync(join(installed, 'v'), 'utf8'), 'two\n');
  assert.equal(git(installed, ['rev-parse', 'HEAD']), git(remote, ['rev-parse', 'main']));
});

test('a dirty tree is somebody\'s work, never a deployment to overwrite', async () => {
  const { remote, installed } = make();
  commit(remote, 'two');
  writeFileSync(join(installed, 'wip.txt'), 'do not lose me\n');
  const head = git(installed, ['rev-parse', 'HEAD']);
  const r = await update(installed);
  assert.equal(r.updated, false);
  assert.match(r.reason, /uncommitted/);
  assert.equal(git(installed, ['rev-parse', 'HEAD']), head, 'nothing moved');
  assert.equal(readFileSync(join(installed, 'wip.txt'), 'utf8'), 'do not lose me\n');
});

test('a feature branch is not the deployment to update', async () => {
  const { remote, installed } = make();
  commit(remote, 'two');
  git(installed, ['checkout', '-qb', 'wip']);
  const r = await update(installed);
  assert.equal(r.updated, false);
  assert.match(r.reason, /on wip, not main/);
});

test('a directory that is not a checkout is reported, not crashed', async () => {
  const r = await update(mkdtempSync(join(tmpdir(), 'helm-update-plain-')));
  assert.equal(r.updated, false);
  assert.match(r.reason, /not a git checkout/);
});

// ------------------------------------------------------------- what the app is told

const { currentVersion } = await import('../packages/connect/src/update.js');

test('the machine list is told which commit runs, and whether the app may update it', async () => {
  const { remote, installed } = make();
  const v = await currentVersion(installed);
  assert.equal(v.commit, git(installed, ['rev-parse', '--short', 'HEAD']));
  assert.equal(v.branch, 'main');
  assert.equal(v.subject, 'one');
  assert.equal(v.updatable, true);

  // A dirty tree is somebody's development checkout: no button for it.
  writeFileSync(join(installed, 'v'), 'edited\n');
  assert.equal((await currentVersion(installed)).updatable, false);
  git(installed, ['checkout', '--', 'v']);

  // Nor a checkout pinned to a commit, as a release worktree is.
  git(installed, ['checkout', '-q', '--detach', 'HEAD']);
  assert.equal((await currentVersion(installed)).updatable, false);
  void remote;
});

test('something that is not a checkout reports no version rather than failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-nogit-'));
  assert.equal(await currentVersion(dir), null);
});

test('commits made here and not pushed are never reset away', async () => {
  const { remote, installed } = make();
  git(installed, ['config', 'user.email', 't@t']);
  git(installed, ['config', 'user.name', 't']);
  writeFileSync(join(installed, 'mine.txt'), 'unpushed work\n');
  git(installed, ['add', '.']);
  git(installed, ['commit', '-qm', 'mine']);
  const head = git(installed, ['rev-parse', 'HEAD']);
  commit(remote, 'two'); // origin moved on too, so head !== tip
  const r = await update(installed);
  assert.equal(r.updated, false);
  assert.match(r.reason, /1 commit not pushed/);
  assert.equal(git(installed, ['rev-parse', 'HEAD']), head, 'the local commit survives');
});
