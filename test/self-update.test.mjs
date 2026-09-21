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
const { selfUpdate } = await import('../packages/connect/src/update.js');

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
