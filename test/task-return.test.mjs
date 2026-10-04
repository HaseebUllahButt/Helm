import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
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
