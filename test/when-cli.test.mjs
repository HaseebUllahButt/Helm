import './automation-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../packages/connect/src/agent.js';
import { Schedules } from '../packages/connect/src/schedules.js';
import { runWhenCommand } from '../packages/connect/src/when-cli.js';

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
  return { schedules, lines, run: (...args) => runWhenCommand(args, deps) };
}

test('helm when never prints the webhook link unless asked', async t => {
  const { schedules, lines, run } = fixture(t);
  await run('webhook', '--machine', 'Laptop', '--account', 'work', '--cooldown', '5', '--', 'Read this');
  const id = schedules.list().schedules[0].id;
  const token = schedules.list().schedules[0].webhook.path.split('/').at(-1);
  await run('list');
  await run('show', id, '--json');
  assert.doesNotMatch(lines.join('\n'), new RegExp(token));
  await run('show', id, '--link');
  assert.match(lines.join('\n'), new RegExp(token));
});
