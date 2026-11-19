import './automation-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { M } from '@helm/protocol';
import { Tools, checkTool } from '../packages/connect/src/tools.js';
import { runToolsCommand, readInput, shellWord } from '../packages/connect/src/tools-cli.js';
import { toolsNote, helmBrief } from '../packages/connect/src/delegation.js';
import { commandHelp, USAGE } from '../packages/connect/src/help.js';

const { Daemon } = await import('../packages/connect/src/agent.js');

/**
 * Three machines: Laptop (this one), VM (answers through the daemon's real
 * RPC switch) and Old (an older Helm). Off does not answer.
 */
function fixture(t, { self = 'aa11' } = {}) {
  const dirs = [];
  const store = () => { const d = mkdtempSync(join(tmpdir(), 'helm-tools-')); dirs.push(d); return new Tools({ directory: d }); };
  t.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const stores = { aa11: store(), bb22: store(), cc33: store() };
  const net = { self, machines: {
    aa11: { id: 'aa11', name: 'Laptop' }, bb22: { id: 'bb22', name: 'VM' },
    cc33: { id: 'cc33', name: 'Off' }, dd44: { id: 'dd44', name: 'Old' },
  } };
  const offline = new Set(['cc33']);
  const calls = [];
  const rpc = async (env, method, params) => {
    calls.push({ env, method, params });
    if (offline.has(env)) throw Object.assign(new Error('could not reach that machine'), { code: 'unreachable' });
    if (env === 'dd44') throw Object.assign(new Error(`unknown method: ${method}`), { rpc: true });
    return structuredClone(await Daemon.prototype.dispatch.call({ tools: stores[env] }, method, structuredClone(params)));
  };
  const lines = [], local = [], remote = [];
  const run = (...args) => runToolsCommand(args, {
    net, rpc, store: stores[self], write: (l) => lines.push(l),
    machineId: (n) => { const m = Object.values(net.machines).find((x) => x.name === n || x.id === n); if (!m) throw new Error(`No machine called "${n}"`); return m.id; },
    runLocal: async (args) => { local.push(args); return 5; },
    runRemote: async (options) => { remote.push(options); return 7; },
    input: async () => Buffer.from('piped'),
  });
  return { net, stores, offline, calls, run, lines, local, remote, text: () => lines.join('\n'), clear: () => { lines.length = 0; } };
}

test('a tool record is checked and bad records in the file stay untouched', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-tools-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => checkTool({ name: 'Bad Name', argv: ['x'] }), /small letters/);
  assert.throws(() => checkTool({ name: 'ok', argv: [] }), /after --/);
  assert.throws(() => checkTool({ name: 'ok', argv: ['x'], cwd: 'rel' }), /full path/);
  assert.throws(() => checkTool({ name: 'ok', argv: ['x'], description: 'two\nlines' }), /one line/);
  const raw = { tools: [{ name: 'BAD', argv: 'nope' }, { name: 'good', argv: ['echo', 'hi'], createdAt: 1, updatedAt: 1 }] };
  writeFileSync(join(dir, 'tools.json'), JSON.stringify(raw));
  const tools = new Tools({ directory: dir, now: () => 50 });
  assert.deepEqual(tools.list().map((x) => x.name), ['good']);
  tools.save({ name: 'new', argv: ['true'] });
  const after = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8')).tools;
  assert.deepEqual(after[0], raw.tools[0], 'a record that fails the check is kept exactly as it was');
  assert.equal(tools.save({ name: 'good', argv: ['echo', 'bye'] }).replaced, true);
  assert.equal(tools.get('good').createdAt, 1, 'a change keeps the first add time');
  assert.deepEqual(tools.remove('good'), { removed: true });
  assert.deepEqual(tools.remove('good'), { removed: false });
});

