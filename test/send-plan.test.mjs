import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, lstatSync, readFileSync, rmSync, symlinkSync, chmodSync, renameSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { scanSend } from '../packages/connect/src/send-plan.js';
import { BULK_SKIP_DIRS } from '../packages/connect/src/bulk-transfer.js';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'helm-send-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, path, body = path) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function mocks(t) {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
// Serial metadata traversal matches the original ordering and selection rules.
function reference(root, { allowed = null, includeEnv = true } = {}) {
  const selected = [], envFiles = [], left = []; let bytes = 0;
  const leave = (path, why) => { if (left.length < 40) left.push({ path, why }); };
  function walk(p, inGit = false) {
    const s = lstatSync(join(root, p));
    if (s.isDirectory()) {
      if (!inGit && !allowed && BULK_SKIP_DIRS.includes(basename(p))) return leave(p, 'dependency or cache folder');
      for (const name of readdirSync(join(root, p))) walk(p ? `${p}/${name}` : name, inGit || p === '.git');
    } else {
      if (allowed && !inGit && !allowed.has(p)) return leave(p, 'ignored by Git');
      if (!inGit && /^\.env/i.test(basename(p))) {
        envFiles.push(p);
        if (!includeEnv) return leave(p, 'environment file excluded');
      }
      selected.push(p); bytes += s.size;
    }
  }
  if (allowed) {
    walk('.git', true);
    for (const p of allowed) { try { walk(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    leave('(Git ignored files)', 'build output and caches ignored by Git');
  } else walk('');
  return { files: selected.length, bytes, envFiles, left, selected };
}
function compare(plan, expected) {
  for (const key of ['files', 'bytes', 'envFiles', 'left']) assert.deepEqual(plan[key], expected[key], key);
}

test('nested trees preserve serial counts, env order, skip order and symlink sizes', async t => {
  const root = fixture(t);
  put(root, 'a/.ENVrc'); put(root, 'a/b/c/data', 'hello'); put(root, 'a/node_modules/hidden');
  put(root, '.env'); put(root, '.environment'); put(root, 'z/.env.local');
  mkdirSync(join(root, 'empty'));
  for (let i = 0; i < 45; i++) put(root, `skip${String(i).padStart(2, '0')}/.cache/data`);
  symlinkSync('a', join(root, 'directory-link')); symlinkSync('missing', join(root, 'broken'));
  for (const includeEnv of [true, false]) {
    const plan = await scanSend(root, { includeEnv });
    compare(plan, reference(root, { includeEnv }));
    assert.equal(plan.left.length, 40);
    assert.deepEqual(plan.excludes, [...BULK_SKIP_DIRS.map(n => `${n}/`), ...(!includeEnv ? ['.[eE][nN][vV]*'] : [])]);
    assert.equal(plan.filterFile, null);
  }
});

test('parallel scans use independent workers, directory entries and no file body reads', async t => {
  const roots = [fixture(t), fixture(t)];
  for (const root of roots) for (let i = 0; i < 70; i++) put(root, `d${i}/nested/f`, 'abc');
  const expected = roots.map(root => reference(root));
  mocks(t);
  const original = fs.lstat, readDirectory = fs.readdir;
  const active = [0, 0], peak = [0, 0], calls = [[], []];
  t.mock.method(fs, 'lstat', async path => {
    const i = roots.findIndex(root => String(path).startsWith(root));
    if (i < 0) return original(path);
    calls[i].push(String(path)); active[i]++; peak[i] = Math.max(peak[i], active[i]);
    try { await delay(String(path).includes('d1/') ? 15 : 2); return await original(path); }
    finally { active[i]--; }
  });
  t.mock.method(fs, 'readdir', async (path, options) => {
    assert.equal(options.withFileTypes, true);
    return readDirectory(path, options);
  });
  for (const method of ['readFile', 'open']) t.mock.method(fs, method, () => { throw new Error('must not read file bodies'); });
  syncBuiltinESMExports();
  const plans = await Promise.all(roots.map(root => scanSend(root)));
  plans.forEach((plan, i) => {
    compare(plan, expected[i]);
    assert.ok(peak[i] > 1, `scan ${i} must overlap reads`);
    assert.ok(peak[i] <= 32, `scan ${i} must bound filesystem work`);
    assert.equal(calls[i].length, 213, 'check the root twice, the Git marker, and each child once');
    assert.equal(active[i], 0);
  });
});

test('Git selection and literal filters match serial behavior, including vanished and ignored env files', async t => {
  const root = fixture(t), filterFile = join(fixture(t), 'filters', 'send');
  git(root, 'init', '-q');
  put(root, '.gitignore', 'cache/\n.env*\nnode_modules/\n');
  put(root, 'tracked', 'old'); put(root, 'vanished');
  git(root, 'add', '.'); rmSync(join(root, 'vanished'));
  put(root, 'tracked', 'changed'); put(root, '.env.secret'); put(root, 'cache/.ENVlocal');
  put(root, 'node_modules/.env.hidden'); put(root, 'cache/ignored');
  put(root, 'odd[*?]\\dir/file[?]*\\'); put(root, 'new/deep/file');
  symlinkSync('missing', join(root, 'broken'));
  // .git contents bypass both env and dependency exclusions.
  put(root, '.git/node_modules/.env.internal');
  const allowed = new Set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean));
  for (const p of git(root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard').split('\0')) {
    if (/^\.env/i.test(basename(p)) && !p.split('/').some(n => BULK_SKIP_DIRS.includes(n))) allowed.add(p);
  }
  for (const includeEnv of [true, false]) {
    const expected = reference(root, { allowed, includeEnv });
    const plan = await scanSend(root, { includeEnv, filterFile });
    compare(plan, expected); assert.equal(plan.git.dirty, true); assert.deepEqual(plan.excludes, []);
    const dirs = new Set();
    for (const p of expected.selected) for (let d = dirname(p); d !== '.'; d = dirname(d)) dirs.add(d);
    const literal = p => p.replace(/[\\*?\[\]]/g, '\\$&');
    const filter = [...[...dirs].sort().map(p => `+ /${literal(p)}/`), ...expected.selected.sort().map(p => `+ /${literal(p)}`), '- *', ''].join('\0');
    assert.equal(readFileSync(filterFile, 'utf8'), filter);
    assert.equal(lstatSync(filterFile).mode & 0o777, 0o600);
  }
});

test('errors keep serial precedence and drain all filesystem workers', async t => {
  const root = fixture(t); put(root, 'a/first'); put(root, 'z/second');
  mocks(t); const original = fs.lstat; let active = 0;
  t.mock.method(fs, 'lstat', async path => {
    if (path === root || path === join(root, '.git') || path === join(root, 'a') || path === join(root, 'z')) return original(path);
    active++;
    try { await delay(String(path).includes('/a/') ? 20 : 1); throw Object.assign(new Error(String(path)), { code: 'EACCES' }); }
    finally { active--; }
  });
  syncBuiltinESMExports();
  await assert.rejects(scanSend(root), { code: 'EACCES', message: join(root, 'a/first') });
  assert.equal(active, 0);
});

test('missing roots and unreadable directories fail', async t => {
  const root = fixture(t); put(root, 'dir/data');
  mocks(t); const original = fs.readdir;
  t.mock.method(fs, 'readdir', async (path, options) => {
    if (path === join(root, 'dir')) throw Object.assign(new Error('directory denied'), { code: 'EACCES' });
    return original(path, options);
  });
  syncBuiltinESMExports();
  await assert.rejects(scanSend(root), { code: 'EACCES' });
  await assert.rejects(scanSend(join(root, 'missing')), { code: 'ENOENT' });
});

test('vanished Git paths are skipped, but other Git errors and missing history fail', async t => {
  const root = fixture(t); git(root, 'init', '-q');
  put(root, 'a'); put(root, 'b'); git(root, 'add', '.');
  const baseline = await scanSend(root);
  mocks(t); const original = fs.lstat;
  let failedPath = join(root, 'a'), code = 'ENOENT';
  t.mock.method(fs, 'lstat', async path => {
    if (path === failedPath) throw Object.assign(new Error('metadata failed'), { code });
    return original(path);
  });
  syncBuiltinESMExports();
  const vanished = await scanSend(root);
  assert.equal(vanished.files, baseline.files - 1);
  assert.equal(vanished.bytes, baseline.bytes - 1);
  code = 'EACCES';
  await assert.rejects(scanSend(root), { code: 'EACCES' });
  failedPath = join(root, '.git', 'HEAD'); code = 'ENOENT';
  await assert.rejects(scanSend(root), { code: 'ENOENT' });
  const plain = fixture(t); put(plain, 'data'); failedPath = join(plain, 'data');
  await assert.rejects(scanSend(plain), { code: 'ENOENT' });
});

test('delayed metadata keeps environment and capped exclusion lists in traversal order', async t => {
  const root = fixture(t);
  for (let i = 0; i < 60; i++) put(root, `d${String(i).padStart(2, '0')}/.env.local`);
  const expected = reference(root, { includeEnv: false });
  mocks(t); const original = fs.lstat;
  t.mock.method(fs, 'lstat', async path => {
    if (String(path).includes('/d00/')) await delay(30);
    return original(path);
  });
  syncBuiltinESMExports();
  compare(await scanSend(root, { includeEnv: false }), expected);
});

test('single files keep counts and env exclusion; symlink roots and special files are refused', async t => {
  const root = fixture(t); put(root, '.ENVrc', 'secret');
  assert.equal((await scanSend(join(root, '.ENVrc'))).bytes, 6);
  const excluded = await scanSend(join(root, '.ENVrc'), { includeEnv: false });
  assert.equal(excluded.files, 0); assert.deepEqual(excluded.envFiles, ['.ENVrc']);
  symlinkSync('.ENVrc', join(root, 'link'));
  await assert.rejects(scanSend(join(root, 'link')), /regular file or folder/);
  execFileSync('mkfifo', [join(root, 'pipe')]);
  await assert.rejects(scanSend(root), /cannot send special file: pipe/);
});

test('Git submodules and linked worktrees remain refused', async t => {
  const root = fixture(t); git(root, 'init', '-q'); put(root, 'data'); git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture');
  const worktree = join(fixture(t), 'linked');
  git(root, 'worktree', 'add', '-q', '--detach', worktree);
  await assert.rejects(scanSend(worktree), /linked Git worktrees/);
  mkdirSync(join(root, 'sub')); put(root, 'sub/data');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${git(root, 'rev-parse', 'HEAD').trim()},sub`);
  await assert.rejects(scanSend(root), /Git submodule sub needs a standalone copy/);
});


test('queued directories replaced by symbolic links are not traversed', async t => {
  const root = fixture(t), outside = fixture(t);
  put(root, 'child/original'); put(outside, 'must-not-send');
  mocks(t); const original = fs.readdir; let replaced = false;
  t.mock.method(fs, 'readdir', async (path, options) => {
    const entries = await original(path, options);
    if (path === root && !replaced) {
      replaced = true;
      rmSync(join(root, 'child'), { recursive: true });
      symlinkSync(outside, join(root, 'child'));
    }
    assert.notEqual(path, join(root, 'child'), 'do not read the symbolic link target');
    return entries;
  });
  syncBuiltinESMExports();
  const plan = await scanSend(root);
  assert.equal(replaced, true);
  assert.equal(plan.files, 1);
  assert.equal(plan.bytes, lstatSync(join(root, 'child')).size);
});

test('Git metadata failures after root detection do not fall back to directory scanning', async t => {
  const root = fixture(t); git(root, 'init', '-q'); put(root, 'tracked'); git(root, 'add', '.');
  mocks(t); const original = fs.lstat;
  t.mock.method(fs, 'lstat', async path => {
    if (path === join(root, '.git')) throw Object.assign(new Error('Git metadata denied'), { code: 'EACCES' });
    return original(path);
  });
  syncBuiltinESMExports();
  await assert.rejects(scanSend(root), { code: 'EACCES' });
});

test('failures in either Git file list or status reject without writing a partial filter', async t => {
  const root = fixture(t), bin = fixture(t), filterFile = join(fixture(t), 'filter');
  git(root, 'init', '-q'); put(root, 'tracked'); git(root, 'add', '.');
  put(root, '.gitignore', 'cache/\n'); put(root, 'cache/private');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  process.env.PATH = `${bin}:${savedPath}`;
  for (const failedFlag of ['--cached', '--ignored', '--porcelain']) {
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes(${JSON.stringify(failedFlag)})) { process.stderr.write('fixture Git failure'); process.exit(73); }
const { spawnSync } = require('node:child_process');
const child = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(child.status ?? 1);
`);
    chmodSync(join(bin, 'git'), 0o700);
    await assert.rejects(scanSend(root, { filterFile }), /fixture Git failure/);
    assert.throws(() => lstatSync(filterFile), { code: 'ENOENT' });
  }
});


