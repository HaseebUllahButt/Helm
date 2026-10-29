import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-starting-logins-'));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { BrowserManager, useOwnerLogins } = await import('../packages/connect/src/browser.js');

const profiles = [{ key: 'brave:Profile 9', readable: false }, { key: 'brave:Default', readable: true }, { key: 'chrome:Default', readable: true }];
const make = () => new BrowserManager({ directory: mkdtempSync(join(process.env.HELM_DIR, 'b-')), session: id => ({ id }), logins: { listProfiles: async () => profiles } });

test('a new browser starts with the chosen profile, else the default browser’s latest readable profile in the service only', async () => {
  const manager = make();
  assert.deepEqual(await manager.startingProfile(), { profileKey: null }, 'outside the service no real profile is read');
  useOwnerLogins();
  assert.deepEqual(await manager.startingProfile(), { profileKey: 'brave:Default' });
  writeFileSync(join(manager.directory, 'logins.json'), JSON.stringify({ profileKey: 'chrome:Default' }));
  assert.deepEqual(await manager.startingProfile(), { profileKey: 'chrome:Default' }, 'the owner’s choice wins');
});
