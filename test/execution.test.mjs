import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startWork, startDurableWork } from '../packages/connect/src/work-command.js';
import { ExecutionJobs } from '../packages/connect/src/execution.js';
import { parseWorkArgs, runRemoteWork, runLocalWork, readRemoteWork, cancelRemoteWork, parseCommandRef } from '../packages/connect/src/execution-cli.js';
import { M } from '@helm/protocol';

const root = mkdtempSync(join(tmpdir(), 'helm-execution-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const spec = (code, extra = {}) => ({ argv: [process.execPath, '-e', code], cwd: root, timeout: 5000, ...extra });
const launch = args => startWork(args, { env: { ...process.env, HELM_DIR: root } });
const id = n => n.toString(16).padStart(32, '0');
let jobDirectory = 0;
const makeJobs = options => new ExecutionJobs({ directory: join(root, `jobs-${++jobDirectory}`), ...options });

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
  const jobs = makeJobs(); t.after(() => jobs.stop());
  const literal = '$(touch never-created) `echo unsafe` "quoted"';
  jobs.start({ ...spec('console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.WORK_TEST}));console.error("err");process.exitCode=7'), id: id(1), argv: [process.execPath, '-e', 'console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.WORK_TEST}));console.error("err");process.exitCode=7', literal], env: { WORK_TEST: 'explicit value' } }, 'owner');
  const r = await result(jobs, id(1));
  assert.equal(r.exitCode, 7);
  assert.deepEqual(JSON.parse(r.output), { args: [literal], cwd: root, env: 'explicit value' });
  assert.equal(r.errors.trim(), 'err');
});

