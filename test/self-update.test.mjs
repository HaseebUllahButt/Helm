import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * The git half of `helm self-update`, against real checkouts: a remote repo
 * stands in for origin/main and a clone of it stands in for the deployed
 * ~/.helm-src. rebuild and restart stay off - they are npm and systemd, and
 * what needs proving here is that only a clean main checkout ever moves.
 */
// The update lock lives in HELM_DIR; never the real one from a test.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-update-dir-'));
const { selfUpdate, unsafeRestartSessions, currentVersion, makeBundle, syncFromBundle, rebuildIfCommitted } = await import('../packages/connect/src/update.js');
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
    { id: 'native-question', nativeCli: true, nativeChat: true, status: 'blocked' },
    { id: 'native-working', nativeCli: true, nativeChat: true, status: 'working' },
  ];
  assert.deepEqual(unsafeRestartSessions(sessions, (id) => id === 'hosted').map((s) => s.id), ['working', 'question', 'native-question']);
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

test('a failed install rolls HEAD back so a healthy retry rebuilds the release', async () => {
  const { remote, installed } = make();
  commit(remote, 'two');
  const bin = mkdtempSync(join(tmpdir(), 'helm-update-bin-'));
  const npm = join(bin, 'npm');
  const calls = join(bin, 'calls');
  const before = git(installed, ['rev-parse', 'HEAD']);
  const path = process.env.PATH;
  try {
    writeFileSync(npm, `#!/bin/sh\necho call >> "${calls}"\nexit 1\n`);
    chmodSync(npm, 0o755);
    process.env.PATH = `${bin}:${path}`;
    await assert.rejects(() => selfUpdate(installed, { restart: false }), /Command failed/);
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before, 'a failed install restores the old source');

    writeFileSync(npm, `#!/bin/sh\necho call >> "${calls}"\nexit 0\n`);
    chmodSync(npm, 0o755);
    const retry = await selfUpdate(installed, { restart: false });
    assert.equal(retry.updated, true);
    assert.equal(git(installed, ['rev-parse', 'HEAD']), git(remote, ['rev-parse', 'main']));
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 3,
      'the retry runs install and build instead of reporting already-at');
  } finally {
    process.env.PATH = path;
  }
});

test('a failed app build also rolls back and can complete on retry', async () => {
  const { remote, installed } = make();
  commit(remote, 'two');
  const bin = mkdtempSync(join(tmpdir(), 'helm-update-bin-'));
  const npm = join(bin, 'npm');
  const calls = join(bin, 'calls');
  const before = git(installed, ['rev-parse', 'HEAD']);
  const path = process.env.PATH;
  try {
    writeFileSync(npm, `#!/bin/sh\necho call >> "${calls}"\ncount=$(wc -l < "${calls}")\n[ "$count" -ne 2 ]\n`);
    chmodSync(npm, 0o755);
    process.env.PATH = `${bin}:${path}`;
    await assert.rejects(() => selfUpdate(installed, { restart: false }), /Command failed/);
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before,
      'the source is restored even when the build command fails');

    writeFileSync(npm, `#!/bin/sh\necho call >> "${calls}"\nexit 0\n`);
    chmodSync(npm, 0o755);
    assert.equal((await selfUpdate(installed, { restart: false })).updated, true);
    assert.equal(git(installed, ['rev-parse', 'HEAD']), git(remote, ['rev-parse', 'HEAD']));
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 4);
  } finally {
    process.env.PATH = path;
  }
});

test('an interrupted post-reset transaction is journaled and recovered', async () => {
  const { remote, installed } = make();
  const previousHead = git(installed, ['rev-parse', 'HEAD']);
  commit(remote, 'two');
  git(installed, ['fetch', '-q', 'origin', 'main']);
  const targetHead = git(installed, ['rev-parse', 'origin/main']);
  git(installed, ['reset', '--hard', '-q', targetHead]);
  writeFileSync(join(process.env.HELM_DIR, 'update-state.json'), JSON.stringify({
    version: 1, dir: installed, previousHead, targetHead, phase: 'prepared', restart: false,
  }));

  const result = await update(installed);
  assert.equal(result.updated, true);
  assert.equal(git(installed, ['rev-parse', 'HEAD']), targetHead);
  assert.equal(existsSync(join(process.env.HELM_DIR, 'update-state.json')), false,
    'the recovery journal is cleared after completion');
});

