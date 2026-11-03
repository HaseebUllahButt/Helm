import { M } from '@helm/protocol';

/**
 * `helm schedule`: see and control the scheduled tasks that machines still
 * run. The app has no schedule screen since 2026-10-17; this is the owner's
 * way to find, pause, resume and remove them. Making new ones stays out.
 */
export const SCHEDULE_USAGE = 'helm schedule list | show <id> [--link] | pause <id> | resume <id> | remove <id> [--on <machine>] [--json]';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const when = (at) => at ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never';

/** What starts a run, in a few words. */
export function describeTrigger(s) {
  if (s.type === 'webhook') return 'when its webhook gets a POST';
  if (s.type === 'fixed_time') {
    const days = s.weekdays?.length ? ` on ${[...s.weekdays].sort().map((d) => DAYS[d]).join(', ')}` : '';
    return `daily at ${s.timeOfDay} (${s.timeZone})${days}`;
  }
  const n = s.intervalMinutes;
  return n % 1440 === 0 ? `every ${n / 1440} day${n === 1440 ? '' : 's'}`
    : n % 60 === 0 ? `every ${n / 60} hour${n === 60 ? '' : 's'}` : `every ${n} min`;
}

function nextRun(s, now) {
  if (!s.enabled) return 'paused';
  if (s.type === 'webhook') return 'waits for a POST';
  return !s.nextRunAt || s.nextRunAt <= now ? 'next run: now' : `next run: ${when(s.nextRunAt)}`;
}

/**
 * @param {string[]} args  the words after `helm schedule`
 * @param {object} deps    net, rpc(env, method, params, timeout), machineId(name), write, now
 */
