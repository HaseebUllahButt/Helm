import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { startWork } from '../packages/connect/src/work-command.js';
import { ExecutionJobs } from '../packages/connect/src/execution.js';
import { parseWorkArgs, runRemoteWork, runLocalWork, readRemoteWork, cancelRemoteWork, parseCommandRef } from '../packages/connect/src/execution-cli.js';
import { M } from '@helm/protocol';

const root = mkdtempSync(join(tmpdir(), 'helm-execution-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const spec = (code, extra = {}) => ({ argv: [process.execPath, '-e', code], cwd: root, timeout: 5000, ...extra });
const launch = args => startWork(args, { env: { ...process.env, HELM_DIR: root } });
const id = n => n.toString(16).padStart(32, '0');

async function result(jobs, key, owner = 'owner') {
  let cursor = 0, output = '', errors = '', read;
  do {
    read = await jobs.read({ id: key, since: cursor, wait: 1000 }, owner);
    for (const chunk of read.chunks) {
      const text = Buffer.from(chunk.data, 'base64').toString();
      if (chunk.stream === 'stdout') output += text; else errors += text;
    }
    cursor = read.last;
  } while (read.status !== 'exited' || read.more);
  return { ...read, output, errors };
}

test('a managed command preserves argv, explicit environment, cwd and exit code without shell expansion', async t => {
  const jobs = new ExecutionJobs({ launch }); t.after(() => jobs.stop());
  const literal = '$(touch never-created) `echo unsafe` "quoted"';
  jobs.start({ ...spec('console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.WORK_TEST}));console.error("err");process.exitCode=7'), id: id(1), argv: [process.execPath, '-e', 'console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.WORK_TEST}));console.error("err");process.exitCode=7', literal], env: { WORK_TEST: 'explicit value' } }, 'owner');
  const r = await result(jobs, id(1));
  assert.equal(r.exitCode, 7);
  assert.deepEqual(JSON.parse(r.output), { args: [literal], cwd: root, env: 'explicit value' });
  assert.equal(r.errors.trim(), 'err');
});

test('a command request is idempotent, its output is owner-bound and invalid input never executes', async t => {
  const jobs = new ExecutionJobs({ launch }); t.after(() => jobs.stop());
  const request = { id: id(2), ...spec('console.log("once")') };
  assert.equal(jobs.start(request, 'owner').id, id(2));
  assert.equal(jobs.start(request, 'owner').id, id(2));
  assert.throws(() => jobs.start({ ...request, argv: ['other'] }, 'owner'), /another request/);
  await assert.rejects(() => jobs.read({ id: id(2) }, 'intruder'), /not found/);
  assert.throws(() => jobs.start({ id: id(3), argv: ['echo', 'bad\0arg'] }, 'owner'), /arguments/);
  assert.throws(() => jobs.start({ id: id(3), argv: ['echo'], cwd: 'relative' }, 'owner'), /absolute/);
  assert.throws(() => jobs.start({ id: id(3), argv: ['echo'], env: { NAME: 42 } }, 'owner'), /environment/);
  assert.equal((await result(jobs, id(2))).output.trim(), 'once');
});

test('heavy work never waits: two heavy commands run at the same time', async () => {
  const log = join(root, 'order.txt');
  const code = name => `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(name + ' start\n')});setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(name + ' end\n')}),350)`;
  const a = launch(spec(code('a'), { heavy: true }));
  const b = launch(spec(code('b'), { heavy: true }));
  a.stdin.end(); b.stdin.end();
  const messages = []; for (const child of [a,b]) child.on('message', m => messages.push(m));
  const exits = await Promise.all([once(a, 'close'), once(b, 'close')]);
  assert.ok(exits.every(([code]) => code === 0));
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(lines.slice(0, 2).map(l => l.split(' ')[1]), ['start', 'start'], lines.join(','));
  assert.ok(!messages.some(m => m.status === 'queued'));
});

test('output retention is bounded and paged with an explicit truncation marker', async t => {
  const jobs = new ExecutionJobs({ launch }); t.after(() => jobs.stop());
  jobs.start({ id: id(8), ...spec('process.stdout.write("x".repeat(600000))') }, 'owner');
  await pause(400);
  const first = await jobs.read({ id: id(8) }, 'owner');
  assert.equal(first.truncated, true);
  assert.ok(first.chunks.reduce((n,c) => n + Buffer.from(c.data,'base64').length,0) <= 64 * 1024);
  assert.equal(first.more, true);
  const r = await result(jobs, id(8)); assert.ok(r.output.length <= 256 * 1024);
});

test('completed output expires even without another command starting', async t => {
  const jobs = new ExecutionJobs({ launch, retainMs: 30 }); t.after(() => jobs.stop());
  jobs.start({ id: id(9), ...spec('console.log("saved briefly")') }, 'owner');
  assert.equal((await result(jobs, id(9))).exitCode, 0);
  await pause(60);
  await assert.rejects(() => jobs.read({ id: id(9) }, 'owner'), /expired/);
});

test('orphaned descendants cannot keep a completed command alive', async () => {
  const child = launch(spec('require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}).unref()'));
  child.stdin.end();
  assert.equal((await once(child, 'close'))[0], 0);
});

test('CLI options preserve command arguments and require explicit remote environment', () => {
  const r = parseWorkArgs(['Laptop','--env','A=one=two','--env','B=three','--heavy','--cwd','/tmp','--','sh','-lc','printf "$A"'],{remote:true});
  assert.deepEqual(r.env,{A:'one=two',B:'three'}); assert.equal(r.heavy,true);
  assert.deepEqual(r.argv,['sh','-lc','printf "$A"']);
  assert.throws(() => parseWorkArgs(['--heavy','npm','test']), /after --/);
  assert.throws(() => parseWorkArgs(['--timeout','bad','--','true']), /milliseconds/);
});

test('remote CLI reconnects for output without starting the command twice', async () => {
  const stdout = new PassThrough(), stderr = new PassThrough(); let output = '', starts = 0, connections = 0;
  stdout.on('data',chunk => output += chunk);
  const connect = async () => {
    const generation = ++connections;
    return { close() {}, rpc: async (method, p) => {
      if (method === M.EXEC_START) { starts++; return {id:p.id}; }
      if (generation === 1) throw new Error('lost connection');
      return { status:'exited',exitCode:9,last:1,more:false,chunks:[{seq:1,stream:'stdout',data:Buffer.from('finished').toString('base64')}] };
    } };
  };
  const code = await runRemoteWork(['Laptop','--','echo','test'],{net:{self:'self'},machineId:()=> 'laptop',connect,stdout,stderr,parentId:null});
  assert.equal(code,9);assert.equal(output,'finished');assert.equal(starts,1);assert.equal(connections,2);
});

test('an uncertain start is never replayed and read-only parents cannot bypass their mode remotely', async () => {
  let starts = 0;
  const connect = async () => ({close(){},rpc:async method=>{if(method===M.EXEC_START)starts++;throw new Error('reply lost');}});
  await assert.rejects(()=>runRemoteWork(['Laptop','--','true'],{net:{self:'self'},machineId:()=> 'laptop',connect,parentId:null}),/not retried.*Inspect it/s);
  assert.equal(starts,1);
  const readOnly=async()=>({close(){},rpc:async()=>({session:{mode:'readonly'}})});
  await assert.rejects(()=>runRemoteWork(['Laptop','--','true'],{net:{self:'self'},machineId:()=> 'laptop',connect:readOnly,parentId:'parent'}),/read-only/);
});

test('local work preserves ambient test settings and returns the child exit status', async () => {
  const previous=process.env.HELM_DIR;process.env.HELM_DIR=root;process.env.WORK_AMBIENT_TEST='isolated-db';
  const stdout=new PassThrough(),stderr=new PassThrough(),stdin=new PassThrough();let output='';stdout.on('data',chunk=>output+=chunk);stdin.end();
  try {
    const code=await runLocalWork(['--heavy','--',process.execPath,'-e','console.log(process.env.WORK_AMBIENT_TEST);process.exitCode=4'],{stdout,stderr,stdin});
    assert.equal(code,4);assert.equal(output.trim(),'isolated-db');
  } finally {if(previous===undefined)delete process.env.HELM_DIR;else process.env.HELM_DIR=previous;delete process.env.WORK_AMBIENT_TEST;}
});

test('reading a command by id follows it to the end across a dropped link and reports a timeout as 124', async () => {
  const stdout = new PassThrough(), stderr = new PassThrough(); let output = '', connections = 0, reads = 0;
  stdout.on('data', chunk => output += chunk);
  const chunk = (seq, text, stream = 'stdout') => ({ seq, stream, data: Buffer.from(text).toString('base64') });
  const connect = async () => {
    const generation = ++connections;
    return { close() {}, rpc: async (method, p) => {
      assert.equal(method, M.EXEC_READ, 'reading never starts or cancels it');
      reads++;
      if (generation === 1 && reads === 2) throw new Error('lost connection');
      if (p.since === 0) return { status: 'running', chunks: [chunk(1, 'part one\n')], last: 1, more: false };
      return { status: 'exited', exitCode: 130, error: 'Command timed out.', chunks: [chunk(2, 'part two\n'), chunk(3, 'warning\n', 'stderr')], last: 3, more: false };
    } };
  };
  const ref = parseCommandRef(['Laptop', id(20), '--json', '--wait'], 'exec-status', ['--wait', '--json']);
  assert.deepEqual(ref, { machine: 'Laptop', id: id(20), wait: true, json: true });
  const code = await readRemoteWork(ref.machine, ref.id, { ...ref, net: {}, machineId: () => 'laptop', connect, stdout, stderr });
  assert.equal(code, 124);
  assert.equal(connections, 2);
  assert.deepEqual(JSON.parse(output), { id: id(20), machine: 'Laptop', status: 'exited', done: true, exitCode: 124,
    error: 'Command timed out.', stdout: 'part one\npart two\n', stderr: 'warning\n', truncated: false });
});

test('reading without --wait reports a running command as 3, and a missing one is not retried', async () => {
  let connections = 0;
  const running = async () => ({ close() {}, rpc: async () => ({ status: 'running', chunks: [], last: 0, more: false }) });
  const sink = new PassThrough();
  assert.equal(await readRemoteWork('Laptop', id(21), { net: {}, machineId: () => 'laptop', connect: running, stdout: sink, stderr: sink }), 3);
  const missing = async () => { connections++; return { close() {}, rpc: async () => { throw new Error('command not found; it may have expired or Helm restarted. Do not automatically rerun it.'); } }; };
  await assert.rejects(() => readRemoteWork('Laptop', id(22), { wait: true, net: {}, machineId: () => 'laptop', connect: missing, stdout: sink, stderr: sink }), /not found/);
  assert.equal(connections, 1);
  assert.throws(() => parseCommandRef(['Laptop', 'short'], 'exec-cancel', ['--json']), /exec-cancel <machine> <command-id>/);
  assert.throws(() => parseCommandRef(['Laptop', id(23), '--wait'], 'exec-cancel', ['--json']), /unknown option --wait/);
});

test('exec-cancel asks once and says whether the command had already finished', async () => {
  const calls = [];
  const connect = status => async () => ({ close() {}, rpc: async (method, p) => { calls.push([method, p.id]); return { id: p.id, status }; } });
  const stdout = new PassThrough(), stderr = new PassThrough(); let said = '';
  stderr.on('data', chunk => said += chunk);
  assert.equal(await cancelRemoteWork('Laptop', id(24), { net: {}, machineId: () => 'laptop', connect: connect('running'), stdout, stderr }), 0);
  assert.equal(await cancelRemoteWork('Laptop', id(25), { net: {}, machineId: () => 'laptop', connect: connect('exited'), stdout, stderr }), 0);
  assert.deepEqual(calls, [[M.EXEC_CANCEL, id(24)], [M.EXEC_CANCEL, id(25)]]);
  assert.match(said, /Asked Laptop to stop/);
  assert.match(said, /already finished/);
});

test('a finished result is kept for an hour by default', t => {
  const jobs = new ExecutionJobs({ launch }); t.after(() => jobs.stop());
  assert.equal(jobs.retainMs, 60 * 60_000);
});
