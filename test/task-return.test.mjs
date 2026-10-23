import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, rmSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotBaseline, applyReturnedSnapshot } from '../packages/connect/src/task-return.js';
import { taskCheckpoint, checkpointChanges } from '../packages/connect/src/task-git.js';

const snapshot = (files) => ({ files: Object.entries(files).map(([path, text]) => ({
  path, data: Buffer.from(text).toString('base64url'), mode: 0o644,
})) });
const root = mkdtempSync(join(tmpdir(), 'helm-task-return-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

test('return never follows symlinks or overwrites overlapping local modifications', () => {
  const folder = join(root, 'project');
  const outside = join(root, 'outside');
  mkdirSync(folder); mkdirSync(outside);
  writeFileSync(join(outside, 'file'), 'outside');
  symlinkSync(outside, join(folder, 'linked'));
  writeFileSync(join(folder, 'app'), 'local');
  const baseline = snapshotBaseline(snapshot({ app: 'base' }));
  const result = applyReturnedSnapshot(folder, baseline, snapshot({ app: 'remote', 'linked/file': 'unsafe' }), 'return');
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflicts, ['app', 'linked/file']);
  assert.equal(readFileSync(join(outside, 'file'), 'utf8'), 'outside');
  assert.equal(readFileSync(join(folder, 'app'), 'utf8'), 'local');
});

test('unchanged files and prototype-like names survive while remote additions and deletions apply idempotently', () => {
  const folder = join(root, 'idempotent');
  mkdirSync(folder);
  writeFileSync(join(folder, 'constructor'), 'old');
  writeFileSync(join(folder, 'remove'), 'old');
  writeFileSync(join(folder, 'local'), 'local edit');
  const baseline = snapshotBaseline(snapshot({ constructor: 'old', remove: 'old', local: 'base' }));
  const returned = snapshot({ constructor: 'new', local: 'base', added: 'new' });
  assert.equal(applyReturnedSnapshot(folder, baseline, returned, 'return').status, 'returned');
  assert.equal(readFileSync(join(folder, 'constructor'), 'utf8'), 'new');
  assert.equal(readFileSync(join(folder, 'local'), 'utf8'), 'local edit');
  assert.equal(existsSync(join(folder, 'remove')), false);
  assert.deepEqual(applyReturnedSnapshot(folder, baseline, returned, 'return'), { status: 'returned', changed: 0, conflicts: [] });
});

test('Git checkpoints are deterministic across storage locations and isolate deletions and executable changes', () => {
  const first = join(root, 'git-first');
  const second = join(root, 'git-second');
  const before = snapshot({ 'z file': 'keep', '.env': 'SECRET=private', remove: 'old', script: 'run' });
  const base = taskCheckpoint(first, before);
  assert.equal(taskCheckpoint(second, { files: [...before.files].reverse() }), base);
  const after = snapshot({ 'z file': 'keep', '.env': 'SECRET=private', script: 'run', new: 'new' });
  after.files.find((file) => file.path === 'script').mode = 0o755;
  const final = taskCheckpoint(first, after, base);
  assert.deepEqual(checkpointChanges(first, base, final), ['new', 'remove', 'script']);
});

test('batched Git input keeps historical commits and exact binary and Unicode file bytes', () => {
  const directory = join(root, 'git-binary');
  const empty = taskCheckpoint(directory, snapshot({}));
  assert.equal(empty, 'eae7ed87595145448ac8218b2001237c3e5c8395');
  const bytes = Buffer.from('zero\0\n');
  const input = { files: [{ path: 'space اردو 😀', mode: 0o644, data: bytes.toString('base64url') }] };
  const commit = taskCheckpoint(directory, input);
  assert.equal(commit, 'd100ccc98dbf83398fda5c05a43ebd82dc4d348a');
  const git = (...args) => execFileSync('git', ['--git-dir', join(directory, 'repo.git'), ...args]);
  assert.deepEqual(git('show', `${commit}:space اردو 😀`), bytes);
  assert.equal(git('cat-file', '-p', commit).toString(),
    `tree ${git('rev-parse', `${commit}^{tree}`).toString().trim()}\nauthor Helm <task@helm.local> 946684800 +0000\ncommitter Helm <task@helm.local> 946684800 +0000\n\nHelm task checkpoint\n`);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(directory), ['repo.git']);
  const child = taskCheckpoint(directory, snapshot({ new: 'next' }), 'refs/heads/task');
  assert.equal(git('rev-parse', `${child}^`).toString().trim(), commit);
});

test('a failed Git batch keeps its previous saved point and removes private input', () => {
  const directory = join(root, 'git-failure');
  const base = taskCheckpoint(directory, snapshot({ app: 'keep' }));
  const head = () => execFileSync('git', ['--git-dir', join(directory, 'repo.git'), 'rev-parse', 'refs/heads/task'], { encoding: 'utf8' }).trim();
  for (const files of [
    [{ path: '../outside', data: '' }],
    [{ path: 'same', data: '' }, { path: 'same', data: '' }],
    [{ path: 'a', data: '' }, { path: 'a/b', data: '' }],
    [{ path: '.git/config', data: '' }],
  ]) {
    assert.throws(() => taskCheckpoint(directory, { files }, base));
    assert.equal(head(), base);
    assert.equal(readdirSync(directory).some(name => name.startsWith('input-')), false);
  }
  assert.throws(() => taskCheckpoint(directory, snapshot({ app: 'new' }), `${base}\nreset refs/heads/task`));
  assert.equal(head(), base);
});
