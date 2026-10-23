import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureFiles, restoreFiles } from '../packages/connect/src/checkpoints/files.js';

function fixture(t) {
  const home = fs.mkdtempSync(join(tmpdir(), 'helm-capture-files-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const main = join(home, 'main'), cwd = join(home, 'tree');
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args]);
  fs.mkdirSync(main);
  execFileSync('git', ['init', '-q', main]);
  execFileSync('git', ['-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base']);
  execFileSync('git', ['-C', main, 'worktree', 'add', '-qb', 'test', cwd], { stdio: 'pipe' });
  const parent = join(cwd, 'nested', 'leaf');
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(join(parent, 'a'), 'first');
  fs.writeFileSync(join(parent, 'b'), 'second');
  git('add', '.');
  return { home, cwd, parent, git, destination: join(home, 'snapshot') };
}

// Change the filesystem at a known capture step, without timing a race.
function intercept(t, method, hook) {
  const original = fs[method];
  fs[method] = (...args) => hook(original, ...args);
  syncBuiltinESMExports();
  t.after(() => { fs[method] = original; syncBuiltinESMExports(); });
}

test('nested restore preserves raw bytes, staged edits, modes and dangling links', t => {
  const { cwd, parent, git, destination } = fixture(t);
  git('config', 'core.autocrlf', 'true');
  const file = join(parent, 'a'), staged = Buffer.from([0, 255, 13, 10]), unstaged = Buffer.from([0, 254, 10]);
  fs.writeFileSync(file, staged); git('add', '.'); fs.writeFileSync(file, unstaged);
  fs.chmodSync(file, 0o755); fs.symlinkSync('missing', join(parent, 'link'));
  const status = git('status', '--porcelain=v1', '-z');
  captureFiles(cwd, destination);
  fs.writeFileSync(file, 'later'); git('add', '.'); fs.unlinkSync(join(parent, 'link'));
  restoreFiles(cwd, destination);
  assert.deepEqual(fs.readFileSync(file), unstaged);
  assert.deepEqual(git('show', ':nested/leaf/a'), staged);
  assert.deepEqual(git('status', '--porcelain=v1', '-z'), status);
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  assert.equal(fs.readlinkSync(join(parent, 'link')), 'missing');
});

for (const phase of ['next file', 'verification pass']) {
  test(`capture rechecks parents at the ${phase}`, t => {
    const { home, cwd, parent, destination } = fixture(t);
    const outside = join(home, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, 'a'), 'outside a'); fs.writeFileSync(join(outside, 'b'), 'outside b');
    const target = join(parent, phase === 'next file' ? 'a' : 'b');
    let changed = false, indexRead = false;
    const swapParent = () => {
      changed = true; fs.rmSync(parent, { recursive: true }); fs.symlinkSync(outside, parent);
    };
    if (phase === 'verification pass') intercept(t, 'lstatSync', (stat, path, ...args) => {
      if (path === parent && indexRead && !changed) swapParent();
      return stat(path, ...args);
    });
    intercept(t, 'readFileSync', (read, path, ...args) => {
      const bytes = read(path, ...args);
      if (phase === 'next file' && path === target && !changed) swapParent();
      if (typeof path === 'string' && path.endsWith('/index')) indexRead = true;
      return bytes;
    });
    assert.throws(() => captureFiles(cwd, destination), /Unsafe checkpoint parent: nested\/leaf\//);
    assert.equal(changed, true);
    assert.equal(fs.readFileSync(join(outside, 'a'), 'utf8'), 'outside a');
    assert.equal(fs.existsSync(join(destination, 'manifest.json')), false);
  });
}

test('capture still detects a file changed after its bytes were read', t => {
  const { cwd, parent, destination } = fixture(t);
  const target = join(parent, 'a'); let changed = false;
  intercept(t, 'readFileSync', (read, path, ...args) => {
    const bytes = read(path, ...args);
    if (path === target && !changed) { changed = true; fs.writeFileSync(target, 'changed after read'); }
    return bytes;
  });
  assert.throws(() => captureFiles(cwd, destination), /workspace changed during file capture/);
});

test('capture rejects a file parent and preserves parent access errors', t => {
  const { cwd, parent, destination } = fixture(t);
  fs.rmSync(parent, { recursive: true }); fs.writeFileSync(parent, 'owner bytes');
  assert.throws(() => captureFiles(cwd, destination), /Unsafe checkpoint parent/);
  fs.rmSync(parent); fs.mkdirSync(parent); fs.writeFileSync(join(parent, 'a'), 'first');
  const denied = Object.assign(new Error('parent denied'), { code: 'EACCES' });
  intercept(t, 'lstatSync', (stat, path, ...args) => {
    if (path === parent) throw denied;
    return stat(path, ...args);
  });
  assert.throws(() => captureFiles(cwd, destination), error => error === denied);
});

test('missing tracked parents remain valid when their files stay deleted', t => {
  const { cwd, parent, destination } = fixture(t);
  fs.rmSync(parent, { recursive: true });
  const saved = captureFiles(cwd, destination);
  assert.deepEqual(saved.files, []);
  restoreFiles(cwd, destination);
  assert.equal(fs.existsSync(parent), false);
});
