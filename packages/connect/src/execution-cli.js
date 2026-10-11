import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { M } from '@helm/protocol';
import { connectHub } from './hub-client.js';
import { startWork, WORK_TIMEOUT_MS } from './work-command.js';

export function parseWorkArgs(args, { remote = false } = {}) {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1) throw new Error('put the command and its arguments after --');
  const options = { heavy: false, timeout: WORK_TIMEOUT_MS, env: {} };
  const flags = args.slice(0, separator);
  if (remote) {
    options.machine = flags.shift();
    if (!options.machine || options.machine.startsWith('-')) throw new Error('helm exec <machine> [--cwd <path>] [--heavy] -- <command> [args]');
  }
  while (flags.length) {
    const flag = flags.shift();
    if (flag === '--heavy') { options.heavy = true; continue; }
    if (!['--cwd', '--timeout', '--env'].includes(flag) || !flags.length) throw new Error(`invalid command option: ${flag}`);
    const value = flags.shift();
    if (flag === '--cwd') options.cwd = value;
    else if (flag === '--timeout') options.timeout = Number(value);
    else {
      const index = value.indexOf('=');
      if (index < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(0, index))) throw new Error('--env expects NAME=value');
      options.env[value.slice(0, index)] = value.slice(index + 1);
    }
  }
  if (!Number.isInteger(options.timeout) || options.timeout < 1 || options.timeout > 24 * 60 * 60_000) throw new Error('--timeout must be milliseconds between 1 and 86400000');
  options.argv = args.slice(separator + 1);
  return options;
}

const queueLine = (reason, machine = 'this machine') => reason === 'memory'
  ? `Waiting for available memory on ${machine}.\n` : `Waiting for the heavy-work slot on ${machine}.\n`;

/** Local execution preserves the calling shell's environment, including test DB choices. */
export async function runLocalWork(args, { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}) {
  const options = parseWorkArgs(args);
  const child = startWork({ ...options, cwd: resolve(options.cwd ?? process.cwd()) });
  child.stdout.pipe(stdout, { end: false }); child.stderr.pipe(stderr, { end: false });
  stdin.pipe(child.stdin); child.stdin.on('error', () => {});
  let error, timeout = false;
  child.on('message', message => {
    if (message.status === 'queued') stderr.write(queueLine(message.reason));
    if (message.error) { error = message.error; timeout = /timed out|timeout/i.test(error); }
  });
  child.on('error', failure => { error = failure.message; });
  const cancel = () => { if (child.connected) child.send({ cancel: true }); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const code = await new Promise(resolve => child.on('close', code => resolve(code ?? 1)));
    if (error) stderr.write(`helm: ${error}\n`);
    return timeout ? 124 : code;
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    stdin.unpipe(child.stdin); child.stdin.end();
  }
}

/** One connection serves start, output and cancellation; reconnect only reads the same job. */
export async function runRemoteWork(args, { net, machineId, connect = connectHub,
  stdout = process.stdout, stderr = process.stderr, parentId = process.env.HELM_SESSION_ID } = {}) {
  const options = parseWorkArgs(args, { remote: true });
  const target = machineId(options.machine);
  const id = randomBytes(16).toString('hex');
  let connection, cursor = 0, queued, cancelRequested = false;
  const cancel = () => {
    cancelRequested = true;
    connection?.rpc(M.EXEC_CANCEL, { id }).catch(() => {});
  };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    // Preserve the caller's restrictive permission choice when asking another
    // machine to execute. Full command execution is not a read-only operation.
    if (parentId) {
      const local = await connect(net, net.self);
      try {
        const state = await local.rpc(M.SESSION_EVENTS, { id: parentId, tail: 1, limit: 1 });
        if (['plan', 'readonly', 'read'].includes(state.session?.mode)) throw new Error('a read-only session cannot start managed commands');
      } finally { local.close(); }
    }
    connection = await connect(net, target);
    try {
      await connection.rpc(M.EXEC_START, { id, argv: options.argv, ...(options.cwd ? { cwd: options.cwd } : {}),
        heavy: options.heavy, timeout: options.timeout, env: options.env,
        ...(target === net.self && parentId ? { sessionId: parentId } : {}) });
    } catch (error) {
      throw new Error(`${error.message}\nCommand ${id} may have started; it was not retried. Inspect it with helm exec-result ${options.machine} ${id}.`);
    }
    if (cancelRequested) await connection.rpc(M.EXEC_CANCEL, { id });
    while (true) {
      let result;
      try { result = await connection.rpc(M.EXEC_READ, { id, since: cursor, wait: 10_000 }); }
      catch (error) {
        connection.close(); connection = await connect(net, target);
        if (cancelRequested) await connection.rpc(M.EXEC_CANCEL, { id });
        result = await connection.rpc(M.EXEC_READ, { id, since: cursor });
      }
      if (result.truncated) stderr.write('helm: earlier command output expired while disconnected.\n');
      for (const chunk of result.chunks) (chunk.stream === 'stderr' ? stderr : stdout).write(Buffer.from(chunk.data, 'base64'));
      cursor = result.last;
      if (result.status === 'queued' && queued !== result.reason) { stderr.write(queueLine(result.reason, options.machine)); queued = result.reason; }
      if (result.status === 'exited' && !result.more) {
        if (result.error) stderr.write(`helm: ${result.error}\n`);
        return /timed out|timeout/i.test(result.error ?? '') ? 124 : result.exitCode ?? 1;
      }
    }
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    connection?.close();
  }
}

export async function readRemoteWork(machine, id, { net, machineId, connect = connectHub,
  stdout = process.stdout, stderr = process.stderr } = {}) {
  const connection = await connect(net, machineId(machine));
  try {
    let cursor = 0, result;
    do {
      result = await connection.rpc(M.EXEC_READ, { id, since: cursor });
      if (result.truncated) stderr.write('helm: earlier command output has expired.\n');
      for (const chunk of result.chunks) (chunk.stream === 'stderr' ? stderr : stdout).write(Buffer.from(chunk.data, 'base64'));
      cursor = result.last;
    } while (result.more);
    stderr.write(`${id}: ${result.status}${result.status === 'exited' ? ` (exit ${result.exitCode})` : ''}\n`);
    if (result.error) stderr.write(`helm: ${result.error}\n`);
    return result.status === 'exited' ? result.exitCode ?? 1 : 3;
  } finally { connection.close(); }
}
