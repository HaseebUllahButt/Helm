import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { startWork, prepareWork } from '../packages/connect/src/work-command.js';
import { ExecutionJobs } from '../packages/connect/src/execution.js';
import { parseWorkArgs, runRemoteWork, runLocalWork } from '../packages/connect/src/execution-cli.js';
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

test('independent supervisors serialize heavy work across sessions using one machine lock', async () => {
  const log = join(root, 'order.txt');
  const code = name => `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(name + ' start\n')});setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(name + ' end\n')}),350)`;
  const a = launch(spec(code('a'), { heavy: true }));
  const b = launch(spec(code('b'), { heavy: true }));
  a.stdin.end(); b.stdin.end();
  const messages = []; for (const child of [a,b]) child.on('message', m => messages.push(m));
  const exits = await Promise.all([once(a, 'close'), once(b, 'close')]);
  assert.ok(exits.every(([code]) => code === 0));
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(['a start,a end,b start,b end', 'b start,b end,a start,a end'].includes(lines.join(',')), lines.join(','));
  assert.ok(messages.some(m => m.status === 'queued' && m.reason === 'slot'));
});

test('cancelling queued work does not start it or release another session\'s permit', async t => {
  const jobs = new ExecutionJobs({ launch }); t.after(() => jobs.stop());
  jobs.start({ id: id(4), ...spec('setTimeout(()=>console.log("first"),700)', { heavy: true }) }, 'owner');
  while ((await jobs.read({ id: id(4), wait: 50 }, 'owner')).status !== 'running') {}
  jobs.start({ id: id(5), ...spec('console.log("must not run")', { heavy: true }) }, 'owner');
  jobs.cancel({ id: id(5) }, 'owner');
  const cancelled = await result(jobs, id(5));
  assert.equal(cancelled.exitCode, 130); assert.equal(cancelled.output, '');
  assert.notEqual((await jobs.read({ id: id(4) }, 'owner')).status, 'exited');
  assert.equal((await result(jobs, id(4))).output.trim(), 'first');
});

test('command timeout terminates the job and frees its heavy permit', async t => {
  const jobs = new ExecutionJobs({ launch }); t.after(() => jobs.stop());
  jobs.start({ id: id(6), ...spec('setInterval(()=>{},1000)', { heavy: true, timeout: 200 }) }, 'owner');
  const timedOut = await result(jobs, id(6));
  assert.match(timedOut.error, /timed out/i);
  jobs.start({ id: id(7), ...spec('console.log("after timeout")', { heavy: true }) }, 'owner');
  assert.equal((await result(jobs, id(7))).output.trim(), 'after timeout');
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

test('orphaned descendants cannot keep a completed command and heavy slot alive', async () => {
  const child = launch(spec('require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}).unref()', { heavy: true }));
  child.stdin.end();
  assert.equal((await once(child, 'close'))[0], 0);
  const next = launch(spec('console.log("slot released")', { heavy: true })); next.stdin.end();
  assert.equal((await once(next, 'close'))[0], 0);
});

test('known runners get bounded workers and compound npm scripts cannot silently turn scoped checks into full suites', () => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run && npm run other', client: 'vitest run --config client.ts', nodes: 'node --test test/*.mjs' } }));
  assert.deepEqual(prepareWork(['node','--test','one.mjs'],root), ['node','--test-concurrency=2','--test','one.mjs']);
  assert.deepEqual(prepareWork(['vitest','run','--maxWorkers=1'],root), ['vitest','run','--maxWorkers=1']);
  assert.deepEqual(prepareWork(['npx','vitest','run','--maxWorkers','12'],root), ['npx','vitest','run','--maxWorkers=2']);
  assert.deepEqual(prepareWork(['npm','run','client','--','one.ts'],root), ['npm','run','client','--','one.ts','--maxWorkers=2']);
  assert.deepEqual(prepareWork(['npm','run','nodes'],root), ['npm','run','nodes']);
  assert.deepEqual(prepareWork(['vitest','run','--maxWorkers=10','--maxWorkers','8'],root), ['vitest','run','--maxWorkers=2','--maxWorkers=2']);
  assert.throws(() => prepareWork(['npm','test','--','one.ts'],root), /earlier suite unfiltered/);
  assert.deepEqual(prepareWork(['npm','test'],root), ['npm','test']);
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
