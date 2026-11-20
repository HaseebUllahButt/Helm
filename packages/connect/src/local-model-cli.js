import { randomBytes } from 'node:crypto';
import { M } from '@helm/protocol';
import { parseAgentArgs } from './agent-args.js';
import { hosts, modelName } from './local-model-state.js';

const HELP = 'Use helm models serve <model> [--machine <name>|auto], helm models list, or helm models stop <model> [--machine <name>].';
const LOOKUP_MS = 5000;

export function freeGpu(stats) {
  return Math.max(0, ...(stats?.gpus ?? []).map(({ memory }) => {
    if (!Number.isFinite(memory?.total) || !Number.isFinite(memory?.used)) return 0;
    return memory.total - memory.used;
  }));
}

async function pickHost(machines, self, rpc) {
  const readings = await Promise.all(machines.map(async (machine) => {
    try { return { machine, stats: await rpc(machine.id, M.MACHINE_STATS, {}, LOOKUP_MS) }; }
    catch { return null; }
  }));
  const online = readings.filter((r) => r?.stats);
  online.sort((a, b) => freeGpu(b.stats) - freeGpu(a.stats)
    || Number(a.stats.gpus?.length > 0) - Number(b.stats.gpus?.length > 0)
    || Number(b.machine.id === self) - Number(a.machine.id === self)
    || (b.stats.memory?.total - b.stats.memory?.used || 0) - (a.stats.memory?.total - a.stats.memory?.used || 0)
    || a.machine.id.localeCompare(b.machine.id));
  if (!online.length) throw new Error('No machine answered the load check. Try helm machines --load.');
  return { ...online[0].machine, cpu: freeGpu(online[0].stats) === 0 };
}

const memory = (bytes) => Number.isFinite(bytes) ? `${Math.round(bytes / 2 ** 20)} MiB` : 'unknown';

function modelLine(row, machine) {
  const state = row.state === 'loaded' && row.gpu === 0 ? 'loaded on CPU'
    : row.state === 'loaded' && row.memory > 0 ? 'loaded on GPU and CPU'
    : row.state === 'loaded' && row.gpu > 0 ? 'loaded on GPU' : row.state;
  return `${row.model} on ${machine} · ${state} · GPU memory ${memory(row.gpu)} · system memory ${memory(row.memory)}`;
}

function compatibility(error, machine) {
  if (/unknown method|not supported/i.test(error.message)) return new Error(`Update Helm on ${machine} to use shared models.`);
  return error;
}

async function status(machines, rpc) {
  return Promise.all(machines.map(async (machine) => {
    try { return { ...machine, ...await rpc(machine.id, M.LOCAL_MODELS_LIST, {}, LOOKUP_MS) }; }
    catch (error) { return { ...machine, error }; }
  }));
}

async function waitForWork(host, action, model, rpc, write) {
  const request = { id: randomBytes(16).toString('hex'), action, model };
  let receipt;
  try { receipt = await rpc(host.id, M.LOCAL_MODELS_WORK, request, 15_000); }
  catch (error) {
    if (!error.uncertain) throw compatibility(error, host.name);
    receipt = await rpc(host.id, M.LOCAL_MODELS_JOB, { id: request.id }, 25_000);
    if (!receipt) throw new Error(`Could not confirm the request on ${host.name}. Run helm models list to check.`);
  }
  if (receipt.state === 'working') write(action === 'serve' ? `Preparing ${model} on ${host.name}.` : `Stopping ${model} on ${host.name}.`);
  const id = receipt.id;
  while (receipt.state === 'working') {
    try { receipt = await rpc(host.id, M.LOCAL_MODELS_JOB, { id }, 25_000); }
    catch (error) {
      throw new Error(`Could not read the result on ${host.name}. This request can continue there. Run helm models list to check. ${error.message}`);
    }
    if (!receipt) throw new Error(`Could not find the request on ${host.name}. Run helm models list to check.`);
  }
  if (receipt.state === 'failed') throw new Error(`${host.name}. ${receipt.error}`);
  return receipt.result;
}

export async function runModelsCommand(args, { net, rpc, machineId, write = console.log, warn = console.error } = {}) {
  const { words, options } = parseAgentArgs(args, { values: ['machine'] });
  const [command, value] = words;
  const machines = hosts(net);
  const explicit = options.machine && options.machine !== 'auto';
  const selected = explicit ? machines.find((m) => m.id === machineId(options.machine)) : null;
  if (explicit && !selected) throw new Error('That machine is not in this network.');
  const endpoint = async (host) => {
    try { return (await rpc(net.self, M.LOCAL_MODELS_ENDPOINT, { host: host.id }, 25_000)).url; }
    catch (error) { warn(`Could not open the model address on ${host.name}. ${compatibility(error, host.name).message}`); return null; }
  };
  if ((!command || command === 'list') && words.length <= 1 && !options.machine) {
    const rows = await status(machines, rpc);
    const found = rows.filter((host) => host.models?.length);
    const urls = await Promise.all(found.map((host) =>
      host.models.some((r) => ['ready', 'loaded'].includes(r.state)) ? endpoint(host) : null));
    for (const [index, host] of found.entries()) {
      for (const row of host.models) write(modelLine(row, host.name));
      if (urls[index]) write(`  OpenAI address on this machine: ${urls[index]}`);
    }
    if (!found.length) write('No answering machine serves a model.');
    if (rows.some((r) => r.error)) warn(`Could not check ${rows.filter((r) => r.error).map((r) => r.name).join(', ')}.`);
    return;
  }
  if (!['serve', 'stop'].includes(command) || words.length !== 2 || (command === 'stop' && options.machine === 'auto')) throw new Error(HELP);
  const model = modelName(value);
  if (command === 'serve') {
    const rows = await status(machines, rpc);
    const existing = rows.find((host) => host.models?.some((r) => r.model === model));
    if (selected && existing && selected.id !== existing.id) {
      throw new Error(`${model} already runs on ${existing.name}. Stop it there before you serve it on ${selected.name}.`);
    }
    const host = selected ?? existing ?? await pickHost(machines, net.self, rpc);
    if (host.cpu) write(`No machine reported free GPU memory. Using ${host.name} for CPU work.`);
    const row = await waitForWork(host, command, model, rpc, write);
    write(modelLine(row, host.name));
    const url = await endpoint(host);
    if (url) write(`OpenAI address on this machine: ${url}`);
    write(`Account: local-${model}. Run helm agents to see the accounts on this machine.`);
    return;
  }
  const rows = selected ? [selected] : (await status(machines, rpc))
    .filter((host) => host.models?.some((r) => r.model === model));
  if (!rows.length) throw new Error(`No answering machine serves ${model}. Use --machine <name> to stop it on a known machine.`);
  if (rows.length > 1) throw new Error(`More than one machine serves ${model}. Use --machine <name> to choose ${rows.map((r) => r.name).join(' or ')}.`);
  const [host] = rows;
  const { stopped } = await waitForWork(host, command, model, rpc, write);
  write(stopped ? `Stopped ${model} on ${host.name}.` : `${host.name} does not serve ${model}.`);
}
