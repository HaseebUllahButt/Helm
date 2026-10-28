import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, watch, symlinkSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const oldDependency = "module.exports = 'old dependency';\n";
const root = mkdtempSync(join(tmpdir(), 'helm-update-recovery-'));
process.env.HELM_DIR = join(root, 'state');
mkdirSync(process.env.HELM_DIR);
const { selfUpdate, syncFromBundle, makeBundle, rebuildIfCommitted, rebuildStaleApp } = await import('../packages/connect/src/update.js');
const moduleUrl = new URL('../packages/connect/src/update.js', import.meta.url).href;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const put = (dir, file, text) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), text); };
test.after(() => {
  try { assert.deepEqual(readdirSync(process.env.HELM_DIR), [], 'no recovery snapshots remain'); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture(t) {
  const dir = mkdtempSync(join(root, 'case-'));
  const remote = join(dir, 'remote'), installed = join(dir, 'installed'), bin = join(dir, 'bin');
  mkdirSync(bin);
  git(dir, 'init', '-qb', 'main', remote);
  git(remote, 'config', 'user.email', 'test@example.invalid');
  git(remote, 'config', 'user.name', 'test');
  put(remote, '.gitignore', 'node_modules/\ndist/\n');
  put(remote, 'v', 'old source');
  put(remote, 'package-lock.json', '{}');
  put(remote, 'apps/web/package.json', '{"name":"@helm/web"}');
  git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'old');
  git(dir, 'clone', '-q', remote, installed);
  const previous = git(installed, 'rev-parse', 'HEAD');
  put(installed, 'node_modules/old/index.js', oldDependency);
  mkdirSync(join(installed, 'node_modules/.bin'));
  symlinkSync('../old/index.js', join(installed, 'node_modules/.bin/old'));
  put(installed, 'apps/web/node_modules/nested/index.js', 'old nested dependency');
  put(installed, 'apps/web/dist/index.html', 'old app');
  put(installed, 'apps/web/dist/assets/old.js', 'old asset');
  put(remote, 'v', 'new source'); put(remote, 'package-lock.json', '{"changed":true}');
  git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'new');
  const target = git(remote, 'rev-parse', 'HEAD');
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const npm = body => {
    writeFileSync(join(bin, 'npm'), `#!${process.execPath}\nconst fs = require('node:fs');\n${body}\n`);
    chmodSync(join(bin, 'npm'), 0o755);
  };
  return { installed, remote, previous, target, npm };
}

function assertRestored(dir) {
  assert.equal(readFileSync(join(dir, 'node_modules/old/index.js'), 'utf8'), oldDependency);
  assert.equal(readlinkSync(join(dir, 'node_modules/.bin/old')), '../old/index.js');
  assert.equal(readFileSync(join(dir, 'apps/web/node_modules/nested/index.js'), 'utf8'), 'old nested dependency');
  assert.equal(readFileSync(join(dir, 'apps/web/dist/index.html'), 'utf8'), 'old app');
  assert.equal(readFileSync(join(dir, 'apps/web/dist/assets/old.js'), 'utf8'), 'old asset');
  assert.equal(existsSync(join(dir, 'node_modules/partial')), false);
  assert.equal(existsSync(join(dir, 'apps/web/dist/assets/partial.js')), false);
}
const damage = `
fs.rmSync('node_modules', {recursive:true,force:true});
fs.mkdirSync('node_modules/partial', {recursive:true});
fs.rmSync('apps/web/node_modules', {recursive:true,force:true});
fs.rmSync('apps/web/dist', {recursive:true,force:true});
fs.mkdirSync('apps/web/dist/assets', {recursive:true});
fs.writeFileSync('apps/web/dist/index.html', 'broken app');
fs.writeFileSync('apps/web/dist/assets/partial.js', 'partial');
`;

test('a failed install restores installed dependencies and app files', async t => {
  const f = fixture(t);
  mkdirSync(join(f.installed, 'apps/.cache')); // A hidden folder must not block the restore.
  f.npm(`${damage}\nprocess.exit(1);`);
  await assert.rejects(selfUpdate(f.installed, { restart: false }), /Command failed/);
  assert.equal(git(f.installed, 'rev-parse', 'HEAD'), f.previous);
  assertRestored(f.installed);
  assert.equal(existsSync(join(process.env.HELM_DIR, 'update-state.json')), false);
});

test('a failed bundle build restores app files and dependencies', async t => {
  const f = fixture(t);
  const { bundle } = await makeBundle({}, f.remote);
  f.npm(`if (process.argv.includes('ci')) { ${damage} } else process.exit(1);`);
  await assert.rejects(syncFromBundle(bundle, f.installed, { restart: false }), /Command failed/);
  assert.equal(git(f.installed, 'rev-parse', 'HEAD'), f.previous);
  assertRestored(f.installed);
});

test('a failed build preserves edits made while the update runs', async t => {
  const f = fixture(t);
  f.npm(`if (process.argv.includes('ci')) { ${damage} } else { fs.writeFileSync('v', 'owner edit'); process.exit(1); }`);
  await assert.rejects(selfUpdate(f.installed, { restart: false }), /Command failed/);
  assert.equal(readFileSync(join(f.installed, 'v'), 'utf8'), 'owner edit');
  assert.equal(git(f.installed, 'rev-parse', 'HEAD'), f.target);
  assertRestored(f.installed);
});

test('a failed rebuild keeps the owner commit and restores the installed app', async t => {
  const f = fixture(t);
  git(f.installed, 'fetch', '-q', 'origin'); git(f.installed, 'reset', '--hard', '-q', f.target);
  f.npm(`if (process.argv.includes('ci')) { ${damage} } else process.exit(1);`);
  await assert.rejects(rebuildIfCommitted(f.previous, f.installed, { restart: false }), /Command failed/);
  assert.equal(git(f.installed, 'rev-parse', 'HEAD'), f.target);
  assertRestored(f.installed);
});

test('a failed stale app build restores the served app', async t => {
  const f = fixture(t);
  put(f.installed, 'apps/web/dist/build.json', JSON.stringify({ commit: f.target }));
  await assert.rejects(rebuildStaleApp(f.previous, f.installed, { build: async () => {
    rmSync(join(f.installed, 'apps/web/dist'), { recursive: true });
    throw Error('failed stale build');
  } }), /failed stale build/);
  assertRestored(f.installed);
});

test('an interrupted install restores files before a failed retry can fetch', async t => {
  const f = fixture(t);
  // npm kills only its private updater after it damages the installed files.
  f.npm(`${damage}\nfs.writeFileSync(${JSON.stringify(join(f.installed, 'damaged'))}, 'ready');\nprocess.kill(process.ppid, 'SIGKILL');`);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `const { selfUpdate } = await import(${JSON.stringify(moduleUrl)}); await selfUpdate(${JSON.stringify(f.installed)}, {restart:false});`],
    { env: process.env, stdio: 'pipe' });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.equal(existsSync(join(f.installed, 'damaged')), true);
  rmSync(join(f.installed, 'damaged'));
  git(f.installed, 'remote', 'set-url', 'origin', join(root, 'missing-remote'));
  await assert.rejects(selfUpdate(f.installed, { restart: false }), /fetch/);
  assert.equal(git(f.installed, 'rev-parse', 'HEAD'), f.previous);
  assertRestored(f.installed);
});

