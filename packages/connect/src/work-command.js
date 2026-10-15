import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WORK_TIMEOUT_MS = 15 * 60_000;
const worker = fileURLToPath(new URL('../bin/helm-work.js', import.meta.url));

/** A supervisor process runs the command and reports how it ends. */
export function startWork(spec, { env = process.env } = {}) {
  const child = spawn(process.execPath, ['--no-warnings', worker], {
    cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  child.on('error', () => {});
  child.send(spec, error => { if (error) child.emit('error', error); });
  return child;
}
