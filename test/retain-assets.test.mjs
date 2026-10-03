import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainAssets } from '../apps/web/retainAssets.mjs';

test('deploys keep recent lazy chunks and current outputs, and expire older unused assets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'helm-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, 'assets');
  await mkdir(assets);
  const now = Date.now(), day = 24 * 60 * 60_000;
  for (const [name, age] of [['previous.js', 2], ['expired.js', 8], ['current.js', 8]]) {
    const file = join(assets, name);
    await writeFile(file, name);
    const date = new Date(now - age * day);
    await utimes(file, date, date);
  }
  await retainAssets({ now: () => now }).writeBundle({ dir: root }, { 'assets/current.js': {} });
  assert.deepEqual((await readdir(assets)).sort(), ['current.js', 'previous.js']);
});
