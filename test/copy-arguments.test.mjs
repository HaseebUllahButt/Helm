import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyArguments } from '../packages/connect/src/copy-arguments.js';

const packed = args => Buffer.from(['rsync', ...args, '', ''].join('\0'));

test('copy arguments bind the folder before releasing any bytes, including split delimiters', async () => {
  const gate = new CopyArguments('~/project', { home: '/private/home' });
  const output = [];
  gate.on('data', bytes => output.push(bytes));
  const header = packed(['--mkpath', '--partial-dir', '.helm-transfer-partial', '.', 'project/']);
  for (const byte of header.subarray(0, -1)) gate.write(Buffer.from([byte]));
  assert.equal(output.length, 0);
  const finished = once(gate, 'end');
  gate.end(Buffer.concat([header.subarray(-1), Buffer.from('body')]));
  await finished;
  assert.deepEqual(Buffer.concat(output), Buffer.concat([packed(['--mkpath', '--partial-dir', '.helm-transfer-partial', '.', '/private/home/project/']), Buffer.from('body')]));
});

test('copy arguments reject other folders, remote file options, extra paths and oversized lists', async () => {
  for (const bytes of [
    packed(['.', '/elsewhere']), packed(['--log-file=/elsewhere', '.', '/allowed']),
    packed(['--files-from=/elsewhere', '.', '/allowed']), packed(['.', '/allowed', '/elsewhere']),
    Buffer.alloc(8193, 120), Buffer.from('rsync\0.'),
  ]) {
    const gate = new CopyArguments('/allowed');
    let released = 0;
    gate.on('data', bytes => { released += bytes.length; });
    const error = once(gate, 'error');
    gate.end(bytes);
    await error;
    assert.equal(released, 0);
  }
});

// What rsync 3.5 puts in the stream for a Send job (send-engine.js flags).
const sendArgs = (id, extra = []) => ['--compress-level=1', '--timeout=120', '--checksum-choice=xxh128', '--compress-choice=zstd',
  ...extra, '--stats', '--partial-dir', `.helm-partial-${id}`, '--mkpath'];
const job = 'a'.repeat(24);

test('a Send job passes its own options; deletion only into its private stage', async () => {
  const pass = async (folder, args, options) => {
    const gate = new CopyArguments(folder, options);
    const out = [];
    gate.on('data', (bytes) => out.push(bytes));
    const error = once(gate, 'error').then(([e]) => e);
    gate.end(packed([...args, '.', folder]));
    return Promise.race([once(gate, 'end').then(() => null), error]);
  };
  const stage = `/home/me/app.helm-partial-${job}`;
  assert.equal(await pass(stage, sendArgs(job, ['--delete-delay', '--delete-excluded']), { sendJobId: job }), null);
  assert.equal(await pass('/home/me/app', sendArgs(job, ['--delay-updates']), { sendJobId: job }), null);
  assert.match((await pass('/home/me/app', sendArgs(job, ['--delete-delay']), { sendJobId: job })).message, /--delete-delay is not supported/);
  assert.match((await pass(stage, sendArgs('b'.repeat(24)), { sendJobId: job })).message, /--partial-dir is not supported/);
  assert.match((await pass(stage, sendArgs(job), {})).message, /--checksum-choice=xxh128 is not supported/);
});

async function copyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'helm-copy-arguments-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), target = join(root, 'target with spaces');
  mkdirSync(source);
  writeFileSync(join(source, 'a.txt'), 'private fixture\n');
  const wrapper = join(root, 'receiver.mjs');
  writeFileSync(wrapper, `
import { spawn } from 'node:child_process';
import { CopyArguments } from ${JSON.stringify(new URL('../packages/connect/src/copy-arguments.js', import.meta.url).href)};
import { validateCopyServerArgs } from ${JSON.stringify(new URL('../packages/connect/src/copy-transport.js', import.meta.url).href)};
const i = process.argv.indexOf('rsync');
try { validateCopyServerArgs(process.argv.slice(i + 1)); } catch(error) { console.error(JSON.stringify(process.argv.slice(i + 1))); throw error; }
const child = spawn('rsync', process.argv.slice(i + 1), { stdio: ['pipe', 'pipe', 'pipe'] });
const gate = new CopyArguments(process.env.HELM_TEST_COPY_TARGET);
gate.on('error', error => { console.error(error.message); child.kill(); process.stdin.destroy(); });
child.stdin.on('error', () => {});
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
process.stdin.pipe(gate).pipe(child.stdin);
child.on('close', code => { process.exit(code || (gate.destroyed && !gate.checked ? 1 : 0)); });
`);
  const run = (destination = target, extra = []) => new Promise((resolve, reject) => {
    const child = spawn('rsync', ['-a', '--no-owner', '--no-group', '--protect-args', '--mkpath',
      '--compress', '--compress-level=1', '--partial-dir=.helm-transfer-partial', '--info=progress2', '--stats', '--timeout=120',
      ...extra, '-e', `${process.execPath} ${wrapper}`, '--', `${source}/`, `fixture:${destination}/`],
    { env: { ...process.env, HELM_TEST_COPY_TARGET: target }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
    child.on('error', reject); child.on('close', code => resolve({ code, stderr }));
  });
  return { root, source, target, run };
}

test('real rsync accepts the signed destination and refuses changed folders and log files', { timeout: 10000 }, async t => {
  const f = await copyFixture(t);
  const wrong = join(f.root, 'elsewhere');
  const denied = await f.run(wrong);
  assert.notEqual(denied.code, 0, denied.stderr);
  assert.equal(existsSync(wrong), false);
  const log = join(f.root, 'outside.log');
  const unsafe = await f.run(f.target, [`-M--log-file=${log}`]);
  assert.notEqual(unsafe.code, 0, unsafe.stderr);
  assert.equal(existsSync(log), false);
  assert.equal(existsSync(f.target), false);
  const normal = await f.run();
  assert.equal(normal.code, 0, normal.stderr);
  assert.equal(readFileSync(join(f.target, 'a.txt'), 'utf8'), 'private fixture\n');
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  mkdirSync(join(f.source, 'linked')); writeFileSync(join(f.source, 'linked', 'nested'), 'fixture');
  symlinkSync(outside, join(f.target, 'linked'));
  const symlink = await f.run();
  assert.equal(symlink.code, 0, symlink.stderr);
  assert.equal(existsSync(join(outside, 'nested')), false);
  assert.equal(readFileSync(join(f.target, 'linked', 'nested'), 'utf8'), 'fixture');
  const dryRun = await f.run(f.target, ['--dry-run']);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  const list = join(f.root, 'files'); writeFileSync(list, 'a.txt\0');
  const listed = await f.run(f.target, [`--files-from=${list}`, '--from0', '-r']);
  assert.equal(listed.code, 0, listed.stderr);
  mkdirSync(join(f.source, 'sub')); writeFileSync(join(f.source, 'sub', 'a.txt'), 'listed fixture');
  symlinkSync(outside, join(f.target, 'sub')); writeFileSync(list, 'sub/a.txt\0');
  const implied = await f.run(f.target, [`--files-from=${list}`, '--from0', '-r']);
  assert.equal(implied.code, 0, implied.stderr);
  assert.equal(existsSync(join(outside, 'a.txt')), false);
  assert.equal(readFileSync(join(f.target, 'sub', 'a.txt'), 'utf8'), 'listed fixture');
});
