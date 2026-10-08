import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freemem, totalmem } from 'node:os';
import { spawn } from 'node:child_process';
import { HELM_DIR } from '../src/paths.js';
import { prepareWork } from '../src/work-command.js';

// One OS-managed SQLite write lock for every Helm version and session on this
// machine. A dead supervisor cannot leave a stale lock or a lease to expire.
let db, command, cancelled = false, finished = false, killTimer, deadlineTimer;
const notify = value => { if (process.connected) process.send(value); };
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
process.on('disconnect', cancel);
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
process.on('message', message => { if (message.cancel) cancel(); });

function availableMemory() {
  try { return Number(/^MemAvailable:\s+(\d+)/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]) * 1024 || freemem(); }
  catch { return freemem(); }
}

process.once('message', async spec => {
  if (spec.cancel) return;
  let code = 1;
  try {
    const argv = spec.heavy ? prepareWork(spec.argv, spec.cwd) : spec.argv;
    const end = Date.now() + spec.timeout;
    if (spec.heavy) {
      mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
      const file = join(HELM_DIR, 'heavy-work.sqlite');
      db = new DatabaseSync(file);
      chmodSync(file, 0o600);
      db.exec('PRAGMA busy_timeout=0');
      let waiting;
      while (!cancelled) {
        let reason;
        // Linux reports reclaimable cache here. On other systems serialize
        // work without treating their free-memory counter as pressure.
        if (process.platform === 'linux' && availableMemory() < Math.max(1024 ** 3, totalmem() * 0.15)) reason = 'memory';
        else {
          try { db.exec('BEGIN IMMEDIATE'); break; }
          catch (error) { if (!/locked|busy/i.test(error.message)) throw error; reason = 'slot'; }
        }
        if (waiting !== reason) { notify({ status: 'queued', reason }); waiting = reason; }
        if (Date.now() >= end) throw new Error('Timed out waiting for machine capacity; no command was started.');
        await pause(200 + Math.random() * 100);
      }
    }
    if (cancelled) { code = 130; return; }
    if (Date.now() >= end) throw new Error('Command timeout elapsed before execution.');
    notify({ status: 'running' });
    command = spawn(argv[0], argv.slice(1), {
      cwd: spec.cwd, env: { ...process.env, ...spec.env, ...(spec.heavy ? { HELM_TEST_WORKERS: '2' } : {}) },
      stdio: ['pipe', 'inherit', 'inherit'], detached: process.platform !== 'win32',
    });
    process.stdin.pipe(command.stdin);
    command.stdin.on('error', () => {});
    deadlineTimer = setTimeout(() => { notify({ error: 'Command timed out.' }); cancel(); }, end - Date.now());
    code = await new Promise(resolve => {
      command.on('error', error => { notify({ error: error.message }); resolve(1); });
      // A finished parent can leave grandchildren holding stdout open. Close
      // them on exit so the permit does not wait for inherited pipes to drain.
      command.on('exit', () => { closeDescendants().catch(() => {}); });
      command.on('close', (exitCode, exitSignal) => {
        notify({ exitCode, signal: exitSignal });
        resolve(cancelled ? 130 : exitCode ?? 1);
      });
    });
  } catch (error) { notify({ error: error.message }); }
  finally {
    finished = true;
    clearTimeout(killTimer); clearTimeout(deadlineTimer);
    process.stdin.destroy();
    await closeDescendants();
    try { db?.close(); } catch {}
    if (process.connected) process.disconnect();
    process.exitCode = code;
  }
});
