import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Discovery reads the shell's aliases and PATH; a scratch home and a bin
// folder of our own keep the owner's real CLIs out of it.
const root = mkdtempSync(join(tmpdir(), 'helm-profiles-'));
const bin = join(root, 'bin');
mkdirSync(bin);
process.env.HELM_DIR = join(root, '.helm');
process.env.HOME = root;
process.env.SHELL = '/bin/sh';
process.env.PATH = `${bin}:/usr/bin:/bin`;

test('saved accounts survive a missing binary and return without duplicates', async () => {
  const { refreshProfiles, loadProfiles, saveProfiles } = await import('../packages/connect/src/profiles.js');
  const grok = join(bin, 'grok');
  writeFileSync(grok, '#!/bin/sh\n');
  chmodSync(grok, 0o755);
  const first = (await refreshProfiles()).profiles;
  assert.ok(first.some(p => p.id === 'grok'));
  const alias = { id: 'my-grok', engine: 'grok', cmd: 'grok', args: [], env: {}, source: 'alias', disabled: true };
  saveProfiles([...first, alias]);
  rmSync(grok);
  await refreshProfiles();
  assert.ok(loadProfiles().profiles.some(p => p.id === 'grok'));
  assert.deepEqual(loadProfiles().profiles.find(p => p.id === alias.id), alias);
  writeFileSync(grok, '#!/bin/sh\n');
  chmodSync(grok, 0o755);
  const again = (await refreshProfiles()).profiles;
  assert.equal(again.filter(p => p.id === 'grok').length, 1);
  assert.deepEqual(again.find(p => p.id === alias.id), alias);
});
test.after(() => rmSync(root, { recursive: true, force: true }));
