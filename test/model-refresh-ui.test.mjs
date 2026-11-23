import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../apps/web/src/modelRefresh.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { followModelRefresh } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
// Let every pending promise and callback run.
const flush = () => new Promise(setImmediate);

test('leaving the picker ignores an in-flight response and cancels further requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  let calls = 0;
  const response = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const catalog = followModelRefresh(() => { calls++; return response; },
    (list) => seen.push(list), (error) => assert.fail(String(error)), 5);
  catalog.stop();
  release({ models: ['wrong-account-model'], refreshing: true });
  await flush();
  t.mock.timers.tick(10 * 60_000 + 1000);
  await flush();
  assert.deepEqual(seen, []);
  assert.equal(calls, 1);
});

test('reconnect refreshes once and does not overlap an outstanding request', async () => {
  let release;
  let calls = 0;
  let failures = 0;
  const response = new Promise((resolve) => { release = resolve; });
  const catalog = followModelRefresh(() => {
    calls++;
    if (calls === 1) return response;
    return Promise.reject(new Error('offline'));
  }, () => {}, () => failures++);
  try {
    await catalog.refresh();
    assert.equal(calls, 1);
    release({ models: [], refreshing: false });
    await flush();
    await catalog.refresh();
    assert.equal(calls, 2);
    assert.equal(failures, 1);
  } finally { catalog.stop(); }
});