test('helm tools add, list, show and remove work across machines, and remove prints the way back', async (t) => {
  const f = fixture(t);
  await f.run('add', 'hello', '--description', 'Say hello.', '--', 'echo', 'hello world');
  assert.match(f.text(), /Added the tool "hello" on Laptop\./);
  await f.run('add', 'ask-neon', '--machine', 'VM', '--description', 'Ask Gemini web chat a question.', '--', '/home/me/.local/bin/ask-neon');
  assert.match(f.text(), /Added the tool "ask-neon" on VM\.\n.*\n  Remove it with: helm tools remove ask-neon --machine VM/);
  assert.equal(f.stores.bb22.get('ask-neon').argv[0], '/home/me/.local/bin/ask-neon');
  await assert.rejects(f.run('add', 'x', '--machine', 'VM', '--', './rel'), /full path/);
  await assert.rejects(f.run('add', 'x', '--machine', 'Old', '--', 'true'), /older Helm/);

  f.clear();
  await f.run('list');
  assert.match(f.text(), /Laptop {2}\(online\)\n {4}hello {2}Say hello\./);
  assert.match(f.text(), /VM {2}\(online\)\n {4}ask-neon {2}Ask Gemini web chat a question\./);
  assert.match(f.text(), /Offline, tools not known: Off\./);
  assert.match(f.text(), /Older Helm, no tools: Old\./);

  f.clear();
  await f.run('list', '--json');
  const listed = JSON.parse(f.lines[0]);
  assert.deepEqual(listed.tools.map((x) => [x.name, x.machine, x.online]), [['hello', 'Laptop', true], ['ask-neon', 'VM', true]]);
  assert.deepEqual(listed.offline, ['Off']);
  assert.deepEqual(listed.olderHelm, ['Old']);

  f.clear();
  await f.run('show', 'ask-neon');
  assert.match(f.text(), /ask-neon {2}\(on VM, online\)\n {2}What: {5}Ask Gemini web chat a question\.\n {2}Command: {2}\/home\/me\/\.local\/bin\/ask-neon/);
  await f.run('show', 'hello');
  assert.match(f.text(), /Command: {2}echo 'hello world'/);

  f.clear();
  await f.run('remove', 'ask-neon');
  assert.match(f.text(), /Removed the tool "ask-neon" from VM\.\n {2}Add it again with: helm tools add ask-neon --machine VM --description 'Ask Gemini web chat a question\.' -- \/home\/me\/\.local\/bin\/ask-neon/);
  assert.equal(f.stores.bb22.get('ask-neon'), null);
  await assert.rejects(f.run('remove', 'ask-neon'), /No tool "ask-neon" found/);
});

test('an offline machine still shows its last known tools, heard here or through another machine', async (t) => {
  const f = fixture(t);
  f.stores.cc33.save({ name: 'gpu-burn', argv: ['gpu-burn'], description: 'Load the GPU.' });
  f.offline.delete('cc33');
  await f.run('list');
  f.offline.add('cc33');
  f.clear();
  await f.run('list');
  assert.match(f.text(), /Off {2}\(offline, last seen [^)]+\)\n {4}gpu-burn {2}Load the GPU\./);
  await assert.rejects(f.run('run', 'gpu-burn'), /Off is offline, so "gpu-burn" cannot run now/);
  await assert.rejects(f.run('remove', 'gpu-burn'), /Off is offline/);

  // VM heard about Off; a machine that never saw Off learns it from VM.
  const g = fixture(t, { self: 'bb22' });
  g.stores.bb22.remember({ cc33: { tools: [{ name: 'gpu-burn', argv: ['gpu-burn'] }], at: 10 } }, 'bb22');
  const h = fixture(t);
  h.stores.bb22 = g.stores.bb22;
  await h.run('list', '--json');
  const tool = JSON.parse(h.lines[0]).tools.find((x) => x.name === 'gpu-burn');
  assert.deepEqual([tool.machine, tool.online, tool.lastSeen], ['Off', false, 10]);
});

