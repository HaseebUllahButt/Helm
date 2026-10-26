import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/folderIndex.ts'], bundle: true, write: false, format: 'esm' });
const { listFolder, knownInside } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('folders opened long ago are let go, the recent ones are kept', async () => {
  const client = { rpc: async (_env, _method, { path }) => ({ path, entries: [{ name: 'a', path: `${path}/a`, isRepo: false, skip: false }] }) };
  for (let i = 0; i < 1000; i++) await listFolder(client, 'pc', `~/f${i}`);
  assert.equal(knownInside('pc', '~/f0'), null, 'the first folder is no longer held');
  assert.equal(knownInside('pc', '~/f999')?.[0].path, '~/f999/a');
  // Opening one again keeps it among the recent ones.
  await listFolder(client, 'pc', '~/f850');
  for (let i = 1000; i < 1150; i++) await listFolder(client, 'pc', `~/f${i}`);
  assert.ok(knownInside('pc', '~/f850'));
});
