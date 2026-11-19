import { setTimeout as pause } from 'node:timers/promises';
import { M } from '@helm/protocol';
import { loadNetwork } from '@helm/protocol/network';
import { possibleWakers, wakeState, WAKE_EXEC } from '@helm/protocol/wake-state';
import { hubRpc } from './hub-client.js';
import { runRemoteWork } from './execution-cli.js';

export const JOB_WAKE_WAIT_MS = 5 * 60_000;

export function parseWakeArgs(args) {
  const [machine, option, minutes] = args;
  if (!machine || machine.startsWith('-') || (args.length !== 1 && (args.length !== 3 || option !== '--wait'))) {
    throw new Error('Use helm wake <machine> [--wait <minutes>].');
  }
  const waitMs = args.length === 1 ? 0 : Number(minutes) * 60_000;
  if (args.length === 3 && (!Number.isSafeInteger(waitMs) || waitMs < 1)) {
    throw new Error('Set --wait to a positive number of minutes.');
  }
  return { machine, waitMs };
}

export function createWakeCommand({ machineId, write = message => process.stderr.write(message + '\n') }) {
  return (target, options = {}) => wakeMachine(target, {
    waitMs: JOB_WAKE_WAIT_MS, write, ...options,
    exec: (sender, id) => runRemoteWork([sender, '--timeout', '10000', '--', WAKE_EXEC, id], {
      net: loadNetwork(), machineId, stdout: { write: () => {} },
    }),
  });
}

/** Ask a machine itself, through any hub. A cached presence cannot start work. */
export async function wakeMachine(target, {
  waitMs = 0, write = () => {}, load = loadNetwork, state = wakeState, rpc = hubRpc,
  exec, now = Date.now, sleep = pause, signal,
} = {}) {
  const network = load();
  const name = network?.machines?.[target]?.name;
  if (!name || network.revoked?.[target]) throw new Error('Choose a machine in this Helm network.');
  const online = async (id, budget, sender = false) => {
    signal?.throwIfAborted();
    const net = load();
    if (!net?.machines?.[id] || net.revoked?.[id]) return false;
    try {
      const reply = await rpc(net, id, sender ? M.ENV_INFO : M.PING, {}, { timeout: budget, budget });
      return !sender || reply?.wakeSender === true;
    }
    catch (error) {
      if (['unreachable', 'offline', 'timeout'].includes(error.code)) return false;
      throw error;
    }
  };
  if (await online(target, 4000)) {
    write(name + ' is already online.');
    return;
  }
  signal?.throwIfAborted();
  const records = state.records(load() ?? network);
  const saved = records[target];
  if (!saved || (!saved.receivers.length && !saved.links.some(link => link.mac))) {
    throw new Error(name + ' has no saved wired network card. Connect it with a cable and start Helm there.');
  }
  const candidates = possibleWakers(records, target, network.self);
  const reachable = await Promise.all(candidates.map(async id => await online(id, 4000, true) ? id : null));
  signal?.throwIfAborted();
  const wakers = reachable.filter(Boolean);
  if (!wakers.length) throw new Error('No online machine shares a saved local network with ' + name + '.');
  let sender = null;
  for (const candidate of wakers) {
    signal?.throwIfAborted();
    if (await exec(candidate, target) === 0) { sender = candidate; break; }
  }
  signal?.throwIfAborted();
  if (!sender) throw new Error('Could not send a wake signal for ' + name + '.');
  const senderName = network.machines[sender]?.name ?? sender;
  write('Sent a wake signal for ' + name + ' from ' + senderName + '.');
  if (!waitMs) return;
  write('Waiting for ' + name + ' to connect.');
  const deadline = now() + waitMs;
  for (let remaining = deadline - now(); remaining > 0; remaining = deadline - now()) {
    if (await online(target, Math.min(4000, remaining))) {
      write(name + ' is online.');
      return;
    }
    const delay = Math.min(2000, deadline - now());
    if (delay > 0) await sleep(delay, undefined, { signal });
  }
  throw new Error(name + ' did not connect before the wait ended. Check its power and run helm doctor there.');
}
