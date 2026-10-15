import { spawn } from 'node:child_process';

// Commands start at once: no shared slot, no wait for free memory, no cap on
// test workers. --heavy is still accepted from older agents and changes nothing.
let command, cancelled = false, finished = false, killTimer, deadlineTimer;
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

process.once('message', async spec => {
  if (spec.cancel) return;
  let code = 1;
  try {
    const argv = spec.argv;
    const end = Date.now() + spec.timeout;
    if (cancelled) { code = 130; return; }
    if (Date.now() >= end) throw new Error('Command timeout elapsed before execution.');
    notify({ status: 'running' });
    command = spawn(argv[0], argv.slice(1), {
      cwd: spec.cwd, env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'inherit', 'inherit'], detached: process.platform !== 'win32',
    });
    process.stdin.pipe(command.stdin);
    command.stdin.on('error', () => {});
    deadlineTimer = setTimeout(() => { notify({ error: 'Command timed out.' }); cancel(); }, end - Date.now());
    code = await new Promise(resolve => {
      command.on('error', error => { notify({ error: error.message }); resolve(1); });
      // A finished parent can leave grandchildren holding stdout open. Close
      // them on exit so the job does not wait for inherited pipes to drain.
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
    if (process.connected) process.disconnect();
    process.exitCode = code;
  }
});
