import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, readdirSync, cpSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { binaryPath } from '../native/log-index/build-id.mjs';
import { buildLogReader } from '../scripts/build-log-reader.mjs';

const { available } = await buildLogReader({ log: () => {} });

const root = mkdtempSync(join(tmpdir(), 'helm-discovery-test-'));
process.env.HOME = join(root, 'home');
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_SSH_DIR = join(root, 'ssh');
mkdirSync(process.env.HOME);
test.after(() => rmSync(root, { recursive: true, force: true }));
const native = available ? createRequire(import.meta.url)(binaryPath()) : null;
const nativeTest = (name, run) => test(name, { skip: !native || process.platform !== 'linux' }, run);
const { processList } = await import('../packages/connect/src/procinfo.js');

function jsProcesses(path) {
  let names;
  try { names = readdirSync(path).filter(x => /^\d+$/.test(x)); } catch { return []; }
  return names.flatMap(name => {
    try {
      const argv = readFileSync(join(path, String(Number(name)), 'cmdline'), 'utf8').split('\0').filter(Boolean);
      return argv.length ? [{ pid: Number(name), argv }] : [];
    } catch { return []; }
  });
}

const proc = join(root, 'proc');
mkdirSync(proc);
for (const [pid, bytes] of [
  ['20', Buffer.from('node\0two words\0اردو 😀\0')],
  ['3', Buffer.from([0x61, 0, 0, 0xf0, 0x80, 0xff, 0, 0xe2, 0x82])],
  ['10', Buffer.from('')], ['5', Buffer.from('\0\0')],
  ['not-a-pid', Buffer.from('ignored')],
]) {
  mkdirSync(join(proc, pid)); writeFileSync(join(proc, pid, 'cmdline'), bytes);
}
mkdirSync(join(proc, '80')); // vanished cmdline
mkdirSync(join(proc, '90/cmdline'), { recursive: true }); // unreadable as a file

nativeTest('Linux process batches preserve argument boundaries, ordering, bad bytes and missing files', () => {
  assert.deepEqual(native.discoveryProcessList(proc), jsProcesses(proc));
  assert.deepEqual(processList(proc), jsProcesses(proc));
  assert.deepEqual(processList(join(root, 'absent')), []);
  assert.deepEqual(processList(join(proc, '20/cmdline')), []);
});

nativeTest('unusual numeric names return to the Number conversion in JavaScript', () => {
  for (const name of ['0003', '9999999999999999999999999999999999']) mkdirSync(join(proc, name));
  assert.equal(native.discoveryProcessList(proc), null);
  assert.deepEqual(processList(proc), jsProcesses(proc));
});

const home = process.env.HOME;
for (const path of ['dev/اردو 😀/.git', 'dev/plain', 'dev/worktree', 'dev/linked-repo', 'dev/𐀀', 'dev/\ue000',
  'node_modules/hidden-child', '.hidden/no', '.config/editor/lua/too-deep', 'deep']) mkdirSync(join(home, path), { recursive: true });
writeFileSync(join(home, 'dev/worktree/.git'), 'gitdir: private-fixture');
symlinkSync(join(home, 'dev/اردو 😀/.git'), join(home, 'dev/linked-repo/.git'));
symlinkSync(join(home, 'dev'), join(home, 'linked-directory'));
writeFileSync(join(home, '.env'), 'PRIVATE_FIXTURE=1');
let deep = join(home, 'deep');
for (let i = 0; i < 13; i++) { deep = join(deep, `level-${i}`); mkdirSync(deep); }

function invoke(mode, code, cwd) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd, encoding: 'utf8', env: { ...process.env, HELM_LOG_READER: mode,
      HELM_DIR: join(root, `state-${mode}`), HELM_SSH_DIR: join(root, 'ssh') },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
const folderCode = `
  const fs = await import('./packages/connect/src/fs.js');
  await fs.warmIndex();
  const result = { list: await fs.list('~'), dev: await fs.list('~/dev'), search: await fs.search('dev') };
  const index = await fs.folderIndex();
  result.paths = index.names.map((name, i) => {
    const parts = [name];
    for (let p = index.parents[i]; p >= 0; p = index.parents[p]) parts.unshift(index.names[p]);
    return { path: parts.join('/'), repo: index.repos.includes(i) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  try { await fs.list('~/does-not-exist'); } catch (e) { result.error = e.code; }
  console.log(JSON.stringify(result));
`;

