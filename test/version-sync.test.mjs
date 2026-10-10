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

test('startup/reconnect takes the published release even when no peer has it', async () => {
  const { opts, calls } = fixture({ rpc: async () => { throw new Error('must not ask peers after updating'); } });
  assert.equal((await synchronizeVersion(opts)).updated, true);
  assert.deepEqual(calls, ['github']);
});
test('GitHub unavailable still catches up from a peer, ignoring offline machines', async () => {
  const { opts, calls } = fixture({ selfUpdate: async () => { throw new Error('offline GitHub'); } });
  assert.equal((await synchronizeVersion(opts)).updated, true);
  assert.deepEqual(calls, ['saved-version']);
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
