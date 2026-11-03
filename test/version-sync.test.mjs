import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeVersion } from '../packages/connect/src/version-sync.js';

function fixture(overrides = {}) {
  const calls = [];
  const opts = { running: 'old', id: 'self', net: { machines: { self: {}, offline: {}, peer: {} } },
    currentVersion: async () => ({ full: 'old', time: 1 }),
    rebuildIfCommitted: async () => { calls.push('rebuild'); return { updated: true }; },
    selfUpdate: async () => { calls.push('github'); return { updated: true }; },
    syncFromBundle: async (bundle) => { calls.push(bundle); return { updated: true }; },
    rpc: async (_, id, method, params, budget) => {
      assert.ok(Number.isFinite(budget.budget), 'offline machines cannot hold the update check indefinitely');
      if (id === 'offline') throw new Error('offline');
      if (method === 'env.info') return { name: 'Peer', version: { full: 'new', time: 2 } };
      assert.deepEqual(params.have, ['old']);
      return { bundle: 'saved-version' };
    }, ...overrides };
  return { calls, opts };
}

test('startup/reconnect never fetches GitHub, including when no peer is online', async () => {
  const { opts, calls } = fixture({ rpc: async () => { throw new Error('offline peer'); } });
  assert.deepEqual(await synchronizeVersion(opts), { note: null });
  assert.deepEqual(calls, []);
});
test('automatic updates come from a peer, ignoring offline machines', async () => {
  const { opts, calls } = fixture();
  assert.equal((await synchronizeVersion(opts)).updated, true);
  assert.deepEqual(calls, ['saved-version']);
});
test('a live concurrent update is normal progress and never an attention warning', async () => {
  const { opts, calls } = fixture({ syncFromBundle: async () => ({ updated: false, reason: 'an update is already running' }) });
  assert.deepEqual((await synchronizeVersion(opts)).note, null);
  assert.deepEqual(calls, []);
});
test('dirty installs report the reason without fetching or overwriting edits', async () => {
  const { opts, calls } = fixture({ currentVersion: async () => ({ full: 'old', dirty: true }) });
  const result = await synchronizeVersion(opts);
  assert.match(result.note.reason, /Local changes.*blocking/);
  assert.deepEqual(calls, []);
});
test('a commit saved locally is rebuilt before attempting network updates', async () => {
  const { opts, calls } = fixture({ currentVersion: async () => ({ full: 'new' }) });
  assert.equal((await synchronizeVersion(opts)).updated, true);
  assert.deepEqual(calls, ['rebuild']);
});
test('diverged installs expose the peer name and preserve the local version', async () => {
  const { opts } = fixture({ selfUpdate: async () => ({ updated: false, reason: 'own commits' }),
    syncFromBundle: async () => ({ updated: false, diverged: true }) });
  assert.deepEqual((await synchronizeVersion(opts)).note, { diverged: true, with: 'Peer' });
});

test('a newer divergent peer does not hide a compatible update', async () => {
  const tried = [];
  const { opts } = fixture({
    net: { machines: { self: {}, wrong: {}, good: {} } },
    rpc: async (_, id, method) => method === 'env.info'
      ? { name: id, version: { full: id, time: id === 'wrong' ? 3 : 2 } }
      : { bundle: id },
    syncFromBundle: async bundle => { tried.push(bundle); return bundle === 'wrong' ? { diverged: true } : { updated: true }; },
  });
  assert.equal((await synchronizeVersion(opts)).updated, true);
  assert.deepEqual(tried, ['wrong', 'good']);
});

test('a peer that goes offline or has no bundle does not hide the next peer', async () => {
  const tried = [];
  const { opts } = fixture({
    net: { machines: { self: {}, offline: {}, empty: {}, good: {} } },
    rpc: async (_, id, method) => {
      if (method === 'env.info') return { name: id, version: { full: id, time: { offline: 4, empty: 3, good: 2 }[id] } };
      tried.push(id);
      if (id === 'offline') throw new Error('offline');
      return { bundle: id === 'empty' ? null : id };
    },
    syncFromBundle: async bundle => ({ updated: bundle === 'good' }),
  });
  assert.equal((await synchronizeVersion(opts)).updated, true);
  assert.deepEqual(tried, ['offline', 'empty', 'good']);
});

test('the first divergence is reported if no peer can update this machine', async () => {
  const { opts } = fixture({
    net: { machines: { self: {}, first: {}, second: {} } },
    rpc: async (_, id, method) => method === 'env.info'
      ? { name: id, version: { full: id, time: id === 'first' ? 3 : 2 } }
      : { bundle: id },
    syncFromBundle: async () => ({ updated: false, diverged: true }),
  });
  assert.deepEqual((await synchronizeVersion(opts)).note, { diverged: true, with: 'first' });
});

test('a local update error stops the search for another bundle', async () => {
  const tried = [];
  const { opts } = fixture({
    net: { machines: { self: {}, first: {}, second: {} } },
    rpc: async (_, id, method) => method === 'env.info'
      ? { name: id, version: { full: id, time: id === 'first' ? 3 : 2 } }
      : (tried.push(id), { bundle: id }),
    syncFromBundle: async () => { throw new Error('build failed'); },
  });
  await assert.rejects(() => synchronizeVersion(opts), /build failed/);
  assert.deepEqual(tried, ['first']);
});

test('a machine that runs its checkout also repairs an app built from another commit', async () => {
  const stale = [];
  const { opts } = fixture({ running: 'new', currentVersion: async () => ({ full: 'new', time: 3 }),
    rebuildStaleApp: async (running) => { stale.push(running); return { rebuilt: true }; } });
  await synchronizeVersion(opts);
  assert.deepEqual(stale, ['new']);
  const { opts: moving } = fixture({ currentVersion: async () => ({ full: 'newer', time: 4 }),
    rebuildIfCommitted: async () => ({ updated: false, reason: 'unsaved changes here' }),
    rebuildStaleApp: async (running) => { stale.push(running); } });
  await synchronizeVersion(moving);
  assert.deepEqual(stale, ['new'], 'a checkout that moved is rebuilt by the update, not here');
});