test('a command request is idempotent, its output is owner-bound and invalid input never executes', async t => {
  const jobs = makeJobs(); t.after(() => jobs.stop());
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

test('a running command and its result survive a daemon restart without a second start', async t => {
  const directory = join(root, 'restart-jobs');
  const gate = join(root, 'restart-gate');
  const count = join(root, 'restart-count');
  const code = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(count)},'start\\n');const w=fs.watch(${JSON.stringify(root)},()=>{if(fs.existsSync(${JSON.stringify(gate)})){w.close();console.log('after restart');}});console.log('before restart')`;
  const request = { id: id(30), ...spec(code, { timeout: 20000 }) };
  const before = new ExecutionJobs({ directory });
  const after = new ExecutionJobs({ directory });
  t.after(async () => {
    try { after.cancel({ id: request.id }, 'owner'); await result(after, request.id); } catch {}
    await before.stop(); await after.stop();
  });
  before.start(request, 'owner');
  let cursor = 0, seen = '';
  while (!seen.includes('before restart')) {
    const read = await before.read({ id: request.id, since: cursor, wait: 1000 }, 'owner');
    for (const chunk of read.chunks) seen += Buffer.from(chunk.data, 'base64').toString();
    cursor = read.last;
  }
  await before.stop();
  assert.notEqual((await after.read({ id: request.id }, 'owner')).status, 'exited');
  await assert.rejects(() => after.read({ id: request.id }, 'intruder'), /not found/);
  assert.throws(() => after.start({ ...request, argv: ['different'] }, 'owner'), /another request/);
  assert.equal(after.start(request, 'owner').id, request.id);
  writeFileSync(gate, 'release');
  const done = await result(after, request.id);
  assert.equal(done.exitCode, 0);
  assert.match(done.output, /before restart/);
  assert.match(done.output, /after restart/);
  assert.equal(readFileSync(count, 'utf8'), 'start\n');
  await after.stop();
  const later = new ExecutionJobs({ directory });
  try { assert.equal((await result(later, request.id)).output, done.output); }
  finally { await later.stop(); }
});

test('a running command can be cancelled after the daemon restarts', async t => {
  const directory = join(root, 'restart-cancel-jobs');
  const request = { id: id(33), ...spec('console.log("ready");setInterval(()=>{},1000)', { timeout: 12000 }) };
  const before = new ExecutionJobs({ directory });
  const after = new ExecutionJobs({ directory });
  t.after(async () => {
    try { after.cancel({ id: request.id }, 'owner'); await result(after, request.id); } catch {}
    await before.stop(); await after.stop();
  });
  before.start(request, 'owner');
  let cursor = 0, seen = '';
  while (!seen.includes('ready')) {
    const read = await before.read({ id: request.id, since: cursor, wait: 1000 }, 'owner');
    for (const chunk of read.chunks) seen += Buffer.from(chunk.data, 'base64').toString();
    cursor = read.last;
  }
  await before.stop();
  assert.equal(after.cancel({ id: request.id }, 'owner').status, 'running');
  assert.equal((await result(after, request.id)).exitCode, 130);
});

test('an unknown supervisor never causes the same command to start again', async t => {
  let launches = 0;
  const fake = () => { launches++; return Object.assign(new EventEmitter(), { pid: process.pid }); };
  const directory = join(root, 'unknown-job');
  const request = { id: id(31), ...spec('console.log("once")') };
  const first = new ExecutionJobs({ launch: fake, directory });
  const after = new ExecutionJobs({ launch: fake, directory });
  t.after(async () => { await first.stop(); await after.stop(); });
  first.start(request, 'owner');
  await first.stop();
  const unknown = await after.read({ id: request.id }, 'owner');
  assert.equal(unknown.status, 'exited');
  assert.match(unknown.error, /unknown.*Do not rerun/);
  assert.equal(after.start(request, 'owner').status, 'exited');
  assert.equal(launches, 1);
});

test('a failed initial record leaves no temporary file and never starts work', async t => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const directory = join(root, 'full-initial');
  const jobDir = join(directory, id(34));
  let launches = 0;
  const jobs = new ExecutionJobs({ directory, launch: () => { launches++; return new EventEmitter(); } });
  t.after(() => jobs.stop());
  const request = { id: id(34), ...spec('console.log("never")') };
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => {
      if (to === join(jobDir, 'state.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return rename(from, to);
    };
    syncBuiltinESMExports();
    assert.throws(() => jobs.start(request, 'owner'), /disk full/);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.deepEqual(readdirSync(jobDir), []);
  assert.throws(() => jobs.start(request, 'owner'), /incomplete.*do not rerun/);
  assert.equal(launches, 0);
});

test('a failed command file write removes partial arguments and does not start work', async t => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const directory = join(root, 'full-spec');
  const jobDir = join(directory, id(36));
  let launches = 0;
  const jobs = new ExecutionJobs({ directory, launch: () => { launches++; return new EventEmitter(); } });
  t.after(() => jobs.stop());
  const request = { id: id(36), ...spec('console.log("never")') };
  const write = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, ...args) => {
      if (file === join(jobDir, 'spec.json')) {
        write(file, 'partial');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return write(file, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => jobs.start(request, 'owner'), /disk full/);
  } finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.deepEqual(readdirSync(jobDir), ['state.json']);
  jobs.start(request, 'owner');
  assert.equal(launches, 0);
});

test('a failed parent pid write does not discard a launched command', async t => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const directory = join(root, 'full-pid');
  const pidFile = join(directory, id(37), 'supervisor.pid');
  const count = join(root, 'full-pid-count');
  const request = { id: id(37), ...spec(`require('node:fs').appendFileSync(${JSON.stringify(count)},'once\\n')`) };
  const jobs = new ExecutionJobs({ directory });
  t.after(async () => {
    try { jobs.cancel({ id: request.id }, 'owner'); await result(jobs, request.id); } catch {}
    await jobs.stop();
  });
  const write = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, ...args) => {
      if (file === pidFile) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return write(file, ...args);
    };
    syncBuiltinESMExports();
    jobs.start(request, 'owner');
  } finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
  assert.equal((await result(jobs, request.id)).exitCode, 0);
  assert.equal(jobs.start(request, 'owner').status, 'exited');
  assert.equal(readFileSync(count, 'utf8'), 'once\n');
});

test('a failed final record reports an unknown outcome without replay', async t => {
  const directory = join(root, 'full-final');
  const jobDir = join(directory, id(35));
  const gate = join(root, 'full-final-gate');
  const count = join(root, 'full-final-count');
  const code = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(count)},'once\\n');const w=fs.watch(${JSON.stringify(root)},()=>{if(fs.existsSync(${JSON.stringify(gate)}))w.close()});console.log('ready')`;
  const request = { id: id(35), ...spec(code, { timeout: 12000 }) };
  let supervisor;
  const jobs = new ExecutionJobs({ directory, launch: (s, o) => (supervisor = startDurableWork(s, o)) });
  t.after(async () => { chmodSync(jobDir, 0o700); await jobs.stop(); });
  jobs.start(request, 'owner');
  let cursor = 0, seen = '';
  while (!seen.includes('ready')) {
    const read = await jobs.read({ id: request.id, since: cursor, wait: 1000 }, 'owner');
    for (const chunk of read.chunks) seen += Buffer.from(chunk.data, 'base64').toString();
    cursor = read.last;
  }
  const exited = once(supervisor, 'exit');
  chmodSync(jobDir, 0o500);
  writeFileSync(gate, 'release');
  await exited;
  const unknown = await jobs.read({ id: request.id }, 'owner');
  assert.equal(unknown.status, 'exited');
  assert.match(unknown.error, /unknown.*Do not rerun/);
  assert.equal(jobs.start(request, 'owner').status, 'exited');
  assert.equal(readFileSync(count, 'utf8'), 'once\n');
});

