import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { fixture, encrypted } from './fixtures/browser-logins.mjs';

const directory = await mkdtemp(join(tmpdir(), 'helm-login-tests-'));
process.env.HELM_DIR = directory; process.env.HELM_NO_SERVICE = '1';
// No real windows on the screen of the machine running the tests.
delete process.env.WAYLAND_DISPLAY; delete process.env.DISPLAY;
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(directory, file);
test.after(() => rm(directory, { recursive: true, force: true }));
const { createLoginReader } = await import('../packages/connect/src/browser-logins.js');
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { createBrowserRoutes } = await import('../packages/connect/src/browser-routes.js');
const { runBrowserCommand } = await import('../packages/connect/src/browser-cli.js');
// A temp home, so the reader never reads the tester's real ~/.config,
// ~/.var/app (Flatpak) or ~/snap browsers.
const config = async t => { const home = await mkdtemp(join(directory, 'home-')); t.after(() => rm(home, { recursive: true, force: true })); return home; };
// Every reader in this file comes from here: a private home, a fake default
// browser, and a guard that fails the test when any browser folder it finds
// lies outside that home (so a real profile is never read).
function privateReader(home, extra = {}) {
  const reader = createLoginReader({ home, configHome: join(home, '.config'), localAppData: join(home, 'AppData', 'Local'), platform: 'linux', defaultBrowser: async () => null, ...extra });
  const inside = path => path === home || path.startsWith(home + sep);
  const listProfiles = async () => { const found = await reader.listProfiles(); for (const p of found) assert.ok(inside(p.dataDir), `read outside the private home: ${p.dataDir}`); return found; };
  return { listProfiles, resolveProfile: async wanted => (await listProfiles(), reader.resolveProfile(wanted)), readLogins: async (wanted, options) => (await listProfiles(), reader.readLogins(wanted, options)) };
}
const linux = privateReader;
// A profile by what a person sees: its browser and folder. Keys hold a path hash.
const who = p => `${p.browserName}/${p.directory}`;

test('a reader reads only its private home; the guard fails on any folder outside it', async t => {
  const home = await config(t), outside = await config(t);
  (await fixture(join(outside, '.config'))).db.close();
  assert.deepEqual(await linux(home).listProfiles(), [], 'a browser outside the private home is not found');
  // A reader whose config folder is outside its home must fail the test.
  await assert.rejects(linux(home, { configHome: join(outside, '.config') }).listProfiles(), /read outside the private home/);
});

test('discovers profiles, finds the one a person names, and rejects symlinks', async t => {
  const home = await config(t), root = join(home, '.config');
  const first = await fixture(root), second = await fixture(root, { browserPath: 'google-chrome', directory: 'Profile 3' }); first.db.close(); second.db.close();
  const reader = linux(home);
  assert.equal((await reader.listProfiles()).length, 2);
  assert.equal(who(await reader.resolveProfile('CHROME:personal')), 'Google Chrome/Profile 3');
  assert.equal(who(await reader.resolveProfile('Profile 3')), 'Google Chrome/Profile 3');
  assert.equal(who(await reader.resolveProfile('personal in chromium')), 'Chromium/Default');
  assert.equal(who(await reader.resolveProfile('Google Chrome Personal')), 'Google Chrome/Profile 3');
  assert.equal(who(await reader.resolveProfile('Google Chrome: Personal (Profile 3)')), 'Google Chrome/Profile 3', 'a pasted list line resolves');
  assert.equal(who(await reader.resolveProfile('chrome')), 'Google Chrome/Profile 3', 'a browser alone is its last used profile');
  await assert.rejects(reader.resolveProfile('brave'), /No browser profile matches "brave"/);
  await assert.rejects(reader.resolveProfile('nobody'), /No browser profile matches "nobody".*Chrome: Personal/);
  await assert.rejects(reader.readLogins({ key: 'chromium:../../escape' }), /No browser profile matches/);
  await rm(join(first.profile, 'Network/Cookies')); await symlink(join(second.profile, 'Network/Cookies'), join(first.profile, 'Network/Cookies'));
  await assert.rejects(reader.readLogins('chromium:Default'), /symlinks/);
  await rm(first.profile, { recursive: true }); await symlink(second.profile, first.profile);
  assert.equal((await reader.listProfiles()).length, 1);
});

