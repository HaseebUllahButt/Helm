import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * The git a phone asks about, against real repositories. What has to hold:
 * status says what changed and by how much, a diff is only ever of a file
 * inside the folder, and a worktree is a new folder on a new derived branch.
 */
const { status, diff, addWorktree } = await import('../packages/connect/src/git.js');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-git-'));
  const dir = join(root, 'proj');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'b.txt'), 'keep\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
  return dir;
};

test('a folder that is not a repository says so', async () => {
  const s = await status(mkdtempSync(join(tmpdir(), 'helm-nogit-')));
  assert.equal(s.repo, false);
});

test('a folder that does not exist is refused', async () => {
  await assert.rejects(status('/definitely/not/here'), /no such folder/);
});

test('a clean repo reports its branch and head and no files', async () => {
  const s = await status(repo());
  assert.equal(s.repo, true);
  assert.equal(s.branch, 'main');
  assert.equal(s.head.subject, 'first');
  assert.deepEqual(s.files, []);
  assert.equal(s.worktree, false);
});

test('edits, additions, deletions and untracked files are told apart, with counts', async () => {
  const dir = repo();
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n'); // 2 added, 1 removed
  git(dir, 'rm', '-q', 'b.txt');
  writeFileSync(join(dir, 'new.txt'), 'x\ny\n');                // untracked, 2 lines
  const s = await status(dir);
  const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
  assert.equal(by['a.txt'].status, 'M');
  assert.deepEqual([by['a.txt'].add, by['a.txt'].del], [2, 1]);
  assert.equal(by['b.txt'].status, 'D');
  assert.equal(by['b.txt'].staged, true);
  assert.equal(by['new.txt'].status, '?');
  assert.equal(by['new.txt'].add, 2);
});

test('a file with spaces in its name survives the null-separated parse', async () => {
  const dir = repo();
  writeFileSync(join(dir, 'my notes.txt'), 'hi\n');
  const s = await status(dir);
  assert.ok(s.files.some((f) => f.path === 'my notes.txt'));
});

test('a diff is the change against HEAD, for tracked and untracked files alike', async () => {
  const dir = repo();
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  writeFileSync(join(dir, 'new.txt'), 'fresh\n');
  const tracked = await diff(dir, 'a.txt');
  assert.match(tracked.diff, /^-two$/m);
  assert.match(tracked.diff, /^\+TWO$/m);
  const fresh = await diff(dir, 'new.txt');
  assert.match(fresh.diff, /^\+fresh$/m);
});

test('a diff will not name anything outside the folder', async () => {
  const dir = repo();
  for (const bad of ['../secret', '/etc/passwd', 'a/../../x', '', 'a\0b']) {
    await assert.rejects(diff(dir, bad), /not a path inside the folder/, JSON.stringify(bad));
  }
});

test('a worktree is a sibling folder on a new derived branch, and reads as one', async () => {
  const dir = repo();
  const w = await addWorktree(dir, 'Fix the Login Bug!!');
  assert.equal(w.branch, 'helm/fix-the-login-bug');
  assert.equal(w.base, 'main');
  assert.match(w.path, /proj-fix-the-login-bug$/);
  assert.ok(existsSync(w.path));
  const s = await status(w.path);
  assert.equal(s.worktree, true);
  assert.equal(s.branch, 'helm/fix-the-login-bug');
  // The same name again finds a free folder instead of failing.
  const again = await addWorktree(dir, 'Fix the Login Bug!!');
  assert.equal(again.branch, 'helm/fix-the-login-bug-2');
  rmSync(w.path, { recursive: true, force: true });
});

test('a worktree name can never become anything but a slug', async () => {
  const dir = repo();
  const w = await addWorktree(dir, '../../etc; rm -rf ~ $(x)');
  assert.match(w.branch, /^helm\/[a-z0-9-]+$/);
  assert.ok(!w.path.includes('..'));
});

test('a worktree of something that is not a repository is refused', async () => {
  await assert.rejects(addWorktree(mkdtempSync(join(tmpdir(), 'helm-nogit-')), 'x'), /not a git repository/);
});

test('a linked worktree knows the repository it belongs to; nothing else does', async () => {
  const { worktreeBase } = await import('../packages/connect/src/git.js');
  const dir = repo();
  const w = await addWorktree(dir, 'feature');
  assert.equal(worktreeBase(w.path), dir, 'the worktree points home');
  assert.equal(worktreeBase(dir), null, 'the main checkout is not a worktree');
  assert.equal(worktreeBase(mkdtempSync(join(tmpdir(), 'helm-nogit-'))), null, 'nor is a plain folder');
  assert.equal(worktreeBase('/definitely/not/here'), null, 'nor a folder that is not there');
  rmSync(w.path, { recursive: true, force: true });
});
