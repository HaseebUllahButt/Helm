import { M } from '@helm/protocol';
import { runScheduleCommand } from './schedule-cli.js';

const events = {
  'file-change': ['--path', '--glob'],
  'command-change': ['--check', '--every'],
  webhook: [],
  'chat-finished': ['--chat'],
  'machine-online': ['--watch-machine'],
};
const options = ['--machine', '--account', '--cooldown', '--cwd', '--name', '--run'];

export async function runWhenCommand(args, deps) {
  const [kind = 'list', ...rest] = args;
  if (['list', 'show', 'pause', 'resume', 'remove'].includes(kind)) {
    return runScheduleCommand([kind, ...rest.map(arg => arg === '--machine' ? '--on' : arg)], { ...deps, triggersOnly: true });
  }
  if (!Object.hasOwn(events, kind)) throw new Error('Choose an event or command from helm when --help.');
  const end = rest.indexOf('--');
  const words = end < 0 ? rest : rest.slice(0, end);
  const task = end < 0 ? [] : rest.slice(end + 1);
  const values = new Map();
  for (let i = 0; i < words.length; i += 2) {
    const opt = words[i], value = words[i + 1];
    if (![...options, ...events[kind]].includes(opt) || values.has(opt)) throw new Error(`Check "${opt}" in helm when --help.`);
    if (!value || value.startsWith('--')) throw new Error(`Give a value after ${opt}.`);
    values.set(opt, value);
  }
  const command = values.get('--run');
  if (command ? end >= 0 : task.length !== 1) throw new Error('Give a quoted task after --, or use --run with a quoted command.');
  if (command && values.has('--account')) throw new Error('Use --account with a task prompt.');
  const event = { kind };
  if (kind === 'file-change') {
    if (values.has('--path') === values.has('--glob')) throw new Error('Use --path or --glob.');
    event.pattern = values.has('--glob');
    event.path = values.get('--glob') ?? values.get('--path');
  } else if (kind === 'command-change') {
    event.check = values.get('--check');
    event.everyMinutes = Number(values.get('--every'));
    if (!event.check || !Number.isInteger(event.everyMinutes) || event.everyMinutes < 1) throw new Error('Give a check command with --check and minutes with --every.');
  } else if (kind === 'chat-finished') {
    event.chatId = values.get('--chat');
  } else if (kind === 'machine-online' && values.has('--watch-machine')) {
    event.machineId = deps.machineId(values.get('--watch-machine'));
  }
  const machine = values.has('--machine') ? deps.machineId(values.get('--machine')) : deps.net.self;
  const cooldownSeconds = values.has('--cooldown') ? Number(values.get('--cooldown')) : undefined;
  if (cooldownSeconds != null && (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 1 || cooldownSeconds > 86400)) {
    throw new Error('Give a cool-down of 1 to 86400 seconds.');
  }
  const machineName = deps.net.machines[machine].name;
  if (machine !== deps.net.self && deps.contextChatId) {
    const { session } = await deps.rpc(deps.net.self, M.SESSION_EVENTS, { id: deps.contextChatId, tail: 1, limit: 1 }, 10_000);
    if (['plan', 'readonly', 'read'].includes(session?.mode)) throw new Error('Leave read-only mode before adding a trigger.');
  }
  const supports = await deps.rpc(machine, M.SCHEDULE_LIST, { includeLinks: false }, 10_000);
  if (!supports.supportsTriggers) throw new Error(`Update Helm on ${machineName} to add triggers.`);
  const { schedule } = await deps.rpc(machine, M.SCHEDULE_SAVE, {
    type: 'event', event, command, prompt: task[0], account: values.get('--account'),
    cwd: values.get('--cwd') ?? (machine === deps.net.self ? deps.cwd : undefined), name: values.get('--name'),
    contextChatId: machine === deps.net.self ? deps.contextChatId : undefined, cooldownSeconds,
  }, 30_000);
  const write = deps.write ?? console.log;
  write(`Added trigger ${schedule.id} on ${machineName}.`);
  if (kind === 'webhook') write(`Show its private address with helm when show ${schedule.id} --link.`);
  return 0;
}