test('failed Git detection with a Git marker cannot include ignored files through fallback', async t => {
  const root = fixture(t), bin = fixture(t), filterFile = join(fixture(t), 'filter');
  git(root, 'init', '-q'); put(root, '.gitignore', 'private/\n'); put(root, 'private/secret');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; });
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('rev-parse')) { process.stderr.write('fixture root detection failed'); process.exit(73); }
const { spawnSync } = require('node:child_process');
process.exit(spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1);
`);
  chmodSync(join(bin, 'git'), 0o700);
  process.env.PATH = `${bin}:${savedPath}`;
  await assert.rejects(scanSend(root, { filterFile }), /fixture root detection failed/);
  assert.throws(() => lstatSync(filterFile), { code: 'ENOENT' });
  // A linked worktree or broken .git file also blocks fallback.
  rmSync(join(root, '.git'), { recursive: true }); put(root, '.git', 'gitdir: missing');
  await assert.rejects(scanSend(root, { filterFile }), /fixture root detection failed/);
});

test('queued inspection rejects changed source kinds and symbolic links before writing filters', async t => {
  const cases = [
    { initial: 'folder', replacement: 'link' },
    { initial: 'folder', replacement: 'file' },
    { initial: 'file', replacement: 'folder' },
    { initial: 'file', replacement: 'link' },
    { initial: 'git', replacement: 'link' },
  ];
  for (const { initial, replacement } of cases) {
    await t.test(`${initial} becomes ${replacement}`, async t => {
      const parent = fixture(t), root = join(parent, 'source'), outside = fixture(t);
      const filterFile = join(parent, 'filter');
      if (initial === 'file') writeFileSync(root, 'file');
      else { mkdirSync(root); put(root, 'data'); }
      if (initial === 'git') git(root, 'init', '-q');
      mocks(t); const original = fs.lstat; let checks = 0;
      t.mock.method(fs, 'lstat', async path => {
        if (path === root && ++checks === 2) {
          if (initial === 'git') {
            // Keep the confirmed Git paths readable, but replace the root.
            rmSync(outside, { recursive: true });
            renameSync(root, outside);
          } else rmSync(root, { recursive: true });
          if (replacement === 'link') symlinkSync(outside, root);
          else if (replacement === 'folder') mkdirSync(root);
          else writeFileSync(root, 'replacement');
        }
        return original(path);
      });
      syncBuiltinESMExports();
      await assert.rejects(scanSend(root, { filterFile }), /The source changed/);
      assert.throws(() => lstatSync(filterFile), { code: 'ENOENT' });
    });
  }
});