test('a successful retry keeps the new app and removes recovery copies', async t => {
  const f = fixture(t);
  f.npm(`${damage}\nprocess.exit(1);`);
  await assert.rejects(selfUpdate(f.installed, { restart: false }), /Command failed/);
  f.npm(`${damage}\nfs.writeFileSync('apps/web/dist/index.html', 'new app');`);
  assert.equal((await selfUpdate(f.installed, { restart: false })).updated, true);
  assert.equal(git(f.installed, 'rev-parse', 'HEAD'), f.target);
  assert.equal(readFileSync(join(f.installed, 'apps/web/dist/index.html'), 'utf8'), 'new app');
  assert.deepEqual(readdirSync(process.env.HELM_DIR), []);
});

test('a failed first install removes incomplete files that had no previous copy', async t => {
  const f = fixture(t);
  for (const file of ['node_modules', 'apps/web/node_modules', 'apps/web/dist']) {
    rmSync(join(f.installed, file), { recursive: true });
  }
  f.npm(`${damage}\nprocess.exit(1);`);
  await assert.rejects(selfUpdate(f.installed, { restart: false }), /Command failed/);
  for (const file of ['node_modules', 'apps/web/node_modules', 'apps/web/dist']) {
    assert.equal(existsSync(join(f.installed, file)), false);
  }
});

