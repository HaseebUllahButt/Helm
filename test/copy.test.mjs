import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readlinkSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';


const root = mkdtempSync(join(tmpdir(), 'helm-copy-'));
Object.assign(process.env, { HELM_DIR: join(root,'state'), HELM_DB: join(root,'hub.sqlite'), HELM_SSH_DIR: join(root,'ssh'), HELM_PROCS_SOCKET: join(root,'procs.sock'), HELM_TERMINALS_SOCKET: join(root,'terminals.sock') });
const { parseCopyArgs, copySpec, copyTarget, rsyncPath, copySshShell } = await import('../packages/connect/src/copy.js');
test.after(() => rmSync(root, { force: true, recursive: true }));
const net = { self: 'a', machines: { b: { id: 'b', name: 'target', sshUser: 'tester' } }, revoked: {} };

test('copy rejects ambiguous arguments before any connection', () => {
  for (const args of [[], ['target'], ['target','src','--target-folder'],
    ['target','src','--target-folder','/tmp/x','--delete'], ['target','src','--target-folder','/tmp/x','--target-folder','/tmp/y']]) {
    assert.throws(() => parseCopyArgs(args));
  }
  assert.equal(parseCopyArgs(['target','src']).targetFolder, undefined);
  assert.equal(parseCopyArgs(['target','src','--target-folder','/']).targetFolder, '/');
  const options = parseCopyArgs(['target',root,'--target-folder','/tmp/a b','--exclude','.cache','--exclude','node_modules','--dry-run']);
  assert.equal(options.dryRun, true);
  assert.deepEqual(options.excludes, ['.cache','node_modules']);
  assert.throws(() => copySpec(options, { ...net, revoked: { b: 1 } }), /current machine/);
  assert.throws(() => copySpec({ ...options, machine: 'unknown' }, net), /exact machine/);
});

test('a copy lands in the same place by default, and ~ or relative targets mean the other home', () => {
  const home = homedir();
  assert.equal(copyTarget(undefined, join(home, 'dev', 'app'), true), '~/dev/app');
  assert.equal(copyTarget(undefined, join(home, 'notes.txt'), false), '~');
  assert.equal(copyTarget(undefined, '/srv/data', true), '/srv/data');
  assert.equal(copyTarget('dev/app/', '/x', true), '~/dev/app');
  assert.equal(copyTarget('~/dev', '/x', true), '~/dev');
  assert.equal(copyTarget('/', '/x', true), '/');
  assert.equal(rsyncPath('~'), '.');
  assert.equal(rsyncPath('~/dev/app'), 'dev/app');
  assert.equal(rsyncPath('/srv'), '/srv');
  const spec = copySpec({ machine: 'target', source: root, targetFolder: '~/dev', excludes: [], mode: 'ssh' }, net);
  assert.equal(spec.args.at(-1), 'tester@target:dev/');
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
  const options = { machine: 'target', folder: source, targetFolder: dest, excludes: ['.cache'], dryRun: true, mode: 'ssh' };
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


test('rsync and OpenSSH launch the exact ProxyCommand with spaces and apostrophes', () => {
  const folder = join(root, "proxy ' path"); mkdirSync(folder);
  const node = join(folder, "node ' executable"); symlinkSync(process.execPath, node);
  const marker = join(root, 'proxy-launched.json');
  const bin = join(folder, "helm ' entry.mjs");
  writeFileSync(bin, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`);
  const spec = copySpec({ machine:'target', source:root, excludes:[], mode:'ssh', targetFolder:'/unused' }, net);
  spec.args[spec.args.indexOf('-e')+1] = copySshShell(net.machines.b, { node, bin, key:join(root,'no-key'), knownHosts:join(root,'hosts') });
  const result = spawnSync('rsync', spec.args, {encoding:'utf8',timeout:5000});
  assert.notEqual(result.status,0, 'the fixture deliberately provides no SSH server');
  assert.deepEqual(JSON.parse(readFileSync(marker,'utf8')), ['proxy','target','22']);
  assert.doesNotMatch(result.stderr,/node.*No such file|Syntax error/);
});
