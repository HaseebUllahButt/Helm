import { M } from '@helm/protocol';
import { parseAgentArgs, chooseAgent } from './delegation.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Injected RPC keeps argument and result behavior testable without a live hub. */
export async function runAgentCommand(command, args, { rpc, self, cwd = process.cwd(),
  parentId = process.env.HELM_SESSION_ID, callerThreadId = process.env.CODEX_THREAD_ID,
  write = console.log, sleep = pause } = {}) {
  const { options, words } = parseAgentArgs(args, {
    values: command === 'delegate' ? ['model', 'mode', 'effort', 'parent', 'cwd', 'timeout'] : command === 'delegate-result' ? ['timeout'] : [],
    switches: command === 'agents' ? ['json', 'refresh'] : ['wait', 'json'],
  });
  if (command === 'agents') {
    if (words.length) throw new Error('helm agents [--json] [--refresh]');
    const result = await rpc(self, M.AGENT_LIST, { refresh: !!options.refresh }, 60_000);
    if (options.json) write(JSON.stringify(result));
    else for (const a of result.agents) {
      write(`${a.id}  ${a.engine}  ${a.auth}${a.defaultModel ? `  default: ${a.defaultModel}` : ''}`);
      if (a.models?.length) write(`  models: ${a.models.join(', ')}`);
    }
    return 0;
  }
  const timeout = options.timeout === undefined ? 300_000 : Number(options.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600_000) {
    throw new Error('--timeout must be milliseconds between 1 and 3600000');
  }
  let id;
  if (command === 'delegate') {
    const [account, ...task] = words;
    if (!account || !task.join(' ').trim()) throw new Error('helm delegate <account> [--model <id>] [--wait] [--json] -- "<task>"');
    const { agents } = await rpc(self, M.AGENT_LIST, { models: false });
    const agent = chooseAgent(agents, account);
    if (!agent.available) throw new Error(`${agent.id} is signed out; log in through its CLI first`);
    const { session } = await rpc(self, M.SESSION_DELEGATE, {
      id: options.parent ?? parentId, cwd: options.cwd ?? cwd, profileId: agent.id,
      model: options.model, mode: options.mode, effort: options.effort, task: task.join(' '),
      // Background/native Codex threads can inherit another thread's Helm
      // environment. Verify the actual caller before using that parent.
      ...(!options.parent && parentId && callerThreadId ? { callerThreadId } : {}),
    }, 70_000);
    id = session.id;
    if (!options.wait) {
      write(options.json ? JSON.stringify({ session, status: session.status })
        : `Started ${id} (${session.engine}${session.model ? ` / ${session.model}` : ''}). Read with helm delegate-result ${id} --wait`);
      return 0;
    }
  } else {
    if (words.length !== 1) throw new Error('helm delegate-result <id> [--wait] [--json]');
    id = words[0];
  }
  const deadline = Date.now() + timeout;
  let result;
  do {
    result = await rpc(self, M.SESSION_DELEGATION_RESULT, { id });
    // Approval is a result, not an unbounded tool wait. The parent can tell
    // the owner to open the child's card, then fetch the result again.
    if (!options.wait || result.complete || result.status === 'blocked') break;
    if (Date.now() >= deadline) { result = { ...result, timedOut: true }; break; }
    await sleep(Math.min(1000, Math.max(1, deadline - Date.now())));
  } while (true);
  if (options.json) write(JSON.stringify(result));
  else {
    write(`${id}: ${result.status}${result.timedOut ? ' (wait timed out; task continues)' : ''}`);
    if (result.output) write(result.output);
    if (result.error) write(result.error);
    if (result.pending) write(`Needs approval in Helm: ${result.pending.title ?? result.pending.kind}`);
  }
  return result.timedOut ? 3 : result.status === 'blocked' ? 2
    : ['error', 'interrupted'].includes(result.status) ? 1 : 0;
}