test('real npm preserves an older lockfile through a failed build and retry', async () => {
  const { remote, installed } = make();
  mkdirSync(join(remote, 'apps/web'), { recursive: true });
  writeFileSync(join(remote, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(remote, 'package.json'), JSON.stringify({
    name: 'update-fixture', version: '1.0.0', private: true, workspaces: ['apps/web'],
  }));
  writeFileSync(join(remote, 'apps/web/package.json'), JSON.stringify({
    name: '@helm/web', version: '1.0.0',
    scripts: { build: 'node -e "process.exit(process.env.HELM_TEST_BUILD_FAIL === \'1\' ? 1 : 0)"' },
  }));
  execFileSync('npm', ['install', '--package-lock-only', '--lockfile-version=2', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: remote, stdio: 'pipe',
  });
  const committedLock = readFileSync(join(remote, 'package-lock.json'), 'utf8');
  commit(remote, 'baseline with dependencies');
  git(installed, ['fetch', '-q', 'origin', 'main']);
  git(installed, ['reset', '--hard', '-q', 'origin/main']);
  commit(remote, 'two');
  const before = git(installed, ['rev-parse', 'HEAD']);
  const oldFlag = process.env.HELM_TEST_BUILD_FAIL;
  try {
    process.env.HELM_TEST_BUILD_FAIL = '1';
    await assert.rejects(() => selfUpdate(installed, { restart: false }), /--workspace @helm\/web run build/);
    assert.equal(git(installed, ['rev-parse', 'HEAD']), before);
    assert.equal(git(installed, ['status', '--porcelain']), '', 'installer leaves no dirty lockfile blocking recovery');
    delete process.env.HELM_TEST_BUILD_FAIL;
    assert.equal((await selfUpdate(installed, { restart: false })).updated, true);
    assert.equal(readFileSync(join(installed, 'package-lock.json'), 'utf8'), committedLock);
    assert.equal(git(installed, ['status', '--porcelain']), '');
  } finally {
    if (oldFlag === undefined) delete process.env.HELM_TEST_BUILD_FAIL;
    else process.env.HELM_TEST_BUILD_FAIL = oldFlag;
  }
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

  // A checkout pinned to a commit can still take a saved version.
  git(installed, ['checkout', '-q', '--detach', 'HEAD']);
  assert.equal((await currentVersion(installed)).updatable, true);
  assert.ok((await currentVersion(installed)).time > 0, 'how new it is decides which machine is the source');
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
  assert.match(r.reason, /1 commit of your own changes/);
  assert.equal(git(installed, ['rev-parse', 'HEAD']), head, 'the local commit survives');
});

test('one update at a time: a second caller is turned away, and the lock clears after', async () => {
  const { remote, installed } = make();
  commit(remote, 'two');
  const [a, b] = await Promise.all([update(installed), update(installed)]);
  const results = [a, b].map((r) => r.updated ? 'updated' : r.reason);
  assert.deepEqual(results.sort(), ['an update is already running', 'updated']);
  commit(remote, 'three');
  assert.equal((await update(installed)).updated, true, 'the lock is released');
});

test('a lock left by a crashed update goes stale instead of blocking forever', async () => {
  const { remote, installed } = make();
  commit(remote, 'two');
  const lock = join(process.env.HELM_DIR, 'update.lock');
  writeFileSync(lock, '');
  assert.equal((await update(installed)).reason, 'an update is already running');
  const old = new Date(Date.now() - 31 * 60_000);
  (await import('node:fs')).utimesSync(lock, old, old);
  assert.equal((await update(installed)).updated, true);
});

// ------------------------------------------------- the owner's own versions

const own = (dir, file, text) => {
  git(dir, ['config', 'user.email', 't@t']); git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, file), `${text}\n`);
  git(dir, ['add', '.']); git(dir, ['commit', '-qm', text]);
  return git(dir, ['rev-parse', 'HEAD']);
};
const sync = (dir, bundle) => syncFromBundle(bundle, dir, { rebuild: false, restart: false });

test('GitHub only replaces my changes when asked, and keeps them on a backup branch', async () => {
  const { remote, installed } = make();
  const mine = own(installed, 'mine.txt', 'my change');
  writeFileSync(join(installed, 'draft.txt'), 'not saved yet\n');
  commit(remote, 'upstream');
  const r = await selfUpdate(installed, { rebuild: false, restart: false, replace: true });
  assert.equal(r.updated, true);
  assert.equal(git(installed, ['rev-parse', 'HEAD']), git(remote, ['rev-parse', 'HEAD']));
  assert.equal(git(installed, ['rev-parse', r.backup]), mine, 'the saved change is on the backup branch');
  assert.match(git(installed, ['stash', 'list']), /helm backup/, 'the unsaved one is stashed');
});

test('a newer saved version on another machine is copied over, never past changes made here', async () => {
  const { remote, installed: a } = make();
  const b = join(remote, '..', 'b');
  execFileSync('git', ['clone', '-q', remote, b]);
  // The laptop's agent saves a change; the VM has none of its own.
  const saved = own(a, 'feature.txt', 'feature');
  const { bundle } = await makeBundle({ have: [git(b, ['rev-parse', 'HEAD'])] }, a);
  const r = await sync(b, bundle);
  assert.equal(r.updated, true);
  assert.equal(git(b, ['rev-parse', 'HEAD']), saved);
  // Asking again sends nothing: it already has it.
  assert.equal((await makeBundle({ have: [saved] }, a)).bundle, null);
  // Both now save their own changes: neither is overwritten.
  own(a, 'x.txt', 'laptop only');
  const vmOwn = own(b, 'y.txt', 'vm only');
  const r2 = await sync(b, (await makeBundle({ have: [saved] }, a)).bundle);
  assert.equal(r2.updated, false);
  assert.equal(r2.diverged, true);
  assert.equal(git(b, ['rev-parse', 'HEAD']), vmOwn);
});

test('unsaved edits never take a synced version, and a version saved here is built in place', async () => {
  const { remote, installed: a } = make();
  const b = join(remote, '..', 'b2');
  execFileSync('git', ['clone', '-q', remote, b]);
  own(a, 'f.txt', 'one');
  writeFileSync(join(b, 'draft.txt'), 'half done\n');
  const r = await sync(b, (await makeBundle({ have: [] }, a)).bundle);
  assert.match(r.reason, /unsaved/);
  const running = git(a, ['rev-parse', 'HEAD']);
  const next = own(a, 'g.txt', 'two');
  const built = await rebuildIfCommitted(running, a, { rebuild: false, restart: false });
  assert.equal(built.updated, true);
  assert.equal(git(a, ['rev-parse', 'HEAD']), next, 'the saved change stays where it is');
  assert.equal((await rebuildIfCommitted(next, a, { rebuild: false, restart: false })).reason, 'nothing new');
});
