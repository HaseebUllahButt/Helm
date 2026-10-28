import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, readlinkSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventory, checkLinuxPackage, copyDependencies } from '../scripts/linux-package.mjs';

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


test('dependency copying preserves header-only and empty folders without requiring package metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'helm-copy-header-dependencies-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), target = join(root, 'target');
  const headers = '@homebridge/node-addon-api';
  mkdirSync(join(source, headers), { recursive: true });
  writeFileSync(join(source, headers, 'node_addon_api.Makefile'), 'saved native build data');
  mkdirSync(join(source, '@types/empty'), { recursive: true });
  mkdirSync(join(source, 'empty'));
  const external = join(root, 'command-package');
  mkdirSync(external);
  writeFileSync(join(external, 'package.json'), JSON.stringify({ name: 'command-package', bin: 'run.js' }));
  writeFileSync(join(external, 'run.js'), 'saved command');
  symlinkSync(external, join(source, 'command-package'));
  copyDependencies(source, target);
  assert.equal(readFileSync(join(target, headers, 'node_addon_api.Makefile'), 'utf8'), 'saved native build data');
  assert.equal(existsSync(join(target, headers, 'package.json')), false);
  assert.equal(existsSync(join(target, '@types/empty')), true);
  assert.equal(existsSync(join(target, 'empty')), true);
  assert.equal(readlinkSync(join(target, '.bin/command-package')), '../command-package/run.js');
  assert.equal(realpathSync(join(target, 'command-package')), join(target, 'command-package'));
  assert.equal(readFileSync(join(target, '.bin/command-package'), 'utf8'), 'saved command');
  mkdirSync(join(source, 'invalid'));
  writeFileSync(join(source, 'invalid/package.json'), '{bad json');
  assert.throws(() => copyDependencies(source, join(root, 'invalid-target')), SyntaxError);
});