test('"main" is a profile called Main when there is one, else the default profile', async t => {
  const home = await config(t), root = join(home, '.config');
  (await fixture(root)).db.close();
  const reader = linux(home);
  assert.equal(who(await reader.resolveProfile('main')), 'Chromium/Default');
  assert.equal(who(await reader.resolveProfile('the main profile')), 'Chromium/Default');
  (await fixture(root, { directory: 'Profile 1', name: 'Main' })).db.close();
  assert.equal(who(await reader.resolveProfile('Main')), 'Chromium/Profile 1');
  assert.equal(who(await reader.resolveProfile('main profile')), 'Chromium/Profile 1');
  assert.equal(who(await reader.resolveProfile('default')), 'Chromium/Default');
});

test('a name two browsers share means the everyday browser, then the latest used', async t => {
  const home = await config(t), root = join(home, '.config');
  for (const options of [{}, { browserPath: 'google-chrome', info: { active_time: 1700000000 } }, { browserPath: 'net.imput.helium', directory: 'Profile 7', name: 'Work', info: { user_name: 'me@example.test', active_time: 1600000000 } }]) (await fixture(root, options)).db.close();
  await writeFile(join(root, 'helium-browser-flags.conf'), '--password-store=basic');
  const plain = linux(home);
  assert.equal(who(await plain.resolveProfile('personal')), 'Google Chrome/Default', 'used most lately');
  assert.equal(who(await plain.resolveProfile('me@example.test')), 'Helium/Profile 7');
  assert.equal(who(await plain.resolveProfile('wor')), 'Helium/Profile 7', 'the start of a name is enough');
  const helium = (await plain.listProfiles()).find(p => p.browserName === 'Helium');
  assert.equal(helium.browserName, 'Helium'); assert.equal(helium.passwordStore, 'basic');
  const everyday = linux(home, { defaultBrowser: async () => 'chromium' });
  assert.equal(who(await everyday.resolveProfile('personal')), 'Chromium/Default');
  assert.deepEqual((await everyday.listProfiles()).map(who), ['Chromium/Default', 'Google Chrome/Default', 'Helium/Profile 7']);
});

test('finds any Chromium browser by its "Local State", in native, Flatpak and Snap roots, named by its folder', async t => {
  const home = await config(t), config_ = join(home, '.config');
  // A browser Helm has never heard of, found only by the Local State file.
  (await fixture(config_, { browserPath: 'wavebrowser', name: 'Surf' })).db.close();
  // A Flatpak browser, named by its reverse-DNS app id, not the "chromium" folder.
  (await fixture(join(home, '.var/app/net.imput.helium/config'), { browserPath: 'chromium', directory: 'Profile 2', name: 'Imput' })).db.close();
  // A Snap browser, kept below a hidden ".config" folder.
  (await fixture(join(home, 'snap/chromium/common/.config'), { browserPath: 'chromium', name: 'Snap' })).db.close();
  const found = (await linux(home).listProfiles());
  const byName = Object.fromEntries(found.map(p => [p.browserName, p.browser]));
  assert.equal(found.length, 3);
  assert.match(byName.Wavebrowser, /^wavebrowser-[0-9a-f]{8}$/);
  // The Flatpak app id names the browser ("Helium"), not its chromium folder.
  assert.match(byName.Helium, /^helium-[0-9a-f]{8}$/, 'the app id names the Flatpak browser, not its chromium folder');
  assert.match(byName.Chromium, /^chromium-[0-9a-f]{8}$/, 'the Snap browser below .config is found');
});

test('a profile key stays the same when another install appears (no account swap)', async t => {
  const home = await config(t), root = join(home, '.config');
  // The Snap Chromium exists first; the owner saves it as their default.
  (await fixture(join(home, 'snap/chromium/common/.config'), { browserPath: 'chromium' })).db.close();
  const before = await linux(home).listProfiles();
  assert.equal(before.length, 1);
  const snapKey = before[0].key;
  // Later a plain Chromium is installed under ~/.config.
  (await fixture(root, { browserPath: 'chromium' })).db.close();
  const after = await linux(home).listProfiles();
  assert.equal(after.length, 2);
  assert.ok(after.some(p => p.key === snapKey), 'the Snap profile keeps its key');
  assert.equal(after.filter(p => p.key === snapKey).length, 1, 'keys stay unique');
  assert.equal(new Set(after.map(p => p.key)).size, 2);
});

