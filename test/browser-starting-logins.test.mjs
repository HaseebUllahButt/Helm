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

// Real login reading, always inside a private home with a fake default browser.
const { createLoginReader } = await import('../packages/connect/src/browser-logins.js');
const { fixture, encrypted } = await import('./fixtures/browser-logins.mjs');
const homeDir = () => mkdtempSync(join(process.env.HELM_DIR, 'home-'));
const reader = (home, defaultBrowser = null) => createLoginReader({ home, configHome: join(home, '.config'), platform: 'linux', defaultBrowser: async () => defaultBrowser });
const withCookie = async (root, options, value) => { const f = await fixture(root, options); f.insert({ bytes: encrypted(value) }); f.db.close(); };
const managerWith = logins => new BrowserManager({ directory: mkdtempSync(join(process.env.HELM_DIR, 'b-')), session: id => ({ id }), logins });

test('a key an older Helm saved keeps its account, through startingProfile and cached reads', async () => {
  const home = homeDir(), root = join(home, '.config');
  await withCookie(root, { browserPath: 'google-chrome', info: { active_time: 1000 } }, 'chrome-account');
  await withCookie(root, { browserPath: 'google-chrome-beta', info: { active_time: 9000 } }, 'beta-account'); // used more lately
  const logins = reader(home), manager = managerWith(logins);
  for (const [saved, account] of [['chrome:Default', 'chrome-account'], ['chrome-beta:Default', 'beta-account']]) {
    writeFileSync(join(manager.directory, 'logins.json'), JSON.stringify({ profileKey: saved }));
    const { profileKey } = await manager.startingProfile();
    assert.equal(profileKey, saved);
    assert.equal((await logins.readLogins(profileKey)).cookies[0].value, account, `${saved} reads its own account`);
    assert.equal((await logins.readLogins(profileKey)).cookies[0].value, account, `${saved} cached read keeps the account`);
  }
  // The old Chrome key never falls back to another browser's account.
  const betaOnly = homeDir();
  await withCookie(join(betaOnly, '.config'), { browserPath: 'google-chrome-beta' }, 'beta-account');
  await assert.rejects(reader(betaOnly).readLogins('chrome:Default'), /Chrome has no profiles/);
});

test('a saved key stays on its account when a browser with the same name is installed', async () => {
  const home = homeDir(), root = join(home, '.config');
  await withCookie(root, { browserPath: 'org.z.Browse', info: { active_time: 1000 } }, 'z-account');
  const logins = reader(home), manager = managerWith(logins);
  const { profileKey } = await manager.loginDefault('one', 'Browse');
  assert.equal((await logins.readLogins(profileKey)).cookies[0].value, 'z-account');
  // A new install whose name is also "Browse", sorted before it and used more lately.
  await withCookie(root, { browserPath: 'com.a.Browse', info: { active_time: 9000 } }, 'a-account');
  assert.equal((await manager.startingProfile()).profileKey, profileKey, 'the saved key is unchanged');
  assert.equal((await logins.readLogins(profileKey)).cookies[0].value, 'z-account', 'the cached read keeps the account');
  assert.equal((await logins.readLogins(profileKey, { refresh: true })).cookies[0].value, 'z-account', 'a fresh read keeps the account');
  await assert.rejects(logins.resolveProfile('Browse: Personal (Default)'), /Two browser profiles have this name/);
});

test('the system default browser wins over a newer profile of another browser (native and Flatpak)', async () => {
  useOwnerLogins();
  for (const [defaultId, dataPath] of [['brave-browser', '.config/BraveSoftware/Brave-Browser'], ['com.brave.Browser', '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser']]) {
    const home = homeDir();
    const parts = dataPath.split('/'), browserPath = parts.pop();
    await withCookie(join(home, ...parts), { browserPath, info: { active_time: 1000 } }, 'brave-account');
    await withCookie(join(home, '.config'), { browserPath: 'chromium', info: { active_time: 9000 } }, 'newer-other-account');
    const logins = reader(home, defaultId), manager = managerWith(logins);
    const { profileKey } = await manager.startingProfile();
    const chosen = await logins.resolveProfile(profileKey);
    assert.equal(chosen.browserName, 'Brave', `${defaultId}: the default browser's profile starts the window`);
    assert.equal((await logins.readLogins(profileKey)).cookies[0].value, 'brave-account');
  }
});

test('an old saved key whose profile folder is gone is refused, never matched to a similar folder', async () => {
  const home = homeDir(), root = join(home, '.config');
  await withCookie(root, { browserPath: 'google-chrome', directory: 'Profile 10', name: 'Other' }, 'other-account');
  const logins = reader(home), manager = managerWith(logins);
  writeFileSync(join(manager.directory, 'logins.json'), JSON.stringify({ profileKey: 'chrome:Profile 1' }));
  const { profileKey } = await manager.startingProfile();
  await assert.rejects(logins.readLogins(profileKey), /No browser profile matches "chrome:Profile 1"/);
  assert.equal((await logins.readLogins('chrome:Profile 10')).cookies[0].value, 'other-account', 'the exact folder still works');
  assert.equal((await logins.resolveProfile('chrome:other')).directory, 'Profile 10', 'one exact profile name still works');
});
