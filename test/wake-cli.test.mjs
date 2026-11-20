import test from 'node:test';
import assert from 'node:assert/strict';
import { M } from '@helm/protocol';
import { parseWakeArgs, wakeMachine } from '../packages/connect/src/wake-cli.js';
import { parseWorkArgs, runRemoteWork } from '../packages/connect/src/execution-cli.js';
import { runAgentCommand } from '../packages/connect/src/agent-cli.js';
import { spawnAgent } from '../packages/connect/src/spawn-cli.js';

const link = { network: '192.168.1.0', prefix: 24, router: '12:34:56:78:90:ab', mac: 'aa:bb:cc:dd:ee:ff' };

function fixture({ targetOnline = false, senderOnline = true, connects = true, records } = {}) {
  const calls = [];
  const net = { self: 'local', machines: { remote: { name: 'Desk' }, local: { name: 'Laptop' }, peer: { name: 'VM' } } };
  let time = 0;
  return { calls, deps: {
    load: () => net,
    state: { records: () => records ?? {
      remote: { receivers: [link], links: [] },
      local: { links: [{ ...link, mac: null }] },
      peer: { links: [{ ...link, router: '12:34:56:78:90:ac' }] },
    } },
    rpc: async (_, id, method) => {
      calls.push([method, id]);
      if (id === 'remote' ? targetOnline : senderOnline) return { wakeSender: true };
      throw Object.assign(new Error('No answer.'), { code: 'unreachable' });
    },
    exec: async (sender, target) => { calls.push(['exec', sender, target]); return 0; },
    write: line => calls.push(line),
    now: () => time,
    sleep: async duration => { time += duration; if (connects) targetOnline = true; },
  } };
}

test('wake sends through a live machine on the shared network, then waits for a live target', async () => {
  const { deps, calls } = fixture();
  await wakeMachine('remote', { ...deps, waitMs: 60_000 });
  assert.deepEqual(calls, [
    [M.PING, 'remote'], [M.ENV_INFO, 'local'], ['exec', 'local', 'remote'],
    'Sent a wake signal for Desk from Laptop.', 'Waiting for Desk to connect.',
    [M.PING, 'remote'], [M.PING, 'remote'], 'Desk is online.',
  ]);
});

test('wake skips sending for online targets and reports missing cards, senders, and timeouts', async () => {
  const up = fixture({ targetOnline: true });
  await wakeMachine('remote', up.deps);
  assert.deepEqual(up.calls, [[M.PING, 'remote'], 'Desk is already online.']);
  await assert.rejects(wakeMachine('remote', fixture({ records: {} }).deps), /no saved wired network card/);
  await assert.rejects(wakeMachine('remote', fixture({ senderOnline: false }).deps), /No online machine shares/);
  await assert.rejects(wakeMachine('remote', { ...fixture({ connects: false }).deps, waitMs: 20 }), /did not connect before/);
  const sent = fixture();
  await wakeMachine('remote', sent.deps);
  assert.equal(sent.calls.filter(call => Array.isArray(call) && call[0] === M.PING).length, 1);
});

test('wake and exec validate flags and leave command arguments after -- alone', () => {
  assert.deepEqual(parseWakeArgs(['Desk', '--wait', '1.5']), { machine: 'Desk', waitMs: 90_000 });
  assert.throws(() => parseWakeArgs(['Desk', '--wait', '0']), /positive/);
  assert.throws(() => parseWakeArgs(['Desk', '--bogus']), /Use helm wake/);
  const parsed = parseWorkArgs(['Desk', '--wake', '--', 'echo', '--wake'], { remote: true });
  assert.equal(parsed.wake, true);
  assert.deepEqual(parsed.argv, ['echo', '--wake']);
  assert.throws(() => parseWorkArgs(['--wake', '--', 'echo']), /invalid/);
});

test('exec, spawn and delegate wait for wake before asking the target to work', async () => {
  const args = ['Desk', '--wake', '--', 'echo', 'hello'];
  const calls = [];
  await runRemoteWork(args, {
    net: { self: 'local' }, machineId: name => name, parentId: null,
    wake: async id => { calls.push('wake on ' + id); },
    connect: async () => {
      calls.push('connect');
      return { close() {}, rpc: async method => {
        calls.push(method);
        return { status: 'exited', chunks: [], exitCode: 0 };
      } };
    },
  });
  assert.deepEqual(calls, ['wake on Desk', 'connect', M.EXEC_START, M.EXEC_READ]);
  calls.length = 0;
  const deps = { wake: async id => calls.push('wake on ' + id), write: () => {}, parentId: 'chat',
    rpc: async (...params) => {
      const method = params[0] === 'local' || params[0] === 'Desk' ? params[1] : params[0];
      calls.push(method);
      return { agents: [{ id: 'account', engine: 'codex', available: true }], session: { id: 'new-chat', engine: 'codex' } };
    } };
  await spawnAgent(['Desk', '-', 'account', '--wake'], deps);
  assert.deepEqual(calls, ['wake on Desk', M.AGENT_LIST, M.SESSION_START]);
  calls.length = 0;
  await runAgentCommand('delegate', ['account', '--machine', 'Desk', '--wake', '--', 'do work'], { ...deps, self: 'local' });
  assert.deepEqual(calls, ['wake on Desk', M.AGENT_LIST, M.SESSION_DELEGATE]);
  await assert.rejects(runAgentCommand('delegate', ['account', '--wake', '--', 'do work'], deps), /Use --wake with --machine/);
});
