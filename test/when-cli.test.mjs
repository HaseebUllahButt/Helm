import './automation-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../packages/connect/src/agent.js';
import { Schedules } from '../packages/connect/src/schedules.js';
import { runWhenCommand } from '../packages/connect/src/when-cli.js';
import { runScheduleCommand } from '../packages/connect/src/schedule-cli.js';
import { commandHelp, USAGE } from '../packages/connect/src/help.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'helm-when-'));
  const sessions = { get: id => ({ id, driver: 'claude' }) };
  const schedules = new Schedules({ sessions, directory, triggers: { account: async account => account } });
  t.after(() => { schedules.stop(); rmSync(directory, { recursive: true, force: true }); });
  const machine = { id: 'remote', name: 'Laptop' };
  const net = { self: 'local', machines: { local: { id: 'local', name: 'Here' }, remote: machine } };
  const lines = [];
  const deps = { net, machineId: name => Object.values(net.machines).find(m => m.name === name).id,
    write: line => lines.push(line),
    rpc: (env, method, params) => {
      if (env !== machine.id) throw new Error('Machine offline.');
      return Daemon.prototype.dispatch.call({ schedules }, method, params);
    },
  };
  return { schedules, lines, deps, run: (...args) => runWhenCommand(args, deps) };
}

test('helm when creates through the schedules RPC and shares its controls', async t => {
  const { schedules, lines, run, deps } = fixture(t);
  schedules.save({ sessionId: 'old', name: 'Old schedule', prompt: 'Old schedule', intervalMinutes: 5 });
  await run('webhook', '--machine', 'Laptop', '--account', 'work', '--cooldown', '5', '--', 'Read this');
  const id = schedules.list().schedules[1].id;
  const token = schedules.list().schedules[1].webhook.path.split('/').at(-1);
  assert.match(lines[0], /Added trigger .* on Laptop/);
  assert.doesNotMatch(lines.join('\n'), new RegExp(token));
  await run('list');
  assert.match(lines.join('\n'), /Webhook POST/);
  assert.doesNotMatch(lines.join('\n'), /Old schedule/);
  await runScheduleCommand(['list'], deps);
  assert.match(lines.join('\n'), /Old schedule/);
  await run('show', id, '--json');
  assert.doesNotMatch(lines.at(-1), new RegExp(token));
  await run('show', id, '--link');
  assert.match(lines.join('\n'), new RegExp(token));
  await run('pause', id, '--machine', 'Laptop');
  assert.equal(schedules.list().schedules[1].enabled, false);
  await runScheduleCommand(['resume', id], deps);
  assert.equal(schedules.list().schedules[1].enabled, true);
  await run('remove', id);
  assert.equal(schedules.list().schedules.length, 1);
});

test('helm when validates event options and documents all events', async t => {
  const { run } = fixture(t);
  await assert.rejects(run('file-change', '--run', 'echo test'), /--path or --glob/);
  await assert.rejects(run('command-change', '--check', 'true', '--run', 'true'), /--every/);
  await assert.rejects(run('machine-online', '--check', 'true', '--run', 'true'), /Check "--check"/);
  await assert.rejects(run('chat-finished', '--run', 'true', '--', 'Another task'), /quoted task/);
  for (const event of ['file-change', 'command-change', 'webhook', 'chat-finished', 'machine-online']) assert.match(commandHelp('when', USAGE), new RegExp(event));
});

test('helm when reports an older machine before sending a trigger', async t => {
  const { deps } = fixture(t);
  const calls = [];
  deps.rpc = async (_machine, method) => { calls.push(method); return { schedules: [] }; };
  await assert.rejects(runWhenCommand(['webhook', '--machine', 'Laptop', '--run', 'true'], deps), /Update Helm on Laptop/);
  assert.deepEqual(calls, ['schedule.list']);
});