test('a key tried against a cookie is used even when a fork stores it under a shared name', async t => {
  const home = await config(t), root = join(home, '.config');
  // Helium's keyring key lives under "chromium"; Chrome Beta's under "chrome".
  const helium = await fixture(root, { browserPath: 'net.imput.helium', name: 'Imput' }); t.after(() => helium.db.close());
  helium.insert({ name: 'h', bytes: encrypted('helium-cookie', { prefix: 'v11', password: 'chromium-key' }) });
  const beta = await fixture(root, { browserPath: 'google-chrome-beta', name: 'Beta' }); t.after(() => beta.db.close());
  beta.insert({ name: 'b', bytes: encrypted('beta-cookie', { prefix: 'v11', password: 'chrome-key' }) });
  await writeFile(join(root, 'chromium-flags.conf'), '--password-store=gnome-libsecret');
  // The keyring answers only for the shared application names.
  const keys = { chromium: 'chromium-key', chrome: 'chrome-key' };
  const reader = linux(home, { run: async (bin, args) => { if (bin !== 'secret-tool') throw new Error('no'); const app = args[2]; return keys[app] ? { stdout: keys[app] + '\n' } : (() => { throw new Error('absent'); })(); } });
  assert.equal((await reader.readLogins('Helium')).cookies[0].value, 'helium-cookie', 'Helium falls back to the chromium key');
  assert.equal((await reader.readLogins('Beta')).cookies[0].value, 'beta-cookie', 'Chrome Beta tries the chrome key');
});

test('one browser’s flags do not change another browser’s store', async t => {
  const home = await config(t), root = join(home, '.config');
  (await fixture(root, { browserPath: 'chromium' })).db.close();
  (await fixture(root, { browserPath: 'google-chrome' })).db.close();
  // Only Chromium's own launcher sets a basic store.
  await writeFile(join(root, 'chromium-flags.conf'), '--password-store=basic');
  const found = await linux(home).listProfiles();
  assert.equal(found.find(p => p.browserName === 'Chromium').passwordStore, 'basic');
  assert.equal(found.find(p => p.browserName === 'Google Chrome').passwordStore, 'auto', 'Chrome keeps its keyring store');
});

