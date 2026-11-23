import test from 'node:test';
import assert from 'node:assert/strict';
import { M } from '@helm/protocol';
import { spawnAgent } from '../packages/connect/src/spawn-cli.js';

function fixture({ folders = ['/home', '/home/vm', '/home/vm/project'], histories = [] } = {}) {
  const calls = [], dirs = new Set(['/', ...folders]);
  let time = 0;
  const rpc = async (method, p) => {
    calls.push({ method, p });
    if (method === M.AGENT_LIST) return { agents: [{ id: 'codexp', engine: 'codex', available: true }] };
    if (method === M.ENV_INFO) return { home: '/home/vm' };
    if (method === M.FS_LIST) { if (!dirs.has(p.path)) throw Error('ENOENT: no such file or directory'); return { entries: [] }; }
    if (method === M.FS_MKDIR) { const path = `${p.path}/${p.name}`; assert.ok(dirs.has(p.path)); dirs.add(path); return { path }; }
    if (method === M.SESSION_START) return { session: { id: 'remote-task', title: 'Project', status: 'starting', cwd: p.cwd } };
    if (method === M.SESSION_INPUT) return {};
    if (method === M.SESSION_EVENTS) return histories.shift() ?? { session: { status: 'working' }, events: [] };
    throw Error(`Unexpected RPC: ${method}`);
  };
  return { deps: { rpc, write: () => {}, now: () => time, sleep: async (ms) => { time += ms; } }, calls, dirs };
}
const reply = (status = 'ok', text = 'Hi from VM') => ({ session: { status: 'idle' }, events: [
  { type: 'turn.start', turnId: 'one' }, { type: 'item.start', id: 'text', kind: 'text' },
  { type: 'item.delta', id: 'text', text }, { type: 'turn.done', turnId: 'one', status },
] });

test('spawn preflights the target folder and requires --mkdir before creating it', async () => {
  const f = fixture({ folders: ['/home', '/home/vm'] });
  await assert.rejects(spawnAgent(['VM', '~/project/deeper', 'codex', 'hi'], f.deps), /folder "\/home\/vm\/project\/deeper" does not exist on VM.*--mkdir/);
  assert.equal(f.calls.some(c => c.method === M.SESSION_START || c.method === M.FS_MKDIR), false);
  await spawnAgent(['VM', '~/project/deeper', 'codex', 'hi', '--mkdir'], f.deps);
  assert.ok(f.dirs.has('/home/vm/project/deeper'));
  const start = f.calls.find(c => c.method === M.SESSION_START).p;
  assert.equal(start.cwd, '/home/vm/project/deeper');
  assert.equal(start.profileId, 'codexp');
});

test('spawn --wait reports blocked, failed and timed out tasks without interrupting them', async () => {
  for (const [histories, expected] of [
    [[{ session: { status: 'blocked' }, events: [], pending: [{ requestId: 'ask' }] }], /remote-task on VM needs your input/],
    [[reply('error')], /remote-task on VM error/],
    [[], /timed out.*remote-task.*left running/],
  ]) {
    const f = fixture({ histories });
    await assert.rejects(spawnAgent(['VM', '~/project', 'codex', '--wait', '--timeout', '1000', 'hi'], f.deps), expected);
    assert.equal(f.calls.some(c => [M.SESSION_INTERRUPT, M.SESSION_KILL].includes(c.method)), false);
  }
});
