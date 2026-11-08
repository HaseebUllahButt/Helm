import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * Hold a real lock on a file, the way Codex holds its thread-writer lock
 * while a program writes a chat. Helm treats a lock file nobody holds as a
 * leftover from a dead program. Resolves once the lock is held.
 */
export async function holdLock(path) {
  // -o: only flock itself holds the lock, so killing it releases the lock.
  const child = spawn('flock', ['-o', path, 'sh', '-c', 'echo held; exec sleep 100000'],
    { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  return {
    async release() {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await exited;
    },
  };
}
