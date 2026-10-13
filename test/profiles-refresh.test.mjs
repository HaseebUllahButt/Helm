import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

test('a CLI that is uninstalled leaves the list on the next look, with no one asking', async () => {
  const { refreshProfiles, currentProfiles, loadProfiles } = await import('../packages/connect/src/profiles.js');
  const grok = join(bin, 'grok');
  writeFileSync(grok, '#!/bin/sh\n');
  chmodSync(grok, 0o755);
  const ids = (list) => list.map((p) => p.id);

  assert.ok(ids((await refreshProfiles()).profiles).includes('grok'), 'found while installed');

  rmSync(grok);
  // A fresh list is trusted as saved; one older than five minutes is
  // answered as saved and looked at again behind the answer.
  const file = join(process.env.HELM_DIR, 'profiles.json');
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(file, old, old);
  assert.ok(ids(await currentProfiles()).includes('grok'), 'the stale answer comes first');
  for (let i = 0; i < 600 && ids(loadProfiles().profiles).includes('grok'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!ids(loadProfiles().profiles).includes('grok'), 'gone once the look behind it finishes');
  assert.ok(!ids(await currentProfiles()).includes('grok'), 'and the next ask does not offer it');
});
