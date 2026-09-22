import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A machine that went to sleep must not become zero usage. Its daemon pushes
// the whole rollup to every hub it attaches to, and the hub keeps folding it
// into reports - marked stale, because it is a memory rather than a reading.
const dir = mkdtempSync(join(tmpdir(), 'helm-usage-sync-'));
process.env.HELM_DIR = dir;
process.env.HELM_DB = join(dir, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';

const PORT = 18987;

test('a hub answers usage.report for a sleeping machine from its last rollup', async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { createNetwork, loadNetwork, machineToken } = await import('@helm/protocol/network');
  const { startRelay } = await import('@helm/relay');
  const { default: WebSocket } = await import('ws');

  createNetwork({ name: 'vm', port: PORT });
  const hub = await startRelay({ port: PORT, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => hub.stop());
  const token = machineToken(loadNetwork());
  const selfId = loadNetwork().self;

  const connect = (query) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return new Promise((resolve) => {
      ws.once('open', () => resolve(ws));
      ws.once('error', () => resolve(null));
    });
  };

  // The machine attaches, pushes its rollup, and goes to sleep.
  const pushedAt = Date.now() - 3600_000;
  const buckets = {
    [`devin|\x002026-09-10|swe-2|`]: {
      input: 5000, output: 500, cacheRead: 40000, cacheWrite: 0,
      total: 45500, turns: 1, billedUsd: 0,
      engine: 'devin', account: 'devin|',
    },
  };
  const env = await connect('?name=vm&info=%7B%7D&role=self');
  assert.ok(env, 'the machine must attach');
  env.send(JSON.stringify({ t: 'usage.sync', buckets, accounts: [], scan: {}, at: pushedAt }));
  await new Promise((r) => setTimeout(r, 200));
  env.close();
  await new Promise((r) => setTimeout(r, 200));

  // Now a client asks - the hub folds the remembered rollup for the window
  // asked, exactly as the daemon would have, and says it is a memory.
  const client = await connect('?role=client');
  assert.ok(client, 'the client must connect');
  const ask = (params) => new Promise((resolve) => {
    const onMsg = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t !== 'rpcResult' || msg.id !== 'q1') return;
      client.off('message', onMsg);
      resolve(msg);
    };
    client.on('message', onMsg);
    client.send(JSON.stringify({ t: 'rpc', id: 'q1', env: selfId, method: 'usage.report', params }));
  });

  const all = await ask({});
  assert.equal(all.ok, true, 'a machine with a remembered rollup still answers');
  assert.equal(all.result.stale, true);
  assert.equal(all.result.at, pushedAt, 'the report carries when the machine last read its ledgers');
  assert.equal(all.result.totals.input, 5000);
  assert.equal(all.result.totals.cacheRead, 40000);
  assert.equal(all.result.totals.turns, 1);

  const windowed = await ask({ since: '2026-09-11' });
  assert.equal(windowed.ok, true);
  assert.equal(windowed.result.totals.turns, 0, 'the stored rollup still honours the window');

  const gone = await ask({});
  assert.equal(gone.ok, true);

  client.close();

  // A machine that never pushed a rollup stays unknown - not zero.
  const noCache = await connect('?role=client');
  const miss = await new Promise((resolve) => {
    noCache.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t === 'rpcResult' && msg.id === 'q2') resolve(msg);
    });
    noCache.send(JSON.stringify({ t: 'rpc', id: 'q2', env: 'never-seen', method: 'usage.report', params: {} }));
  });
  assert.equal(miss.ok, false, 'no rollup, no answer - unknown is not zero');
  assert.equal(miss.error.code, 'offline');
  noCache.close();
});
