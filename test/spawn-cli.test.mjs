import test from 'node:test';
import assert from 'node:assert/strict';
import { M } from '@helm/protocol';
import { parseSpawnArgs, spawnAgent } from '../packages/connect/src/spawn-cli.js';
import { parseTaskArgs } from '../packages/connect/src/task-cli.js';

function fixture({ folders = ['/home', '/home/vm', '/home/vm/project'], agents, histories = [] } = {}) {
  const calls = [], dirs = new Set(['/', ...folders]);
  let output = '', time = 0;
  const rpc = async (method, p) => {
    calls.push({ method, p });
    if (method === M.AGENT_LIST) return { agents: agents ?? [{ id: 'codexp', engine: 'codex', available: true }] };
    if (method === M.ENV_INFO) return { home: '/home/vm' };
    if (method === M.FS_LIST) { if (!dirs.has(p.path)) throw Error('ENOENT: no such file or directory'); return { entries: [] }; }
    if (method === M.FS_MKDIR) { const path = `${p.path}/${p.name}`; assert.ok(dirs.has(p.path)); dirs.add(path); return { path }; }
    if (method === M.SESSION_START) return { session: { id: 'remote-task', title: 'Project', status: 'starting', cwd: p.cwd } };
    if (method === M.SESSION_INPUT) return {};
    if (method === M.SESSION_EVENTS) return histories.shift() ?? { session: { status: 'working' }, events: [] };
    throw Error(`Unexpected RPC: ${method}`);
  };
  return { deps: { rpc, write: (s) => { output += s; }, now: () => time, sleep: async (ms) => { time += ms; } },
    calls, dirs, output: () => output };
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
  assert.equal(start.model, undefined); assert.equal(start.mode, undefined); assert.equal(start.effort, undefined);
});

test('spawn account aliases resolve uniquely and unsigned-in accounts cannot start or create folders', async () => {
  const f = fixture({ agents: [{ id: 'a1', engine: 'claude', available: false }] });
  await assert.rejects(spawnAgent(['VM', '~/new', 'claude', '--mkdir', 'hi'], f.deps), /account "a1" is not signed in on VM/);
  assert.equal(f.calls.length, 1);
  const ambiguous = fixture({ agents: [{ id: 'a1', engine: 'claude', available: true }, { id: 'a2', engine: 'claude', available: true }] });
  await assert.rejects(spawnAgent(['VM', '~/project', 'claude', 'hi'], ambiguous.deps), /ambiguous account.*a1, a2.*VM/);
  await assert.rejects(spawnAgent(['HomePC', '~/project', 'codex', 'hi'], { rpc: async () => { throw Error('environment is not connected'); } }), /spawn on HomePC.*not connected/);
});

test('spawn --wait folds the completed first reply and preserves explicit choices', async () => {
  const f = fixture({ histories: [{ session: { status: 'working' }, events: [] }, reply()] });
  const r = await spawnAgent(['VM', '~/project', 'codexp', '--model', 'chosen', '--effort', 'high', '--mode', 'ask', '--wait', 'hi'], f.deps);
  assert.equal(r.output, 'Hi from VM');
  assert.match(f.output(), /remote-task.*VM.*Hi from VM/s);
  assert.equal(f.calls.filter(c => c.method === M.SESSION_START).length, 1);
  assert.deepEqual(f.calls.find(c => c.method === M.SESSION_START).p, { cwd: '/home/vm/project', profileId: 'codexp', model: 'chosen', mode: 'ask', effort: 'high', title: undefined });
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

test('spawn validates options and names a started session when prompting fails', async () => {
  for (const args of [ ['VM', 'relative', 'codex'], ['VM', '~/a', 'codex', '--wait'], ['VM', '~/a', 'codex', '--timeout', 'NaN'], ['VM', '~/a', 'codex', '--typo'] ]) assert.throws(() => parseSpawnArgs(args));
  const f = fixture(), rpc = f.deps.rpc;
  f.deps.rpc = async (method, p) => { if (method === M.SESSION_INPUT) throw Error('reply lost'); return rpc(method, p); };
  await assert.rejects(spawnAgent(['VM', '~/project', 'codex', 'hi'], f.deps), /session remote-task was started.*before retrying/);
});

test('send-task with an explicit source folder does not implicitly hand off the calling session', () => {
  const deps = { machineId: () => 'vm', env: { HELM_SESSION_ID: 'other-chat', HELM_CWD: '/original' } };
  assert.equal(parseTaskArgs(['VM', '--account', 'codex', 'hi'], deps).request.sessionId, 'other-chat');
  const picked = parseTaskArgs(['VM', '--account', 'codex', '--source-folder', '/different', 'hi'], deps).request;
  assert.equal(picked.folder, '/different'); assert.equal(picked.sessionId, undefined);
  assert.equal(parseTaskArgs(['VM', '--account', 'codex', '--source-folder', '/different', '--session', 'chosen', 'hi'], deps).request.sessionId, 'chosen');
  assert.throws(() => parseTaskArgs(['VM', '--account', 'codex', '--handoff-id', 'bad', 'hi'], deps), /24 lowercase/);
});

test('spawn with - as the folder starts a quick chat and never touches the file system', async () => {
  const f = fixture({ folders: ['/home', '/home/vm'] });
  await spawnAgent(['VM', '-', 'codex', 'what is 2+2'], f.deps);
  const start = f.calls.find(c => c.method === M.SESSION_START).p;
  assert.equal(start.quick, true);
  assert.equal(start.cwd, undefined);
  assert.equal(f.calls.some(c => c.method === M.FS_LIST || c.method === M.FS_MKDIR || c.method === M.ENV_INFO), false);
  assert.match(f.output(), /quick chat/);
  await assert.rejects(spawnAgent(['VM', '-', 'codex', 'hi', '--mkdir'], f.deps), /--mkdir needs a folder/);
});
