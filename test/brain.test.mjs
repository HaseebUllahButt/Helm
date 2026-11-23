import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  render, mergeSnapshot, readSnapshot, writeSnapshot, findNetworkSession,
} = await import('../packages/connect/src/brain.js');
const { M } = await import('@helm/protocol');

test('CLI lookup finds standalone leads and child helpers omitted from the digest', async () => {
  const machines = { laptop: { name: 'Laptop' }, vm: { name: 'VM' } };
  const lead = { id: '7159e75cb90b', title: 'Lead', delegation: { parentId: null } };
  const child = { id: 'f5383e2abde5', title: 'Mountains', delegation: { parentId: lead.id } };
  const snapshot = { machines: { vm: { name: 'VM', sessions: [] } } };
  const saved = JSON.stringify(snapshot);
  const calls = [];
  const rpc = async (env, method, params) => {
    calls.push({ env, method, params });
    return { sessions: env === 'vm' ? [lead, child] : [] };
  };
  for (const [id, session] of [[lead.id, lead], ['7159e7', lead], ['f5383e', child]]) {
    assert.deepEqual(await findNetworkSession(id, { machines, snapshot, rpc }), { env: 'vm', machine: 'VM', session });
  }
  assert.ok(calls.every(c => c.method === M.SESSION_LIST && c.params.includeDelegations === true));
  // Each machine is asked for the matching chats only; these answer as an older Helm, in full.
  assert.deepEqual([...new Set(calls.map(c => c.params.find))], [lead.id, '7159e7', 'f5383e']);
  assert.equal(JSON.stringify(snapshot), saved, 'helper lookup must not change the digest snapshot');
});

test('CLI lookup rejects prefixes shared by a regular session and a hidden helper', async () => {
  const rpc = async env => ({ sessions: [{
    id: env === 'laptop' ? 'abcdef111111' : 'abcdef222222', title: env,
    ...(env === 'vm' ? { delegation: { parentId: 'lead' } } : {}),
  }] });
  const options = { machines: { laptop: { name: 'Laptop' }, vm: { name: 'VM' } }, snapshot: {}, rpc };
  await assert.rejects(findNetworkSession('abcdef', options), /matches 2 sessions:\n  Laptop  abcdef111111.*\n  VM  abcdef222222/s);
  assert.equal((await findNetworkSession('abcdef222222', options)).env, 'vm');
});

test('CLI lookup retains offline candidates and rejects live/offline prefix collisions', async () => {
  const offline = { id: 'abcdef222222', title: 'Offline work' };
  const options = {
    machines: { laptop: { name: 'Laptop' }, vm: { name: 'VM' } },
    snapshot: { machines: { vm: { name: 'VM', sessions: [offline] }, removed: { sessions: [{ id: 'gone' }] } } },
    rpc: async env => {
      if (env === 'vm') throw new Error('offline');
      return { sessions: [{ id: 'abcdef111111', title: 'Live work' }] };
    },
  };
  assert.deepEqual(await findNetworkSession(offline.id, options), { env: 'vm', machine: 'VM', session: offline });
  await assert.rejects(findNetworkSession('abcdef', options), /matches 2 sessions/);
  await assert.rejects(findNetworkSession('gone', options), /no session/);
});

test('CLI lookup finds a helper saved under its lead while that machine restarts', async () => {
  const options = {
    machines: { laptop: { name: 'Laptop' } },
    snapshot: { machines: { laptop: { name: 'Laptop', sessions: [
      { id: 'c6df5f000000', title: 'Coordinator', helpers: [{ id: '397140aaaaaa', title: 'Helper', depth: 1 }] },
    ] } } },
    rpc: async () => { throw new Error('timed out'); },
  };
  const hit = await findNetworkSession('397140', options);
  assert.equal(hit.env, 'laptop');
  assert.equal(hit.session.id, '397140aaaaaa');
});

test('CLI lookup waits for a machine that is restarting instead of calling the id unknown', async () => {
  const helper = { id: '713142bbbbbb', title: 'Helper', delegation: { parentId: 'lead' } };
  let tries = 0;
  const waits = [], slept = [];
  const options = {
    machines: { laptop: { name: 'Laptop' }, vm: { name: 'VM' } },
    snapshot: { machines: {} },
    rpc: async (env) => {
      if (env === 'vm') return { sessions: [] };
      if (++tries < 3) throw new Error('connect ECONNREFUSED 127.0.0.1:8787');
      return { sessions: [helper] };
    },
    waitMs: 60_000, onWait: (names) => waits.push(names), sleep: async (ms) => { slept.push(ms); },
  };
  assert.deepEqual(await findNetworkSession('713142', options), { env: 'laptop', machine: 'Laptop', session: helper });
  assert.deepEqual(waits, ['Laptop', 'Laptop']);
  assert.deepEqual(slept, [1000, 2000], 'backs off between tries');
});

test('CLI lookup says a silent machine is busy, not that the session is gone', async () => {
  const options = {
    machines: { laptop: { name: 'Laptop' }, vm: { name: 'VM' } },
    snapshot: { machines: {} },
    rpc: async (env) => { if (env === 'laptop') throw new Error('timed out'); return { sessions: [] }; },
    waitMs: 5000, sleep: async () => {},
  };
  let asked = 0;
  const offline = { ...options, rpc: async (env) => { asked++; return options.rpc(env); }, waitFor: () => false, sleep: () => assert.fail('no wait for a machine off for long') };
  await assert.rejects(findNetworkSession('397140', offline), /Laptop did not answer/);
  assert.equal(asked, 2, 'one try each, no waiting');
  await assert.rejects(findNetworkSession('397140', options),
    (err) => err.code === 'busy' && /Laptop did not answer \(offline, restarting or busy\)/.test(err.message));
});

test('CLI lookup uses a live empty inventory instead of a stale cached match', async () => {
  const options = {
    machines: { vm: { name: 'VM' } },
    snapshot: { machines: { vm: { sessions: [{ id: 'removed', title: 'Old' }] } } },
    rpc: async () => ({ sessions: [] }),
  };
  await assert.rejects(findNetworkSession('removed', options), /no session "removed"/);
  await assert.rejects(findNetworkSession('', options), /which session/);
});

// An offline machine that simply vanishes is the failure that matters here:
// the brain would report "nothing is running there", which is a wrong answer
// rather than a missing one.
test('a machine that did not answer keeps its last known state, dated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-brain-'));
  const file = join(dir, 'snapshot.json');
  try {
    const t0 = Date.now() - 3 * 3600 * 1000;
    writeSnapshot({ at: t0, machines: { lap: { name: 'laptop', at: t0, sessions: [{ id: 'z9', title: 'refactor', cwd: '/w', engine: 'codex', status: 'idle' }] } } }, file);

    const merged = mergeSnapshot(readSnapshot(file), { vm: { name: 'vm', sessions: [] } });
    assert.ok(merged.machines.lap, 'the sleeping machine is still there');
    assert.equal(merged.machines.lap.sessions.length, 1);
    assert.equal(merged.machines.lap.at, t0, 'and still dated when it was last seen');

    const text = render(merged, { roster: { vm: { name: 'vm', online: true }, lap: { name: 'laptop', online: false } } });
    assert.match(text, /laptop \(offline · last seen 3h ago\)/);
    assert.match(text, /refactor/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
