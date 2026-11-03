import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/startingTerminals.ts'], bundle: true, write: false, format: 'cjs' });
function fixture() {
  const context = { module: { exports: {} }, crypto: globalThis.crypto, window: { innerWidth: 390, innerHeight: 844 }, setTimeout, clearTimeout };
  context.exports = context.module.exports;
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  return { ...context.module.exports, window: context.window };
}

test('a terminal retry repeats the same start number and attachment', async () => {
  const h = fixture();
  const calls = [];
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const client = { on: () => () => {}, rpc: async (_, method, params) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    if (calls.length === 1) throw new Error('reply lost');
    return { session: { id: 'terminal' } };
  } };
  const t = h.beginTerminal(client, 'pc', '/work', finish);
  await new Promise(resolve => h.onStartingTerminal(item => { if (item.state === 'failed') resolve(); }));
  h.window.innerWidth = 1280;
  h.retryTerminal(client, t.id);
  await done;
  assert.match(calls[0].startId, /^[a-f0-9]{32}$/);
  assert.deepEqual(calls[1], calls[0]);
});
