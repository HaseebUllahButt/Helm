import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/send/store.ts'], bundle: true, write: false, format: 'esm' });
const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
const { SendStore } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const job = (phase, sent, updatedAt) => ({ id: 'j1', phase, source: { machineId: 'laptop', path: '/p' }, target: { name: 'vm' },
  bytes: { sent, total: 100 }, createdAt: 1, updatedAt });

test('a poll that brings back the same send does not redraw the app', async () => {
  let jobs = [job('sending', 10, 5)];
  let fail = false;
  const client = { token: '', sendList: async () => { if (fail) throw new Error('down'); return { jobs }; } };
  const store = new SendStore(client);
  let published = 0;
  store.subscribe(() => { published++; });
  await store.refresh('laptop');
  const first = published;
  assert.ok(first > 0);
  await store.refresh('laptop');
  assert.equal(published, first, 'nothing changed, nothing was published');
  jobs = [job('sending', 50, 6)];
  await store.refresh('laptop');
  assert.ok(published > first, 'progress is published');
  assert.equal(store.getSnapshot().jobs[0].bytes.sent, 50);
  fail = true;
  const before = published;
  await store.refresh('laptop');
  await store.refresh('laptop');
  assert.equal(published, before + 1, 'the same error is published once');
  fail = false;
  await store.refresh('laptop');
  assert.deepEqual(store.getSnapshot().errors, {});
});