test('a supervisor keeps output after its daemon is killed', { timeout: 15000 }, async t => {
  const { spawn } = await import('node:child_process');
  const directory = join(root, 'killed-daemon-jobs');
  const gate = join(root, 'killed-daemon-gate');
  const count = join(root, 'killed-daemon-count');
  const code = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(count)},'once\\n');const w=fs.watch(${JSON.stringify(root)},()=>{if(fs.existsSync(${JSON.stringify(gate)})){w.close();console.log('finished');}});console.log('started')`;
  const request = { id: id(32), ...spec(code, { timeout: 12000 }) };
  const runner = `
    import { ExecutionJobs } from ${JSON.stringify(new URL('../packages/connect/src/execution.js', import.meta.url).href)};
    const jobs = new ExecutionJobs({ directory: ${JSON.stringify(directory)} });
    const request = ${JSON.stringify(request)};
    jobs.start(request, 'owner');
    let cursor = 0, text = '';
    while (!text.includes('started')) {
      const read = await jobs.read({ id: request.id, since: cursor, wait: 1000 }, 'owner');
      for (const chunk of read.chunks) text += Buffer.from(chunk.data, 'base64').toString();
      cursor = read.last;
    }
    process.send('started');
    setInterval(() => {}, 1000);
  `;
  const daemon = spawn(process.execPath, ['--input-type=module', '-e', runner], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const after = new ExecutionJobs({ directory });
  t.after(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    try { after.cancel({ id: request.id }, 'owner'); await result(after, request.id); } catch {}
    await after.stop();
  });
  assert.equal((await once(daemon, 'message'))[0], 'started');
  const gone = once(daemon, 'exit'); daemon.kill('SIGKILL'); await gone;
  assert.equal((await after.read({ id: request.id }, 'owner')).status, 'running');
  assert.equal(after.start(request, 'owner').id, request.id);
  writeFileSync(gate, 'release');
  const done = await result(after, request.id);
  assert.equal(done.exitCode, 0);
  assert.match(done.output, /started/);
  assert.match(done.output, /finished/);
  assert.equal(readFileSync(count, 'utf8'), 'once\n');
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

test('no command is refused for being one too many', async t => {
  // A launcher whose commands never finish, so every one stays running.
  const fake = () => new EventEmitter();
  const jobs = makeJobs({ launch: fake }); t.after(() => jobs.stop());
  for (let n = 1; n <= 70; n++) assert.equal(jobs.start({ id: id(1000 + n), ...spec('') }, 'owner').status, 'starting');
});

test('output retention is bounded and paged with an explicit truncation marker', async t => {
  const jobs = makeJobs(); t.after(() => jobs.stop());
  jobs.start({ id: id(8), ...spec('process.stdout.write("x".repeat(600000))') }, 'owner');
  await pause(400);
  const first = await jobs.read({ id: id(8) }, 'owner');
  assert.equal(first.truncated, true);
  assert.ok(first.chunks.reduce((n,c) => n + Buffer.from(c.data,'base64').length,0) <= 64 * 1024);
  assert.equal(first.more, true);
  const r = await result(jobs, id(8)); assert.ok(r.output.length <= 256 * 1024);
});

test('completed output expires even without another command starting', async t => {
  const jobs = makeJobs({ retainMs: 30 }); t.after(() => jobs.stop());
  const request = { id: id(9), ...spec('console.log("saved briefly")') };
  jobs.start(request, 'owner');
  assert.equal((await result(jobs, id(9))).exitCode, 0);
  await pause(60);
  await assert.rejects(() => jobs.read({ id: id(9) }, 'owner'), /expired/);
  assert.throws(() => jobs.start(request, 'owner'), /expired/);
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
  const jobs = makeJobs(); t.after(() => jobs.stop());
  assert.equal(jobs.retainMs, 60 * 60_000);
});
