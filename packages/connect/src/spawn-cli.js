import { posix } from 'node:path';
import { M } from '@helm/protocol';
import { chooseAgent, delegationOutput, parseAgentArgs } from './delegation.js';

export function parseSpawnArgs(args) {
  const { words, options } = parseAgentArgs(args, {
    values: ['model', 'mode', 'effort', 'title', 'timeout'], switches: ['mkdir', 'wait'],
  });
  const [machine, folder, account, ...prompt] = words;
  if (!machine || !folder || !account) throw new Error('usage: helm spawn <machine> <folder | -> <account> [text...] [--mkdir] [--wait] [--timeout <ms>]');
  // "-" is no folder: a quick chat, in an empty folder the machine makes.
  const quick = folder === '-';
  if (quick && options.mkdir) throw new Error('--mkdir needs a folder; a sketch (-) has none');
  if (!quick && ((!folder.startsWith('/') && folder !== '~' && !folder.startsWith('~/')) || /[\u0000-\u001f\u007f]/.test(folder))) {
    throw new Error('the target folder must start with / or ~/, or be - for a sketch');
  }
  const timeout = Number(options.timeout ?? 120_000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86_400_000) throw new Error('--timeout must be milliseconds between 1 and 86400000');
  const text = prompt.join(' ');
  if (options.wait && !text.trim()) throw new Error('--wait needs a prompt');
  return { machine, folder, account, quick, text, options, timeout };
}

/** Preflight and waiting use existing RPCs, including on an older target. */
export async function spawnAgent(args, { rpc, write = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const { machine, folder, account, quick, text, options, timeout } = parseSpawnArgs(args);
  const call = async (method, params, budget) => {
    try { return await rpc(method, params, budget); }
    catch (error) { throw new Error(`spawn on ${machine}: ${error.message}`); }
  };
  const { agents } = await call(M.AGENT_LIST, { models: false });
  let agent;
  try { agent = chooseAgent(agents, account); }
  catch (error) { throw new Error(`${error.message} on ${machine}; accounts: ${agents.map((a) => a.id).join(', ')}`); }
  if (!agent.available) throw new Error(`account "${agent.id}" is not signed in on ${machine}; sign in there before spawning a task`);

  let cwd = null;
  if (!quick) {
    const { home } = await call(M.ENV_INFO, {});
    if (!home?.startsWith('/')) throw new Error(`${machine} did not report its home folder`);
    cwd = posix.resolve(folder === '~' ? home : folder.startsWith('~/') ? `${home}/${folder.slice(2)}` : folder);
  }
  const ensure = async (path) => {
    try { await call(M.FS_LIST, { path }); }
    catch (error) {
      if (!/ENOENT|no such file or directory/i.test(error.message)) throw error;
      if (!options.mkdir) throw new Error(`folder "${cwd}" does not exist on ${machine}; retry with --mkdir to create it`);
      await ensure(posix.dirname(path));
      try { await call(M.FS_MKDIR, { path: posix.dirname(path), name: posix.basename(path) }); }
      catch (error) {
        // Another request can create the same parent while we walk upward.
        if (!/EEXIST|file exists/i.test(error.message)) throw error;
      }
      await call(M.FS_LIST, { path });
    }
  };
  if (cwd) await ensure(cwd);
  // Leave unset choices to Sessions.start on the target: its own account
  // defaults include model, effort, permissions and speed.
  const { session } = await call(M.SESSION_START, { ...(quick ? { quick: true } : { cwd }), profileId: agent.id,
    model: options.model, mode: options.mode, effort: options.effort, title: options.title }, 60_000);
  write(`${session.id}  ${session.title}  (${agent.engine} on ${machine}, ${quick ? 'sketch' : cwd})\n`);
  if (!text) return { session };
  try { await call(M.SESSION_INPUT, { id: session.id, data: text }); }
  catch (error) { throw new Error(`${error.message}; session ${session.id} was started. Read it with helm thread ${session.id} before retrying`); }
  if (!options.wait) { write('prompted.\n'); return { session }; }

  const deadline = now() + timeout;
  while (now() < deadline) {
    const history = await call(M.SESSION_EVENTS, { id: session.id, tail: 1000, limit: 1000 }, Math.min(25_000, deadline - now()));
    const reply = delegationOutput(history.session ?? session, history.events ?? []);
    if (reply.complete || reply.status === 'blocked' || (history.pending ?? []).length) {
      if (reply.output) write(`${reply.output}\n`);
      if (reply.status === 'blocked' || history.pending?.length) throw new Error(`task ${session.id} on ${machine} needs your input; open it in the app or run helm thread ${session.id}`);
      if (reply.status !== 'done') throw new Error(`task ${session.id} on ${machine} ${reply.status}: ${reply.error || 'read the thread for details'}`);
      return reply;
    }
    if (['error', 'exited', 'interrupted'].includes(history.session?.status)) throw new Error(`task ${session.id} on ${machine} ${history.session.status}; run helm thread ${session.id}`);
    await sleep(Math.min(500, Math.max(0, deadline - now())));
  }
  // Waiting is a viewer choice: timing out must leave the remote task alive.
  throw new Error(`timed out waiting for task ${session.id} on ${machine}; it was left running. Read it with helm thread ${session.id}`);
}
