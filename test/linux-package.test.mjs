import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventory, checkLinuxPackage } from '../scripts/linux-package.mjs';

test('Linux package inventory refuses links outside the package and detects changed files', t => {
  const root = mkdtempSync(join(tmpdir(), 'helm-linux-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'bin/node'), 'runtime');
  symlinkSync('node', join(root, 'bin/inside'));
  assert.deepEqual(inventory(root)['bin/inside'], { link: 'node' });
  symlinkSync('/bin/sh', join(root, 'bin/outside'));
  assert.throws(() => inventory(root), /inside the package/);
  rmSync(join(root, 'bin/outside'));
  const manifest = { format: 1, kind: 'linux-x64-source-runtime', node: 'v22.23.3', commit: '1'.repeat(40), files: inventory(root) };
  writeFileSync(join(root, 'artifact.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'bin/node'), 'changed');
  assert.throws(() => checkLinuxPackage(root), /files changed/);
});
