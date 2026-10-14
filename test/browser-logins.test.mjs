import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { fixture, encrypted } from './fixtures/browser-logins.mjs';

const directory = await mkdtemp(join(tmpdir(), 'helm-login-tests-'));
process.env.HELM_DIR = directory; process.env.HELM_NO_SERVICE = '1';
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(directory, file);
test.after(() => rm(directory, { recursive: true, force: true }));
const { createLoginReader } = await import('../packages/connect/src/browser-logins.js');
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { createBrowserRoutes } = await import('../packages/connect/src/browser-routes.js');
const { runBrowserCommand } = await import('../packages/connect/src/browser-cli.js');
const config = async t => { const root = await mkdtemp(join(directory, 'config-')); t.after(() => rm(root, { recursive: true, force: true })); return root; };

test('discovers profiles, resolves labels and directories, and rejects ambiguity and symlinks', async t => {
  const root = await config(t), first = await fixture(root), second = await fixture(root, { browserPath: 'google-chrome', directory: 'Profile 3' }); first.db.close(); second.db.close();
  const reader = createLoginReader({ configHome: root, platform: 'linux' });
  assert.equal((await reader.listProfiles()).length, 2);
  assert.equal((await reader.resolveProfile('CHROME:personal')).key, 'chrome:Profile 3');
  assert.equal((await reader.resolveProfile('Profile 3')).key, 'chrome:Profile 3');
  await assert.rejects(reader.resolveProfile('Personal'), /ambiguous.*Chromium.*Chrome/);
  await assert.rejects(reader.readLogins({ key: 'chromium:../../escape' }), /not found/);
  await rm(join(first.profile, 'Network/Cookies')); await symlink(join(second.profile, 'Network/Cookies'), join(first.profile, 'Network/Cookies'));
  await assert.rejects(reader.readLogins('chromium:Default'), /symlinks/);
  await rm(first.profile, { recursive: true }); await symlink(second.profile, first.profile);
  assert.equal((await reader.listProfiles()).length, 1);
});

test('Linux decrypts v10 and v11 with host hashes, live WAL, expiry, sessions and SameSite', async t => {
  const root = await config(t), f = await fixture(root, { wal: true }); t.after(() => f.db.close());
  let time = Date.now(); const calls = [];
  await writeFile(join(root, 'chromium-flags.conf'), '--password-store=gnome-libsecret');
  const reader = createLoginReader({ configHome: root, platform: 'linux', now: () => time, run: async (bin, args) => { calls.push({ bin, args }); return { stdout: 'fake-key\n' }; } });
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
  const root = await config(t), f = await fixture(root, { version: 23, network: false }); t.after(() => f.db.close());
  f.insert({ bytes: encrypted('legacy', { version: 23 }) }); f.insert({ name: 'v11', bytes: encrypted('wallet', { version: 23, prefix: 'v11', password: 'fake-wallet' }) });
  await writeFile(join(root, 'chromium-flags.conf'), '--password-store=kwallet6');
  const calls = [], reader = createLoginReader({ configHome: root, platform: 'linux', run: async (bin, args) => { calls.push([bin, args]); return { stdout: 'fake-wallet\n' }; } });
  assert.equal((await reader.readLogins('Default')).cookies.length, 2); assert.equal(calls[0][0], 'kwallet-query');
  assert.deepEqual(calls[0][1], ['-r', 'Chromium Safe Storage', '-f', 'Chromium Keys', 'kdewallet']);
  const locked = createLoginReader({ configHome: root, platform: 'linux', run: async () => { throw new Error('sensitive command output'); } });
  const r = await locked.readLogins('Default'); assert.equal(r.cookies.length, 1); assert.equal(r.failed, 1); assert.match(r.warnings[0], /kwallet6 key unavailable/); assert.ok(!JSON.stringify(r.warnings).includes('sensitive'));
});

test('macOS keychain decryption and Windows clearly unreadable profile listing', async t => {
  const home = await config(t), root = join(home, 'Library/Application Support');
  const mac = await fixture(root, { browserPath: 'Google/Chrome' }); t.after(() => mac.db.close());
  mac.insert({ bytes: encrypted('mac-value', { platform: 'darwin', password: 'mac-key' }) });
  const reader = createLoginReader({ home, platform: 'darwin', run: async () => ({ stdout: 'mac-key\n' }) });
  assert.equal((await reader.readLogins('chrome:Default')).cookies[0].value, 'mac-value');
  const win = await fixture(join(home, 'win'), { browserPath: 'Google/Chrome/User Data' }); win.db.close();
  const windows = createLoginReader({ localAppData: join(home, 'win'), platform: 'win32' });
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
  const contexts = await Promise.all([manager.context('one'), manager.context('one')]); assert.equal(contexts[0], contexts[1]); assert.equal(reads.length, 1);
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