export async function runScheduleCommand(args, { net, rpc, machineId, write = console.log, now = Date.now } = {}) {
  const on = args.indexOf('--on') >= 0 ? args[args.indexOf('--on') + 1] : undefined;
  if (args.includes('--on') && (!on || on.startsWith('--'))) throw new Error('Give a machine name after --on.');
  const json = args.includes('--json');
  const showLink = args.includes('--link');
  const words = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--on');
  const verb = words.shift() ?? 'list';
  const machines = on ? [net.machines[machineId(on)]]
    : Object.values(net.machines ?? {}).filter((m) => !net.revoked?.[m.id]);

  /** Every machine's schedules. A machine that does not answer is named, not hidden. */
  const gather = async () => Promise.all(machines.map(async (m) => {
    try {
      const r = await rpc(m.id, M.SCHEDULE_LIST, {}, m.id === net.self ? 10_000 : 5000);
      return { machine: m, schedules: r.schedules ?? [], error: r.error || null };
    } catch (error) { return { machine: m, schedules: [], unreachable: error.message }; }
  }));

  if (verb === 'list' || verb === 'ls') {
    if (words.length) throw new Error(SCHEDULE_USAGE);
    const rows = await gather();
    if (json) {
      const hide = (s) => s.webhook ? { ...s, webhook: { ...s.webhook, path: undefined, url: undefined } } : s;
      write(JSON.stringify(rows.map(({ machine, schedules, ...r }) => ({ machine: machine.name, machineId: machine.id, ...r, schedules: schedules.map(hide) }))));
      return 0;
    }
    if (!rows.some((r) => r.schedules.length)) write('\n  No machine has scheduled tasks.');
    for (const { machine, schedules, error } of rows) {
      if (!schedules.length) continue;
      write(`\n  ${machine.name}${error ? `  (schedules stopped: ${error})` : ''}`);
      for (const s of schedules) {
        write(`    ${s.id.slice(0, 8)}  ${s.name}  ${describeTrigger(s)}  ${nextRun(s, now())}  chat ${String(s.sessionId).slice(0, 8)}`);
        if (s.lastError) write(`              last error: ${s.lastError}`);
      }
    }
    const missed = rows.filter((r) => r.unreachable).map((r) => r.machine.name);
    if (missed.length) write(`\n  Could not reach: ${missed.join(', ')}.`);
    write('');
    return 0;
  }

  if (!['show', 'pause', 'resume', 'remove', 'rm', 'delete'].includes(verb)) throw new Error(SCHEDULE_USAGE);
  const wanted = String(words[0] ?? '').toLowerCase();
  if (!/^[a-f0-9]{4,16}$/.test(wanted) || words.length > 1) throw new Error(`Give the schedule id from helm schedule list: helm schedule ${verb} <id>.`);
  const rows = await gather();
  const found = rows.flatMap((r) => r.schedules.filter((s) => s.id.startsWith(wanted)).map((s) => ({ machine: r.machine, s })));
  if (found.length > 1) throw new Error(`"${wanted}" matches ${found.length} schedules: ${found.map((f) => `${f.s.id} on ${f.machine.name}`).join(', ')}. Use more characters.`);
  if (!found.length) {
    const missed = rows.filter((r) => r.unreachable).map((r) => r.machine.name);
    throw new Error(`No schedule "${wanted}" found.${missed.length ? ` Could not reach: ${missed.join(', ')}.` : ''} Run helm schedule list.`);
  }
  const [{ machine, s }] = found;
  const short = s.id.slice(0, 8);

  if (verb === 'show') {
    // The webhook link holds its password. Print it only when asked.
    const link = (text) => text && !showLink ? text.replace(/[a-f0-9]{48}$/, '<hidden: add --link>') : text;
    const shown = s.webhook ? { ...s, webhook: { ...s.webhook, path: link(s.webhook.path), url: link(s.webhook.url) } } : s;
    if (json) { write(JSON.stringify({ machine: machine.name, machineId: machine.id, schedule: shown })); return 0; }
    const deliveries = s.deliveries ?? [];
    const count = (status) => deliveries.filter((d) => d.status === status).length;
    write(`\n  ${s.name}  (${s.id} on ${machine.name})`);
    write(`  Runs:       ${describeTrigger(s)}`);
    write(`  State:      ${s.enabled ? 'on' : 'paused'}, ${nextRun(s, now())}`);
    write(`  Chat:       ${s.sessionId}${s.freshThread ? ' (each run starts a new chat from it)' : ''}`);
    write(`  Last run:   ${when(s.lastRunAt)}${s.lastSessionId ? ` in chat ${s.lastSessionId}` : ''}`);
    if (s.lastError) write(`  Last error: ${s.lastError}`);
    if (s.dispatching) write('  Sending:    a run is in progress or waits to finish after a restart');
    if (s.webhook) {
      write(`  Webhook:    ${shown.webhook.url ?? `no public address (path ${shown.webhook.path})`}`);
      write(`  Signature:  ${s.webhook.hasSecret ? 'required (X-Hub-Signature-256)' : 'not required'}`);
      write(`  Posts:      ${count('sent')} sent, ${count('pending')} waiting, ${count('error')} failed`);
    }
    write('  Task:');
    for (const line of String(s.prompt).split('\n')) write(`    ${line}`);
    write('');
    return 0;
  }

  if (verb === 'pause') {
    await rpc(machine.id, M.SCHEDULE_SAVE, { id: s.id, enabled: false }, 15_000);
    write(`\n  Paused "${s.name}" on ${machine.name}. It does not run until you resume it.`);
    if (s.type === 'webhook') write('  Its webhook link takes no posts while it is paused.');
    write(`  Resume it with: helm schedule resume ${short}\n`);
    return 0;
  }

  if (verb === 'resume') {
    const { schedule } = await rpc(machine.id, M.SCHEDULE_SAVE, { id: s.id, enabled: true }, 15_000);
    const next = s.type === 'webhook' ? 'Its webhook link takes posts again.' : `It ${nextRun(schedule ?? { ...s, enabled: true }, now()).replace('next run: ', 'runs next: ')}.`;
    write(`\n  Resumed "${s.name}" on ${machine.name}. ${next}\n`);
    return 0;
  }

  await rpc(machine.id, M.SCHEDULE_DELETE, { id: s.id }, 15_000);
  write(`\n  Removed "${s.name}" from ${machine.name} for good. It does not run again, and Helm cannot bring it back.`);
  if (s.type === 'webhook') write('  Its webhook link stops for good. Posts that still waited are dropped.');
  write('  Chats it started stay. To stop it only for a while, use pause instead.\n');
  return 0;
}
