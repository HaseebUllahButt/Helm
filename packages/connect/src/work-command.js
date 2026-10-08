import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WORK_TIMEOUT_MS = 15 * 60_000;
export const TEST_WORKERS = 2;
const worker = fileURLToPath(new URL('../bin/helm-work.js', import.meta.url));

/** Limit known runners without pretending arbitrary shell scripts accept their flags. */
export function prepareWork(argv, cwd) {
  const args = [...argv];
  const executable = basename(args[0] ?? '');
  let runner = executable;
  let npm = false;
  let source = '';
  if (executable === 'npm') {
    const script = args[1] === 'run' ? args[2] : args[1];
    try { source = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts?.[script]; } catch {}
    if (source) {
      const compound = /[;&|`$\n]/.test(source);
      const separator = args.indexOf('--');
      if (compound && separator >= 0 && args.slice(separator + 1).some(a => !a.startsWith('-'))) {
        throw new Error(`The ${script} script chains commands; file arguments may leave an earlier suite unfiltered. Use a focused script or invoke its test runner directly.`);
      }
      runner = !compound ? source.trim().split(/\s+/)[0] : '';
      npm = executable === 'npm';
    }
  } else if (['npx', 'bun'].includes(executable)) {
    const command = args[1] === 'x' ? args[2] : args[1];
    runner = ['vitest', 'jest', 'playwright'].includes(command) ? command : '';
  }
  let flag;
  if (runner === 'vitest' || runner === 'jest') flag = '--maxWorkers';
  if (runner === 'playwright') flag = '--workers';
  // npm appends flags after a script's file arguments; Node treats those as
  // more file names. Node scripts must set their concurrency in package.json.
  if (runner === 'node' && !npm && args.includes('--test')) flag = '--test-concurrency';
  if (flag) {
    let found = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== flag && !args[index].startsWith(flag + '=')) continue;
      found = true;
      const separate = args[index] === flag;
      const value = Number(separate ? args[index + 1] : args[index].slice(flag.length + 1));
      if (!Number.isFinite(value) || value <= 0 || value > TEST_WORKERS) {
        args[index] = `${flag}=${TEST_WORKERS}`;
        if (separate && args[index + 1] && !args[index + 1].startsWith('-')) args.splice(index + 1, 1);
      }
    }
    if (!found) {
      if (npm && !args.includes('--')) args.push('--');
      if (runner === 'node' && !npm) args.splice(1, 0, `${flag}=${TEST_WORKERS}`);
      else args.push(`${flag}=${TEST_WORKERS}`);
    }
  }
  return args;
}

/** The supervisor keeps the heavy-work permit until its command has exited. */
export function startWork(spec, { env = process.env } = {}) {
  const child = spawn(process.execPath, ['--no-warnings', worker], {
    cwd: spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  child.on('error', () => {});
  child.send(spec, error => { if (error) child.emit('error', error); });
  return child;
}