test('Linux decrypts v10 and v11 with host hashes, live WAL, expiry, sessions and SameSite', async t => {
  const home = await config(t), root = join(home, '.config'), f = await fixture(root, { wal: true }); t.after(() => f.db.close());
  let time = Date.now(); const calls = [];
  await writeFile(join(root, 'chromium-flags.conf'), '--password-store=gnome-libsecret');
  const reader = privateReader(home, { now: () => time, run: async (bin, args) => { calls.push({ bin, args }); return { stdout: 'fake-key\n' }; } });
  f.insert({ name: 'session', bytes: encrypted('session-value'), sameSite: 2 });
  f.insert({ name: 'persistent', bytes: encrypted('keyring-value', { prefix: 'v11', password: 'fake-key' }), expires: time / 1000 + 3600, sameSite: 0, partitionKey: 'https://top.test' });
  f.insert({ name: 'plain', value: 'plain-value', bytes: Buffer.alloc(0), secure: false, httpOnly: false, sameSite: -1 });
  f.insert({ name: 'empty', bytes: encrypted(''), secure: false, sameSite: 0 });
  f.insert({ name: 'expired', expires: time / 1000 - 10 });
  f.insert({ name: 'bad-host', bytes: encrypted('wrong', { host: '.wrong.test' }) });
  f.insert({ name: 'unsupported', bytes: Buffer.from('v20unsupported') });
  const r = await reader.readLogins('chromium:Default');
  assert.equal(r.cookies.length, 4); assert.equal(r.failed, 2); assert.equal(r.sites, 1);
  assert.deepEqual(r.cookies.map(c => [c.value, c.expires === -1, c.sameSite]), [['session-value', true, 'Strict'], ['keyring-value', false, 'None'], ['plain-value', true, 'Lax'], ['', true, 'None']]);
  assert.equal(r.cookies[1].partitionKey, 'https://top.test'); assert.equal(r.cookies[0].httpOnly, true); assert.equal(r.cookies[2].secure, false);
  assert.deepEqual(calls, [{ bin: 'secret-tool', args: ['lookup', 'application', 'chromium', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2'] }]);
  r.cookies[0].value = 'changed'; f.insert({ name: 'later' });
  assert.equal((await reader.readLogins('chromium:Default')).cookies.length, 4);
  assert.equal((await reader.readLogins('chromium:Default', { refresh: true })).cookies.length, 5);
  f.insert({ name: 'latest' }); time += 10 * 60000;
  assert.equal((await reader.readLogins('chromium:Default')).cookies.length, 6);
});

test('legacy database, missing keyring, and KWallet use the selected store without leaking errors', async t => {
  const home = await config(t), root = join(home, '.config'), f = await fixture(root, { version: 23, network: false }); t.after(() => f.db.close());
  f.insert({ bytes: encrypted('legacy', { version: 23 }) }); f.insert({ name: 'v11', bytes: encrypted('wallet', { version: 23, prefix: 'v11', password: 'fake-wallet' }) });
  await writeFile(join(root, 'chromium-flags.conf'), '--password-store=kwallet6');
  const calls = [], reader = privateReader(home, { run: async (bin, args) => { calls.push([bin, args]); return { stdout: 'fake-wallet\n' }; } });
  assert.equal((await reader.readLogins('Default')).cookies.length, 2); assert.equal(calls[0][0], 'kwallet-query');
  assert.deepEqual(calls[0][1], ['-r', 'Chromium Safe Storage', '-f', 'Chromium Keys', 'kdewallet']);
  const locked = privateReader(home, { run: async () => { throw new Error('sensitive command output'); } });
  const r = await locked.readLogins('Default'); assert.equal(r.cookies.length, 1); assert.equal(r.failed, 1); assert.match(r.warnings[0], /kwallet6 key unavailable/); assert.ok(!JSON.stringify(r.warnings).includes('sensitive'));
});

test('macOS keychain decryption and Windows clearly unreadable profile listing', async t => {
  const home = await config(t), root = join(home, 'Library/Application Support');
  const mac = await fixture(root, { browserPath: 'Google/Chrome' }); t.after(() => mac.db.close());
  mac.insert({ bytes: encrypted('mac-value', { platform: 'darwin', password: 'mac-key' }) });
  const reader = privateReader(home, { platform: 'darwin', run: async () => ({ stdout: 'mac-key\n' }) });
  assert.equal((await reader.readLogins('chrome:Default')).cookies[0].value, 'mac-value');
  const win = await fixture(join(home, 'win'), { browserPath: 'Google/Chrome/User Data' }); win.db.close();
  const windows = privateReader(home, { localAppData: join(home, 'win'), platform: 'win32' });
  assert.equal((await windows.listProfiles())[0].readable, false); await assert.rejects(windows.readLogins('Default'), /app-bound/);
});

function fakeBrowser() {
  const browser = new EventEmitter(); browser.isConnected = () => true; browser.close = async () => {};
  const created = []; browser.newContext = async options => {
    const context = new EventEmitter(); context.state = options.storageState || { cookies: [], origins: [] };
    context.setDefaultTimeout = context.setDefaultNavigationTimeout = () => {}; context.close = async () => {};
    context.addCookies = async cookies => { context.state.cookies = cookies; };
    context.storageState = async () => context.state; created.push(context); return context;
  };
  return { browser, created };
}

test('default seeds only new contexts, imports refresh open or unopened contexts, RPC returns counts, files are private', async t => {
  const root = await config(t), fake = fakeBrowser(), reads = [], profile = { key: 'chromium:Default', readable: true };
  const cookie = { name: 'fixture', value: 'synthetic', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' };
  const logins = { listProfiles: async () => [profile], resolveProfile: async () => profile, readLogins: async (p, options) => { reads.push(options); return { cookies: [cookie], sites: 1, failed: 0, profile: 'Personal' }; } };
  const manager = new BrowserManager({ directory: root, session: id => id !== 'missing' ? { id } : null, launch: async () => fake.browser, logins }); t.after(() => manager.stop());
  const routes = createBrowserRoutes({ manager });
  await assert.rejects(routes.dispatch('browser.profiles', { id: 'missing' }), /not found/);
  await routes.dispatch('browser.loginDefault', { id: 'one', profileKey: 'Personal' });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'logins.json'), 'utf8')), { profileKey: profile.key });
  const contexts = await Promise.all([manager.context('one'), manager.context('one')]); assert.equal(contexts[0], contexts[1]); assert.equal(reads.length, 1); assert.equal(reads[0].saved, true, 'a new window reads the saved key strictly');
  assert.equal((await stat(join(root, 'one/storage.json'))).mode & 0o777, 0o600); assert.equal((await stat(join(root, 'logins.json'))).mode & 0o777, 0o600);
  await mkdir(join(root, 'two')); await writeFile(join(root, 'two/storage.json'), JSON.stringify({ cookies: [], origins: [] })); await manager.context('two'); assert.equal(reads.length, 1);
  assert.deepEqual(await routes.dispatch('browser.importLogins', { id: 'two', profileKey: 'Personal' }), { cookies: 1, sites: 1, failed: 0, profile: 'Personal' });
  assert.equal(reads.at(-1).refresh, true);
  await routes.dispatch('browser.importLogins', { id: 'three', profileKey: 'Personal' }); assert.ok(manager.contexts.has('three'));
  await routes.dispatch('browser.loginDefault', { id: 'one', profileKey: null }); assert.deepEqual(await manager.loginDefault('one'), { profileKey: null });
  await manager.context('four'); assert.deepEqual(fake.created.at(-1).state.cookies, []);
});

test('CLI profiles, names with spaces, default and clearing return only RPC metadata', async () => {
  const calls = [], outputs = [], run = args => runBrowserCommand(args, { env: { HELM_SESSION_ID: 'one' }, self: () => 'local', print: result => outputs.push(result), rpc: async (env, method, params) => { calls.push([method, params]); return method === 'browser.importLogins' ? { cookies: 1, sites: 1, failed: 0, profile: 'Work' } : { profileKey: params.profileKey }; } });
  await run(['profiles']); await run(['logins', 'Profile', '3', '--default']); await run(['logins', '--clear-default']);
  assert.deepEqual(calls.map(c => c[0]), ['browser.profiles', 'browser.importLogins', 'browser.loginDefault', 'browser.loginDefault']);
  assert.equal(calls[1][1].profileKey, 'Profile 3'); assert.equal(calls.at(-1)[1].profileKey, null); assert.ok(!outputs.some(s => s.includes('synthetic')));
});

test('a damaged or expired first cookie does not stop a good keyring key', async t => {
  const home = await config(t), root = join(home, '.config'), time = Date.now();
  const f = await fixture(root); t.after(() => f.db.close());
  await writeFile(join(root, 'chromium-flags.conf'), '--password-store=gnome-libsecret');
  // First rows: one damaged, one expired and sealed with an old key.
  f.insert({ name: 'damaged', bytes: Buffer.concat([Buffer.from('v11'), Buffer.alloc(32, 7)]) });
  f.insert({ name: 'expired', bytes: encrypted('old', { prefix: 'v11', password: 'old-key' }), expires: time / 1000 - 60 });
  f.insert({ name: 'good', bytes: encrypted('good-value', { prefix: 'v11', password: 'fake-key' }) });
  const reader = linux(home, { now: () => time, run: async () => ({ stdout: 'fake-key\n' }) });
  const r = await reader.readLogins('Default');
  assert.deepEqual(r.cookies.map(c => c.value), ['good-value'], 'the good row copies');
  assert.equal(r.failed, 1, 'only the damaged row fails');
});

test('a good keyring key is found after more than 50 damaged rows', async t => {
  const home = await config(t), root = join(home, '.config');
  const f = await fixture(root); t.after(() => f.db.close());
  await writeFile(join(root, 'chromium-flags.conf'), '--password-store=gnome-libsecret');
  for (let i = 0; i < 60; i++) f.insert({ name: `damaged-${i}`, bytes: Buffer.concat([Buffer.from('v11'), Buffer.alloc(32, i)]) });
  f.insert({ name: 'good', bytes: encrypted('good-value', { prefix: 'v11', password: 'fake-key' }) });
  const r = await linux(home, { run: async () => ({ stdout: 'fake-key\n' }) }).readLogins('Default');
  assert.deepEqual(r.cookies.map(c => c.value), ['good-value']);
  assert.equal(r.failed, 60);
});
