import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBranch } from '../packages/connect/src/git-head.js';

const root = mkdtempSync(join(tmpdir(), 'helm-head-'));
const t = Date.now();

test('a folder inside a repo reads the branch from git\'s own HEAD', () => {
  mkdirSync(join(root, 'repo/.git'), { recursive: true });
  mkdirSync(join(root, 'repo/src/deep'), { recursive: true });
  writeFileSync(join(root, 'repo/.git/HEAD'), 'ref: refs/heads/fix/login-redirect\n');
  assert.equal(gitBranch(join(root, 'repo/src/deep'), t), 'fix/login-redirect');
});

test('a worktree follows its .git file; a detached HEAD is the short commit', () => {
  mkdirSync(join(root, 'gd'), { recursive: true });
  writeFileSync(join(root, 'gd/HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  mkdirSync(join(root, 'wt'), { recursive: true });
  writeFileSync(join(root, 'wt/.git'), `gitdir: ${join(root, 'gd')}\n`);
  assert.equal(gitBranch(join(root, 'wt'), t), '0123456');
});

test('outside a repo, or a path that is not a full path, has no branch', () => {
  mkdirSync(join(root, 'plain'), { recursive: true });
  assert.equal(gitBranch(join(root, 'plain'), t), null);
  assert.equal(gitBranch('relative/folder', t), null);
  assert.equal(gitBranch('', t), null);
});