test('an interrupted owner build retries even when its commit is already running', async t => {
  const f = fixture(t);
  git(f.installed, 'fetch', '-q', 'origin'); git(f.installed, 'reset', '--hard', '-q', f.target);
  f.npm(`${damage}\nprocess.kill(process.ppid, 'SIGKILL');`);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `const { rebuildIfCommitted } = await import(${JSON.stringify(moduleUrl)}); await rebuildIfCommitted(${JSON.stringify(f.previous)}, ${JSON.stringify(f.installed)}, {restart:false});`],
    { env: process.env, stdio: 'pipe' });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  f.npm(`fs.writeFileSync('apps/web/dist/index.html', 'rebuilt app');`);
  assert.equal((await rebuildIfCommitted(f.target, f.installed, { restart: false })).updated, true);
  assert.equal(git(f.installed, 'rev-parse', 'HEAD'), f.target);
  assert.equal(readFileSync(join(f.installed, 'apps/web/dist/index.html'), 'utf8'), 'rebuilt app');
});

test('real npm removes old packages during install and recovery restores them', async t => {
  const f = fixture(t);
  put(f.remote, 'package.json', JSON.stringify({ name: 'update-fixture', private: true, workspaces: ['apps/*'] }));
  put(f.remote, 'apps/web/package.json', JSON.stringify({
    name: '@helm/web', version: '1.0.0', scripts: { build: 'node build.cjs' },
  }));
  put(f.remote, 'apps/web/build.cjs', `
const fs = require('node:fs');
fs.rmSync('dist', {recursive:true,force:true});
fs.mkdirSync('dist'); fs.writeFileSync('dist/index.html', 'broken');
process.exit(1);
`);
  rmSync(join(f.remote, 'package-lock.json'));
  const lock = () => execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: f.remote, stdio: 'pipe' });
  lock(); git(f.remote, 'add', '.'); git(f.remote, 'commit', '-qm', 'workspace baseline');
  git(f.installed, 'fetch', '-q', 'origin'); git(f.installed, 'reset', '--hard', '-q', 'origin/main');
  const before = git(f.installed, 'rev-parse', 'HEAD');
  put(f.remote, 'apps/web/package.json', JSON.stringify({
    name: '@helm/web', version: '2.0.0', scripts: { build: 'node build.cjs' },
  }));
  lock(); git(f.remote, 'add', '.'); git(f.remote, 'commit', '-qm', 'new workspace');
  await assert.rejects(selfUpdate(f.installed, { restart: false }), /--workspace @helm\/web run build/);
  assert.equal(git(f.installed, 'rev-parse', 'HEAD'), before);
  assert.equal(git(f.installed, 'status', '--porcelain'), '');
  assertRestored(f.installed);
});

test('a failed update leaves an existing agent running with restored dependencies', async t => {
  const f = fixture(t);
  const agent = spawn(process.execPath, ['-e', `
process.on('message', () => process.send(require('./node_modules/old')));
process.send('ready');
`], { cwd: f.installed, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => {
    if (agent.exitCode === null && agent.signalCode === null) {
      const exited = once(agent, 'exit'); agent.kill(); await exited;
    }
  });
  assert.equal((await once(agent, 'message'))[0], 'ready');
  const serviceCalls = join(f.installed, 'service-calls');
  put(join(f.installed, '..', 'bin'), 'systemctl', `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(serviceCalls)}, 'called');`);
  chmodSync(join(f.installed, '..', 'bin', 'systemctl'), 0o755);
  f.npm(`${damage}\nprocess.exit(1);`);
  await assert.rejects(selfUpdate(f.installed), /Command failed/);
  assert.equal(existsSync(serviceCalls), false, 'failure does not restart services');
  const reply = once(agent, 'message'); agent.send('read');
  assert.equal((await reply)[0], 'old dependency');
  assert.equal(agent.exitCode, null);
});

test('edits made while copying installed files stop the update before source moves', async t => {
  const f = fixture(t);
  f.npm('process.exit(0);');
  const watcher = watch(process.env.HELM_DIR, (_event, name) => {
    if (String(name).startsWith('update-backup-')) put(f.installed, 'v', 'owner edit during backup');
  });
  t.after(() => watcher.close());
  await assert.rejects(selfUpdate(f.installed, { restart: false }), /files changed during the update/);
  assert.equal(git(f.installed, 'rev-parse', 'HEAD'), f.previous);
  assert.equal(readFileSync(join(f.installed, 'v'), 'utf8'), 'owner edit during backup');
  assertRestored(f.installed);
});
