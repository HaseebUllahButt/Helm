import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBranch, worktreeHome } from '../packages/connect/src/git-head.js';

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

test('a linked worktree, and any folder in it, maps to the same place in its repo', () => {
  mkdirSync(join(root, 'main/.git/worktrees/main-chat-1'), { recursive: true });
  writeFileSync(join(root, 'main/.git/worktrees/main-chat-1/HEAD'), 'ref: refs/heads/helm/chat-1\n');
  mkdirSync(join(root, 'main-chat-1/apps/web'), { recursive: true });
  writeFileSync(join(root, 'main-chat-1/.git'), `gitdir: ${join(root, 'main/.git/worktrees/main-chat-1')}\n`);
  assert.equal(worktreeHome(join(root, 'main-chat-1'), t), join(root, 'main'));
  assert.equal(worktreeHome(join(root, 'main-chat-1/apps/web'), t), join(root, 'main/apps/web'));
  // A main checkout, or a .git file that is not a worktree, stands for itself.
  assert.equal(worktreeHome(join(root, 'repo/src/deep'), t), null);
  assert.equal(worktreeHome(join(root, 'wt'), t), null);
});

test('outside a repo, or a path that is not a full path, has no branch', () => {
  mkdirSync(join(root, 'plain'), { recursive: true });
  assert.equal(gitBranch(join(root, 'plain'), t), null);
  assert.equal(gitBranch('relative/folder', t), null);
  assert.equal(gitBranch('', t), null);
});
