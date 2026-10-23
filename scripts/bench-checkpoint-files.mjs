#!/usr/bin/env node
// Compare capture with a saved baseline module. Run from any checkout:
// node scripts/bench-checkpoint-files.mjs /absolute/path/to/before.mjs
// Generated Git repositories stay private and are removed after the run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('Give the saved baseline module path.');
const modules = await Promise.all([
  import(pathToFileURL(resolve(process.argv[2]))),
  import('../packages/connect/src/checkpoints/files.js'),
]);
const base = fs.mkdtempSync(join(tmpdir(), 'helm-capture-bench-'));
const main = join(base, 'main'), cwd = join(base, 'tree');
const git = (directory, ...args) => cp.execFileSync('git', ['-C', directory, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const samples = [[], []], counts = [];
let expected;
try {
  fs.mkdirSync(main); git(main, 'init', '-q');
  git(main, 'config', 'user.name', 'Test'); git(main, 'config', 'user.email', 'test@example.invalid');
  for (let i = 0; i < 2000; i++) {
    const parent = join(main, `group-${i % 20}`, 'nested', 'leaf');
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(join(parent, `file-${i}`), Buffer.from([0, 255, i % 256, 10, 13]));
  }
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'fixture'); git(main, 'worktree', 'add', '-qb', 'measure', cwd);
  git(cwd, 'config', 'core.autocrlf', 'true');
  const edited = join(cwd, 'group-0/nested/leaf/file-0');
  const staged = Buffer.from([0, 1, 255, 13, 10]), unstaged = Buffer.from([0, 2, 255, 10]);
  fs.writeFileSync(edited, staged); git(cwd, 'add', '.'); fs.writeFileSync(edited, unstaged);
  fs.symlinkSync('file-0', join(cwd, 'group-0/nested/leaf/link'));

  // Count separately: timing does not include wrappers around filesystem calls.
  for (const [i, mod] of modules.entries()) {
    const stat = fs.lstatSync, exec = cp.execFileSync;
    let fileChecks = 0, gitCalls = 0;
    try {
      fs.lstatSync = (...args) => { fileChecks++; return stat(...args); };
      cp.execFileSync = (...args) => { gitCalls++; return exec(...args); };
      syncBuiltinESMExports();
      mod.captureFiles(cwd, join(base, `count-${i}`));
      counts.push({ fileChecks, gitCalls });
    } finally {
      fs.lstatSync = stat; cp.execFileSync = exec; syncBuiltinESMExports();
    }
  }
  for (let round = 0; round < 11; round++) {
    for (const i of round % 2 ? [1, 0] : [0, 1]) {
      const destination = join(base, `capture-${round}-${i}`), start = performance.now();
      const snapshot = modules[i].captureFiles(cwd, destination);
      const ms = performance.now() - start;
      if (round >= 2) samples[i].push(ms);
      const content = {
        snapshot,
        bytes: snapshot.files.map(entry => entry.link ?? fs.readFileSync(join(destination, entry.blob)).toString('base64')),
        index: fs.readFileSync(join(destination, 'index')).toString('base64'),
      };
      expected ??= content; assert.deepEqual(content, expected);
      fs.rmSync(destination, { recursive: true });
    }
  }
  const status = git(cwd, 'status', '--porcelain=v1', '-z');
  for (const [i, mod] of modules.entries()) {
    const destination = join(base, `restore-${i}`);
    mod.captureFiles(cwd, destination);
    const savedIndex = fs.readFileSync(join(destination, 'index'));
    fs.writeFileSync(edited, 'later'); git(cwd, 'add', '.');
    fs.unlinkSync(join(cwd, 'group-0/nested/leaf/link')); fs.writeFileSync(join(cwd, 'new'), 'new');
    mod.restoreFiles(cwd, destination);
    assert.deepEqual(fs.readFileSync(join(expected.snapshot.dir, 'index')), savedIndex);
    assert.deepEqual(git(cwd, 'status', '--porcelain=v1', '-z'), status);
    assert.deepEqual(fs.readFileSync(edited), unstaged);
    assert.deepEqual(git(cwd, 'show', ':group-0/nested/leaf/file-0'), staged);
    for (const [entryIndex, entry] of expected.snapshot.files.entries()) {
      const file = join(cwd, entry.name);
      if (entry.link != null) assert.equal(fs.readlinkSync(file), entry.link);
      else {
        assert.equal(fs.readFileSync(file).toString('base64'), expected.bytes[entryIndex]);
        assert.equal(fs.statSync(file).mode & 0o777, entry.mode);
      }
    }
  }
  console.log(JSON.stringify({ files: 2001, depth: 3, identicalCapture: true, identicalRestore: true,
    results: samples.map((ms, i) => ({ version: i ? 'changed' : 'baseline', ...counts[i],
      medianMs: [...ms].sort((a, b) => a - b)[4], samplesMs: ms })) }, null, 2));
} finally { fs.rmSync(base, { recursive: true, force: true }); }