test('helm tools run passes words and input, prefers this machine and keeps the exit code', async (t) => {
  const f = fixture(t);
  f.stores.aa11.save({ name: 'here', argv: ['echo', 'a'], cwd: '/srv' });
  f.stores.bb22.save({ name: 'there', argv: ['/bin/ask'], cwd: '/opt' });
  assert.equal(await f.run('run', 'here', 'b', '--flag'), 5);
  assert.deepEqual(f.local[0], ['--cwd', '/srv', '--timeout', '900000', '--', 'echo', 'a', 'b', '--flag']);
  assert.equal(f.calls.length, 0, 'a tool on this machine needs no other machine');
  assert.equal(await f.run('run', '--timeout', '1000', 'there', '--', '--help', 'x y'), 7);
  assert.deepEqual(f.remote[0], { machine: 'VM', machineId: 'bb22', argv: ['/bin/ask', '--help', 'x y'], cwd: '/opt', heavy: false, timeout: 1000, env: {}, stdin: Buffer.from('piped') });
  // The same name on two machines: this machine wins; elsewhere, ask for --machine.
  f.stores.bb22.save({ name: 'here', argv: ['echo', 'vm'] });
  await f.run('run', 'here');
  assert.deepEqual(f.local[1].slice(-2), ['echo', 'a']);
  await f.run('run', '--machine', 'VM', 'here');
  assert.deepEqual(f.remote[1].argv, ['echo', 'vm']);
  f.stores.cc33.save({ name: 'dup', argv: ['a'] }); f.offline.delete('cc33');
  f.stores.bb22.save({ name: 'dup', argv: ['b'] });
  await assert.rejects(f.run('run', 'dup'), /"dup" is on 2 machines: VM, Off\. Add --machine/);
  await assert.rejects(f.run('run', '--bogus', 'x'), /Unknown option --bogus/);
  await assert.rejects(f.run('run'), /Give the tool name/);
});

test('readInput takes piped input, and gives up on a pipe that stays silent', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const reader = (wait) => spawn(process.execPath, ['--input-type=module', '-e',
    `const { readInput } = await import(${JSON.stringify(new URL('../packages/connect/src/tools-cli.js', import.meta.url).href)});
     const got = await readInput(process.stdin, { firstByteMs: ${wait} }); console.log(JSON.stringify(got && got.toString()));`],
  { stdio: ['pipe', 'pipe', 'inherit'] });
  const out = async (child) => { let s = ''; child.stdout.on('data', (d) => s += d); await once(child, 'close'); return s.trim(); };
  const fed = reader(60_000);
  fed.stdin.end('question');
  assert.equal(await out(fed), '"question"');
  // The pipe stays open and sends nothing: the run goes on with no input.
  const silent = reader(50);
  assert.equal(await out(silent), 'null');
  silent.stdin.destroy();
  assert.equal(await readInput(Object.assign(new PassThrough(), { isTTY: true })), null);
  assert.equal(shellWord('a b'), "'a b'");
  assert.equal(shellWord("it's"), "'it'\\''s'");
});

test('agents learn about helm tools from their notes and from helm help', () => {
  assert.match(toolsNote(), /helm tools list/);
  assert.match(helmBrief({}), /\[Helm tools:/);
  const help = commandHelp('tools', USAGE);
  assert.match(help, /helm tools run <name> \[args\]/);
  assert.match(help, /exit code is the tool's own/);
});

test('the daemon answers tool RPCs from its own file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-tools-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const self = { tools: new Tools({ directory: dir }) };
  const call = (method, p) => Daemon.prototype.dispatch.call(self, method, p);
  await call(M.TOOL_SAVE, { name: 'x', argv: ['true'] });
  const { tools, seen, at } = await call(M.TOOL_LIST, { seen: true });
  assert.deepEqual(tools.map((x) => x.name), ['x']);
  assert.deepEqual(seen, {});
  assert.ok(at > 0);
  assert.deepEqual(await call(M.TOOL_REMOVE, { name: 'x' }), { removed: true });
});
