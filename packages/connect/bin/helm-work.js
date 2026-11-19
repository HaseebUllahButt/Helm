import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hideKeys, keyOutput } from '../src/key-output.js';
import { readExecution, writeExecution } from '../src/execution-store.js';

// Commands start at once: no shared slot, no wait for free memory, no cap on
// test workers. --heavy is still accepted from older agents and changes nothing.
const durableDir = process.argv[2] === '--durable' ? process.argv[3] : null;
let command, cancelled = false, finished = false, killTimer, deadlineTimer, watcher, state;
const notify = value => {
  if (durableDir) {
    Object.assign(state, value);
    try { writeExecution(durableDir, state); } catch { /* A later write can still save the result. */ }
  } else if (process.connected) process.send(value);
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const signal = name => {
  if (!command?.pid) return;
  try { process.kill(process.platform === 'win32' ? command.pid : -command.pid, name); } catch {}
};
function cancel() {
  if (finished) return;
  cancelled = true;
  if (!command) return;
  signal('SIGTERM');
  killTimer ??= setTimeout(() => signal('SIGKILL'), 2000);
}

async function closeDescendants() {
  if (!command?.pid || process.platform === 'win32') return;
  const alive = () => { try { process.kill(-command.pid, 0); return true; } catch { return false; } };
  if (!alive()) return;
  signal('SIGTERM');
  const until = Date.now() + 1000;
  while (alive() && Date.now() < until) await pause(20);
  if (alive()) signal('SIGKILL');
}

function append(stream, data) {
  if (!data.length) return;
  for (let offset = 0; offset < data.length; offset += 16 * 1024) {
    const chunk = data.subarray(offset, offset + 16 * 1024);
    state.chunks.push({ seq: ++state.seq, stream, data: chunk.toString('base64'), bytes: chunk.length });
    state.bytes += chunk.length;
    while (state.bytes > 256 * 1024) state.bytes -= state.chunks.shift().bytes;
  }
  notify({});
}

process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
if (!durableDir) {
  process.on('disconnect', cancel);
  process.on('message', message => { if (message.cancel) cancel(); });
}

async function run(spec, keys) {
  const values = Object.values(keys ?? {});
  const safeError = error => values.length ? hideKeys(error.message, values) : error.message;
  const filters = values.length ? { stdout: keyOutput(values), stderr: keyOutput(values) } : null;
  const output = (stream, data) => append(stream, filters ? filters[stream](data) : data);
  let code = 1, exitSignal;
  try {
    const argv = spec.argv;
    const end = Date.now() + spec.timeout;
    if (cancelled) { code = 130; return; }
    if (Date.now() >= end) throw new Error('Command timeout elapsed before execution.');
    command = spawn(argv[0], argv.slice(1), {
      cwd: spec.cwd, env: { ...process.env, ...spec.env, ...keys },
      stdio: durableDir ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit'],
      detached: process.platform !== 'win32',
    });
    if (durableDir) {
      command.stdout.on('data', data => output('stdout', data));
      command.stderr.on('data', data => output('stderr', data));
    } else {
      process.stdin.pipe(command.stdin);
      command.stdin.on('error', () => {});
    }
    command.once('spawn', () => notify({ status: 'running' }));
    if (cancelled) cancel();
    deadlineTimer = setTimeout(() => { notify({ error: 'Command timed out.' }); cancel(); }, end - Date.now());
    code = await new Promise(resolve => {
      command.on('error', error => { notify({ error: safeError(error) }); resolve(1); });
      // A finished parent can leave grandchildren holding stdout open. Close
      // them on exit so the job does not wait for inherited pipes to drain.
      command.on('exit', () => { closeDescendants().catch(() => {}); });
      command.on('close', (exitCode, signalName) => {
        exitSignal = signalName;
        if (!durableDir) notify({ exitCode, signal: signalName });
        resolve(cancelled ? 130 : exitCode ?? 1);
      });
    });
  } catch (error) { notify({ error: safeError(error) }); }
  finally {
    finished = true;
    clearTimeout(killTimer); clearTimeout(deadlineTimer);
    if (!durableDir) process.stdin.destroy();
    await closeDescendants();
    if (durableDir) {
      if (filters) for (const [stream, filter] of Object.entries(filters)) append(stream, filter(Buffer.alloc(0), true));
      notify({ status: 'exited', exitCode: code, signal: exitSignal ?? null, finishedAt: Date.now() });
      watcher?.close();
    } else if (process.connected) process.disconnect();
    process.exitCode = code;
  }
}

if (durableDir) {
  state = readExecution(durableDir);
  writeFileSync(join(durableDir, 'supervisor.pid'), String(process.pid), { mode: 0o600 });
  let spec;
  try {
    spec = JSON.parse(readFileSync(join(durableDir, 'spec.json'), 'utf8'));
    rmSync(join(durableDir, 'spec.json'), { force: true });
    watcher = watch(durableDir, () => { if (existsSync(join(durableDir, 'cancel'))) cancel(); });
    if (existsSync(join(durableDir, 'cancel'))) cancel();
    let keys;
    if (process.argv[4] === '--key-pipe') {
      try {
        const chunks = [];
        for await (const chunk of createReadStream(null, { fd: 3 })) chunks.push(chunk);
        keys = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { throw new Error('Helm could not read the shared keys for this command.'); }
    }
    await run(spec, keys);
  } catch (error) {
    notify({ status: 'exited', exitCode: 1, error: error.message, finishedAt: Date.now() });
    watcher?.close();
    process.exitCode = 1;
  }
} else {
  process.once('message', spec => { if (!spec.cancel) void run(spec); });
}
