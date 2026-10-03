import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCopyArgs, copySpec } from '../packages/connect/src/copy.js';

const root = mkdtempSync(join(tmpdir(), 'helm-copy-'));
test.after(() => rmSync(root, { force: true, recursive: true }));
const net = { self: 'a', machines: { b: { id: 'b', name: 'target', sshUser: 'tester' } }, revoked: {} };

test('copy rejects ambiguous and unsafe arguments before any connection', () => {
  for (const args of [[], ['target','src'], ['target','src','--target-folder'],
    ['target','src','--target-folder','/'], ['target','src','--target-folder','relative'],
    ['target','src','--target-folder','/tmp/x','--delete'], ['target','src','--target-folder','/tmp/x','--target-folder','/tmp/y']]) {
    assert.throws(() => parseCopyArgs(args));
  }
  const options = parseCopyArgs(['target',root,'--target-folder','/tmp/a b','--exclude','.cache','--exclude','node_modules','--dry-run']);
  assert.equal(options.dryRun, true);
  assert.deepEqual(options.excludes, ['.cache','node_modules']);
  assert.throws(() => copySpec(options, { ...net, revoked: { b: 1 } }), /current machine/);
  assert.throws(() => copySpec({ ...options, machine: 'unknown' }, net), /exact machine/);
});

test('streamed full copy preserves hidden files, symlinks and modes; repeat copies preserve unrelated files', t => {
  if (spawnSync('rsync', ['--version']).status !== 0) return t.skip('rsync unavailable');
  const source = join(root, 'source'); const dest = join(root, 'destination with spaces');
  mkdirSync(source); mkdirSync(dest);
  writeFileSync(join(source, '.env'), 'private-test-value', { mode: 0o600 });
  writeFileSync(join(source, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(source, 'binary'), Buffer.alloc(1024 * 1024, 123));
  mkdirSync(join(source, '.cache')); writeFileSync(join(source, '.cache', 'ignored'), 'cache');
  symlinkSync('run.sh', join(source, 'link'));
  writeFileSync(join(dest, 'keep'), 'unrelated');
  const shell = join(root, 'local-remote');
  writeFileSync(shell, '#!/bin/sh\nwhile [ "$1" != rsync ]; do shift; done\nexec "$@"\n', { mode: 0o700 });
  const options = { machine: 'target', folder: source, targetFolder: dest, excludes: ['.cache'], dryRun: true };
  const run = () => {
    const spec = copySpec(options, net);
    spec.args[spec.args.indexOf('-e') + 1] = shell;
    return spawnSync(spec.command, spec.args, { encoding: 'utf8', timeout: 10000 });
  };
  let result = run(); assert.equal(result.status, 0, result.stderr);
  assert.throws(() => statSync(join(dest, '.env')));
  options.dryRun = false;
  mkdirSync(join(dest, '.helm-transfer-partial'));
  writeFileSync(join(dest, '.helm-transfer-partial', 'binary'), Buffer.alloc(512 * 1024, 123));
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Matched data: [1-9][0-9,]* bytes/);
  assert.equal(readFileSync(join(dest, '.env'), 'utf8'), 'private-test-value');
  assert.equal(statSync(join(dest, '.env')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dest, 'run.sh')).mode & 0o777, 0o755);
  assert.equal(readlinkSync(join(dest, 'link')), 'run.sh');
  assert.throws(() => statSync(join(dest, '.cache')));
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Number of regular files transferred: 0/);
  assert.equal(readFileSync(join(dest, 'keep'), 'utf8'), 'unrelated');
});