nativeTest('folder listing and walking preserve Unicode, pruning, repos, symlinks, depth and errors', async () => {
  assert.deepEqual(invoke('rust', folderCode), invoke('javascript', folderCode));
  const snapshot = await native.discoveryReadDirectory(home);
  assert.equal(snapshot.count, readdirSync(home).length);
  assert.ok(!snapshot.entries.some(d => d.name === 'linked-directory'));
  assert.equal(await native.discoveryReadDirectory(join(home, 'absent')), null);
});


nativeTest('folders and process files that cannot be read retain JavaScript recovery', async () => {
  const locked = join(home, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0);
  const hiddenProc = join(root, 'hidden-proc');
  mkdirSync(join(hiddenProc, '1'), { recursive: true });
  const cmdline = join(hiddenProc, '1/cmdline');
  writeFileSync(cmdline, 'private-fixture');
  chmodSync(cmdline, 0);
  try {
    assert.deepEqual(native.discoveryProcessList(hiddenProc), jsProcesses(hiddenProc));
    assert.deepEqual(processList(hiddenProc), jsProcesses(hiddenProc));
    assert.deepEqual(invoke('rust', folderCode), invoke('javascript', folderCode));
  } finally { chmodSync(locked, 0o700); chmodSync(cmdline, 0o600); }
});

nativeTest('bad filename bytes use the existing JavaScript path', async () => {
  const bad = Buffer.concat([Buffer.from(home + '/'), Buffer.from([0xff])]);
  mkdirSync(bad);
  assert.equal(await native.discoveryReadDirectory(home), null);
  assert.deepEqual(invoke('rust', folderCode), invoke('javascript', folderCode));
  rmSync(bad, { recursive: true });
});

test('missing, stale, incompatible and incomplete binaries retain the JavaScript results', () => {
  const checkout = join(root, 'fallback');
  mkdirSync(join(checkout, 'packages/connect/src'), { recursive: true });
  mkdirSync(join(checkout, 'native/log-index'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), '{"type":"module"}');
  for (const name of ['procinfo.js', 'fs.js', 'paths.js', 'discovery-native.js', 'log-index-native.js']) {
    cpSync(new URL(`../packages/connect/src/${name}`, import.meta.url), join(checkout, 'packages/connect/src', name));
  }
  for (const name of ['build-id.mjs', 'Cargo.toml', 'Cargo.lock', 'build.rs', 'src']) {
    cpSync(new URL(`../native/log-index/${name}`, import.meta.url), join(checkout, 'native/log-index', name), { recursive: true });
  }
  const output = binaryPath(join(checkout, 'native/log-index'));
  const code = `const {processList}=await import('./packages/connect/src/procinfo.js');\n` +
    `console.log(JSON.stringify(processList(${JSON.stringify(proc)})));`;
  const expected = jsProcesses(proc);
  assert.deepEqual(invoke('rust', code, checkout), expected);
  writeFileSync(output.replace(/\.[^.]+\.node$/, '.old.node'), 'stale build');
  assert.deepEqual(invoke('rust', code, checkout), expected);
  writeFileSync(output, 'incompatible binary');
  assert.deepEqual(invoke('rust', code, checkout), expected);
  const empty = `import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);\n` +
    `require('node:module')._extensions['.node']=(m)=>{m.exports={};};\n`;
  assert.deepEqual(invoke('rust', empty + code, checkout), expected);
  const broken = empty.replace('m.exports={}', `m.exports={discoveryProcessList(){throw Error('fixture')},discoveryReadDirectory(){return Promise.reject(Error('fixture'))}}`);
  assert.deepEqual(invoke('rust', broken + code, checkout), expected);
  assert.deepEqual(invoke('rust', broken + folderCode, checkout), invoke('javascript', folderCode, checkout));
});
