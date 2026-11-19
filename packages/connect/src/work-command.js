import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownNode } from './own-node.js';

export const WORK_TIMEOUT_MS = 15 * 60_000;
const worker = fileURLToPath(new URL('../bin/helm-work.js', import.meta.url));

/** A supervisor process runs the command and reports how it ends. */
export function startWork(spec, { env = process.env, node = ownNode() } = {}) {
  const child = spawn(node, ['--no-warnings', worker], {
    cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  child.on('error', () => {});
  child.send(spec, error => { if (error) child.emit('error', error); });
  return child;
}

/** Detached supervisors own remote commands, even while the daemon restarts. */
export function startDurableWork(_spec, { directory, env = process.env, node = ownNode(), keys } = {}) {
  const child = spawn(node, ['--no-warnings', worker, '--durable', directory, ...(keys ? ['--key-pipe'] : [])], {
    env, stdio: keys ? ['ignore', 'ignore', 'ignore', 'pipe'] : 'ignore', detached: true,
  });
  if (keys) {
    // The worker reads a private pipe. Spec files and the worker's own
    // environment contain no key values.
    child.stdio[3].on('error', () => {});
    child.stdio[3].end(JSON.stringify(keys));
  }
  child.unref();
  return child;
}
