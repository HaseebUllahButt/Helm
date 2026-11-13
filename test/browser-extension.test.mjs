import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-browser-extension-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rm(process.env.HELM_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { ExtensionRelay, extensionIdFromKey } = await import('../packages/connect/src/browser-relay.js');
const ext = await import('../packages/connect/src/browser-extension.js');
const { systemChromium } = await import('../packages/connect/src/browser-window.js');
const { createBrowserRoutes } = await import('../packages/connect/src/browser-routes.js');

test('the add-on has one fixed id in every browser', () => {
  const manifest = JSON.parse(readFileSync(join(ext.EXTENSION_SOURCE, 'manifest.json'), 'utf8'));
  assert.equal(extensionIdFromKey(manifest.key), 'knooejmoodmpkigfhoeifmhkpadpknng');
  assert.equal(ext.EXTENSION_ID, 'knooejmoodmpkigfhoeifmhkpadpknng');
});

test('the flags file keeps the owner\'s other add-ons and takes Helm\'s out again', () => {
  const mine = '/home/me/.helm/browser/extension';
  const owner = '--ozone-platform=wayland\n--load-extension=/usr/share/a,/usr/share/b\n';
  const added = ext.withExtension(owner, mine);
  assert.equal(added, `--ozone-platform=wayland\n--load-extension=/usr/share/a,/usr/share/b,${mine}\n`);
  assert.equal(ext.withExtension(added, mine), added, 'adding twice changes nothing');
  assert.equal(ext.withExtension(added, mine, false), owner, 'the way back leaves the file as it was');
  assert.equal(ext.withExtension('--ozone-platform=wayland\n', mine), `--ozone-platform=wayland\n--load-extension=${mine}\n`);
  assert.equal(ext.withExtension(`--load-extension=${mine}\n`, mine, false), '');
  assert.equal(ext.withExtension('', mine), `--load-extension=${mine}\n`);
});

test('the flags file is the one the launcher names, and a launcher without one has none', () => {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'flags-'));
  writeFileSync(join(dir, 'launcher'), '\x7fELF\0chromium-flags.conf\0/usr/lib/chromium/chromium\0');
  writeFileSync(join(dir, 'plain'), '#!/bin/sh\nexec /opt/x/x "$@"\n');
  const env = { XDG_CONFIG_HOME: join(dir, 'config') };
  assert.equal(ext.flagsFile(join(dir, 'launcher'), env), join(dir, 'config', 'chromium-flags.conf'));
  assert.equal(ext.flagsFile(join(dir, 'plain'), env), null);
  assert.equal(ext.setFlags(join(dir, 'launcher'), '/x/extension', true, env), join(dir, 'config', 'chromium-flags.conf'));
  assert.equal(readFileSync(join(dir, 'config', 'chromium-flags.conf'), 'utf8'), `--load-extension=/x/extension\n# Added by Helm: no debugging bar while agents work in your browser.\n${ext.QUIET_FLAG}\n`);
  ext.setFlags(join(dir, 'launcher'), '/x/extension', false, env);
  assert.equal(readFileSync(join(dir, 'config', 'chromium-flags.conf'), 'utf8'), '');
});

test('the flags file hides the debugging bar, and the way back keeps the owner\'s own line', () => {
  const quiet = ext.withQuiet('--ozone-platform=wayland\n');
  assert.equal(quiet, `--ozone-platform=wayland\n# Added by Helm: no debugging bar while agents work in your browser.\n${ext.QUIET_FLAG}\n`);
  assert.equal(ext.withQuiet(quiet), quiet, 'adding twice changes nothing');
  assert.equal(ext.withQuiet(quiet, false), '--ozone-platform=wayland\n');
  const owners = `${ext.QUIET_FLAG}\n`;
  assert.equal(ext.withQuiet(owners), owners, 'the owner\'s own flag is enough');
  assert.equal(ext.withQuiet(owners, false), owners, 'and it stays on the way back');
});

test('the mode is saved per machine and defaults to the owner\'s own browser', () => {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'mode-'));
  assert.equal(ext.readMode(dir), 'extended');
  // A file from the first add-on, written by a test, is not the owner's choice.
  writeFileSync(join(dir, 'mode.json'), '{"mode":"window"}'); assert.equal(ext.readMode(dir), 'extended');
  ext.writeMode(dir, 'window'); assert.equal(ext.readMode(dir), 'window');
  ext.writeMode(dir, 'extended'); assert.equal(ext.readMode(dir), 'extended');
  assert.throws(() => ext.writeMode(dir, 'other'), /window or extended/);
});

test('at start the Helm service names the add-on in the browser\'s flags file, and a test copy never does', async t => {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'install-'));
  const before = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = join(dir, 'config');
  t.after(() => { if (before === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before; });
  const launcher = join(dir, 'brave'); writeFileSync(launcher, '#!/bin/sh\nCONF_FILE="${XDG_CONFIG_HOME}/brave-flags.conf"\n');
  const flags = join(dir, 'config', 'brave-flags.conf');
  mkdirSync(join(dir, 'config')); writeFileSync(flags, '--load-extension=/owner/add-on\n');
  const browsers = () => [{ name: 'Brave', program: join(dir, 'brave-bin'), launcher }];
  const quiet = new BrowserManager({ directory: join(dir, 'quiet'), canWindow: false, browsers });
  await quiet.prepare(); await quiet.stop();
  assert.equal(readFileSync(flags, 'utf8'), '--load-extension=/owner/add-on\n', 'tests leave the owner\'s browser alone');
  const manager = new BrowserManager({ directory: join(dir, 'helm'), canWindow: false, browsers });
  t.after(() => manager.stop());
  await manager.prepare({ install: true });
  assert.equal(readFileSync(flags, 'utf8'), `--load-extension=/owner/add-on,${ext.extensionFolder(join(dir, 'helm'))}\n# Added by Helm: no debugging bar while agents work in your browser.\n${ext.QUIET_FLAG}\n`);
  assert.ok(existsSync(join(ext.extensionFolder(join(dir, 'helm')), 'manifest.json')), 'the add-on is in Helm\'s folder');
  assert.equal(manager.relay.connected, false);
  assert.match(manager.ownBrowserSteps()[0], /Brave is closed/);
  const chosen = new BrowserManager({ directory: join(dir, 'chosen'), canWindow: false, browsers, mode: 'window' });
  writeFileSync(flags, ''); await chosen.prepare({ install: true }); await chosen.stop();
  assert.equal(readFileSync(flags, 'utf8'), '', 'the owner chose Helm\'s window: nothing is added');
});

test('the link lets in only the add-on with the key, and the driver with the token', async t => {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'relay-'));
  const relay = await new ExtensionRelay({ linkFile: join(dir, 'helm-link.json'), extensionId: ext.EXTENSION_ID }).start();
  t.after(() => relay.stop());
  const { port, key } = JSON.parse(readFileSync(join(dir, 'helm-link.json'), 'utf8'));
  assert.equal(port, relay.port); assert.match(key, /^[0-9a-f]{64}$/);
  const refused = (url, options) => new Promise(resolve => { const ws = new WebSocket(url, options); ws.on('open', () => { ws.close(); resolve(false); }); ws.on('error', () => resolve(true)); });
  assert.equal(await refused(`ws://127.0.0.1:${port}/extension`, { origin: 'https://evil.example' }), true, 'a web page is refused');
  assert.equal(await refused(`ws://127.0.0.1:${port}/cdp/wrong`), true, 'a driver without the token is refused');
  // The right page with the wrong key is closed after its first answer.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${ext.EXTENSION_ID}` });
  const closed = new Promise(resolve => ws.on('close', resolve));
  ws.on('message', raw => { const message = JSON.parse(raw); if (message.type === 'challenge') ws.send(JSON.stringify({ type: 'hello', proof: '00'.repeat(32), nonce: 'x', tabs: [] })); });
  await closed;
  assert.equal(relay.connected, false);
});

// A stand-in for one profile's copy of the add-on: it proves the key and opens tabs.
const fakeAddOn = (dir, { profile, userAgent = 'Chrome/150', firstTab = 100 }) => new Promise((resolve, reject) => {
  const { port, key } = JSON.parse(readFileSync(join(dir, 'helm-link.json'), 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${ext.EXTENSION_ID}` });
  const addOn = { ws, calls: [], closedWith: null }; let next = firstTab;
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type === 'challenge') { ws.send(JSON.stringify({ type: 'hello', proof: createHmac('sha256', Buffer.from(key, 'hex')).update(`helm-extension:${message.nonce}`).digest('hex'), nonce: 'n1', userAgent, version: ext.EXTENSION_VERSION, profile, tabs: [] })); return; }
    if (message.type === 'welcome') { resolve(addOn); return; }
    addOn.calls.push(message.method);
    const tabId = next++;
    ws.send(JSON.stringify({ id: message.id, result: message.method === 'tabs.create' ? { tabId, targetId: `T${tabId}` } : { from: profile } }));
  });
  ws.on('close', code => { addOn.closedWith = code; resolve(addOn); });
  ws.on('error', reject);
});

test('each profile of the owner\'s browser has its own link, and a tab\'s steps go to its profile', async t => {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'profiles-'));
  const relay = await new ExtensionRelay({ linkFile: join(dir, 'helm-link.json'), extensionId: ext.EXTENSION_ID, version: ext.EXTENSION_VERSION }).start();
  t.after(() => relay.stop());
  const personal = 'a'.repeat(32), work = 'b'.repeat(32);
  const one = await fakeAddOn(dir, { profile: personal, firstTab: 100 });
  const two = await fakeAddOn(dir, { profile: work, firstTab: 200 });
  assert.deepEqual(relay.profiles, [personal, work], 'both profiles are connected');
  const again = await fakeAddOn(dir, { profile: work });
  assert.equal(again.closedWith, 4001, 'one link per profile');
  const other = await fakeAddOn(dir, { profile: 'c'.repeat(32), userAgent: 'Other/1' });
  assert.equal(other.closedWith, 4001, 'one browser at a time');

  const driver = new WebSocket(relay.cdpUrl); await new Promise(resolve => driver.on('open', resolve));
  t.after(() => driver.close());
  let id = 0; const ask = (method, params = {}, sessionId) => new Promise(resolve => {
    const mine = ++id; const on = raw => { const m = JSON.parse(raw); if (m.id === mine) { driver.off('message', on); resolve(m); } };
    driver.on('message', on); driver.send(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  assert.equal((await ask('Target.createTarget', { url: 'about:blank', helmProfile: work })).result.targetId, 'T200', 'the tab opens in the named profile');
  assert.equal((await ask('Target.createTarget', { url: 'about:blank' })).result.targetId, 'T100', 'with no name, in the first profile');
  assert.match((await ask('Target.createTarget', { url: 'about:blank', helmProfile: 'd'.repeat(32) })).error.message, /not connected/, 'never in another profile than the one named');
  await ask('Target.setAutoAttach', { autoAttach: true });
  const session = [...relay.tabs.values()].find(tab => tab.tabId === 200).sessionId;
  assert.deepEqual((await ask('Runtime.evaluate', {}, session)).result, { from: work }, 'a step goes to the profile that holds the tab');
  // One profile closes: only its tabs go, the other profile stays.
  one.ws.close();
  for (const until = Date.now() + 5000; Date.now() < until && relay.tabs.has(100);) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(relay.tabs.has(100), false); assert.equal(relay.tabs.has(200), true);
  assert.deepEqual(relay.profiles, [work]);
  two.ws.close();
});

test('Helm finds a profile folder by the mark its add-on stored there', () => {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'marks-'));
  const store = name => { const folder = join(dir, name, 'Local Extension Settings', ext.EXTENSION_ID); mkdirSync(folder, { recursive: true }); return folder; };
  writeFileSync(join(store('Default'), '000003.log'), Buffer.concat([Buffer.from([1, 2, 3]), Buffer.from(`helmProfile"${'1'.repeat(32)}"`)]));
  writeFileSync(join(store('Profile 3'), '000005.ldb'), `x"${'2'.repeat(32)}"`);
  writeFileSync(join(store('Profile 4'), 'LOG'), `"${'3'.repeat(32)}"`);
  const profiles = ['Default', 'Profile 3', 'Profile 4', 'Missing'].map(directory => ({ dataDir: dir, directory }));
  assert.equal(ext.profileOfMark('1'.repeat(32), profiles).directory, 'Default');
  assert.equal(ext.profileOfMark('2'.repeat(32), profiles).directory, 'Profile 3');
  assert.equal(ext.profileOfMark('3'.repeat(32), profiles), null, 'only the storage files count');
  assert.equal(ext.profileOfMark('not a mark', profiles), null);
});

// A real Chromium with the add-on loaded, driven through Helm's own browser code.
const chromiumPath = process.env.HELM_TEST_CHROMIUM || systemChromium();
const noChromium = !chromiumPath && 'no Chromium-based browser here';

const startBrowser = async (t, directory) => {
  ext.syncExtension(directory);
  const profile = join(directory, 'owner-profile'); mkdirSync(profile, { recursive: true });
  const child = spawn(chromiumPath, ['--headless=new', `--user-data-dir=${profile}`, `--load-extension=${ext.extensionFolder(directory)}`, '--no-first-run', '--password-store=basic', '--use-mock-keychain', '--disable-breakpad', '--disable-crash-reporter', 'about:blank'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill(); await exited; });
  return child;
};

test('extended mode drives tabs in the owner\'s own browser and keeps them through a Helm restart', { skip: noChromium, timeout: 90000 }, async t => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Own browser</title><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const directory = mkdtempSync(join(process.env.HELM_DIR, 'own-'));
  ext.writeMode(directory, 'extended');
  const make = () => new BrowserManager({ directory, session: sid => ({ id: sid }), canWindow: true, ownerQuietMs: 300, extensionWaitMs: 20000, browsers: () => [] });
  let manager = make();
  await manager.prepare();
  await startBrowser(t, directory);
  assert.equal(await manager.relay.waitForExtension(20000), true, 'the add-on connects to Helm');

  const opened = (await manager.open('chat-1', { url })).tab;
  assert.equal(opened.url, url);
  const look = await manager.run('chat-1', opened.id, { kind: 'look' });
  assert.match(look.text, /Name/);
  const acted = await manager.run('chat-1', opened.id, { actions: [{ type: 'Ada', into: 'Name' }, { click: 'Save' }, { check: 'Ada' }] });
  assert.equal(acted.error, undefined, JSON.stringify(acted).slice(0, 400));
  // A background tab still answers fast: Helm makes it draw while an agent works.
  const started = Date.now();
  const clicked = await manager.run('chat-1', opened.id, { actions: [{ click: 'Save' }] });
  assert.equal(clicked.error, undefined); assert.ok(Date.now() - started < 1500, `a click took ${Date.now() - started} ms`);
  const shot = await manager.run('chat-1', opened.id, { kind: 'screenshot' });
  assert.match(shot.image, /^data:image\/(jpeg|png);base64,/);
  // Nothing from the owner's browser is copied into Helm's folder.
  assert.equal(existsSync(join(directory, 'chat-1', 'storage.json')), false);

  // Helm restarts: the add-on keeps the tab, and Helm takes it back.
  await manager.stop();
  manager = make(); t.after(() => manager.stop());
  await manager.prepare();
  assert.equal(await manager.relay.waitForExtension(20000), true, 'the add-on reconnects after a restart');
  const { tabs } = await manager.list('chat-1');
  assert.equal(tabs.length, 1); assert.equal(tabs[0].id, opened.id); assert.notEqual(tabs[0].asleep, true);
  const again = await manager.run('chat-1', opened.id, { actions: [{ check: 'Ada' }] });
  assert.equal(again.error, undefined, 'the same page, with what the agent typed');

  // Back to Helm's own window: the tab goes to sleep and the add-on's tab closes.
  await manager.setMode('window');
  assert.equal(manager.relay, null);
  assert.equal(ext.readMode(directory), 'window');
  const rows = JSON.parse(readFileSync(join(directory, 'chat-1', 'tabs.json'), 'utf8'));
  assert.equal(rows.length, 1, 'the tab is kept to open again');
});

test('a tab opens in the profile the agent names; a closed profile loads with no restart', { skip: (noChromium || process.platform !== 'linux') && 'needs Chromium on Linux', timeout: 120000 }, async t => {
  // The site shows the cookies it got, so each profile's own logins can be told apart.
  const server = createServer((req, res) => {
    if (req.url === '/set') res.setHeader('Set-Cookie', 'who=personal; Path=/');
    res.setHeader('Content-Type', 'text/html'); res.end(`<title>${req.headers.cookie || 'none'}</title><p>Signed in</p>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const directory = mkdtempSync(join(process.env.HELM_DIR, 'two-profiles-'));
  ext.syncExtension(directory); ext.writeMode(directory, 'extended');
  // The owner's browser: a full Chromium with no screen, so a second start hands over to it.
  const dataDir = join(directory, 'owner'), launcher = join(directory, 'chromium');
  writeFileSync(launcher, `#!/bin/sh\nexec "${chromiumPath}" --ozone-platform=headless --no-first-run --password-store=basic --use-mock-keychain --disable-breakpad --disable-crash-reporter "$@"\n`); chmodSync(launcher, 0o755);
  const child = spawn(launcher, [`--user-data-dir=${dataDir}`, '--profile-directory=Default', `--load-extension=${ext.extensionFolder(directory)}`, 'about:blank'], { stdio: 'ignore', env: { ...process.env, WAYLAND_DISPLAY: '', DISPLAY: '' } });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill(); await exited; });
  const profiles = [{ key: 'c:Default', dataDir, directory: 'Default', name: 'Personal', lastUsed: true }, { key: 'c:Profile 2', dataDir, directory: 'Profile 2', name: 'work' }];
  const logins = { listProfiles: async () => profiles, resolveProfile: async name => { const found = profiles.find(p => p.name === name || p.directory === name); if (!found) throw new Error(`no profile ${name}`); return found; } };
  const manager = new BrowserManager({ directory, session: sid => ({ id: sid }), canWindow: true, ownerQuietMs: 300, extensionWaitMs: 20000, logins, browsers: () => [{ name: 'Chromium', program: chromiumPath, launcher }] });
  t.after(() => manager.stop());
  await manager.prepare();
  assert.equal(await manager.relay.waitForExtension(30000), true, 'the add-on connects to Helm');
  assert.equal(manager.relay.profiles.length, 1, 'only the open profile is connected');

  // No profile named: the profile the owner used last.
  const personal = await manager.open('chat-1', { url: `${base}/set` });
  assert.equal(personal.profile, 'Personal (Default)');
  assert.match((await manager.open('chat-1', { url: base })).tab.title, /who=personal/);
  // The agent names a profile that has no window: the running browser loads it.
  const work = await manager.open('chat-2', { url: base, profile: 'work' });
  assert.equal(work.profile, 'work (Profile 2)');
  assert.equal(work.tab.title, 'none', 'the work profile has its own logins');
  assert.equal(manager.relay.profiles.length, 2);
  assert.equal(child.exitCode, null, 'the owner\'s browser kept running');
  // The chat keeps its profile for later tabs, and through a Helm restart.
  assert.equal((await manager.open('chat-2', { url: base })).profile, 'work (Profile 2)');
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'chat-2', 'profile.json'), 'utf8')), { dataDir, directory: 'Profile 2', name: 'work' });
  const listed = (await manager.profiles('chat-2')).profiles;
  assert.deepEqual(listed.map(p => !!p.connected), [true, true], 'the list shows both profiles connected');
  await assert.rejects(manager.open('chat-3', { url: base, profile: 'nobody' }), /no profile nobody/);
});

test('Set up opens Chrome\'s add-ons page and copies the folder; Settings sees each state', async t => {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'setup-'));
  const calls = [];
  const chrome = { name: 'Google Chrome', program: join(dir, 'chrome'), launcher: join(dir, 'chrome') };
  writeFileSync(chrome.program, '#!/bin/sh\n');
  const manager = new BrowserManager({ directory: join(dir, 'helm'), canWindow: true, mode: 'window', browsers: () => [chrome],
    setupTools: { copyText: async text => { calls.push(['copy', text]); return true; }, openExtensionsPage: options => { calls.push(['open', options.launcher]); return true; } } });
  t.after(() => manager.stop());
  assert.equal((await manager.modeInfo()).state, 'off');
  const done = await manager.ownerSetup();
  assert.equal(ext.readMode(join(dir, 'helm')), 'extended', 'Set up turns the owner\'s browser on');
  assert.equal(done.state, 'one-step');
  assert.deepEqual(calls, [['copy', ext.extensionFolder(join(dir, 'helm'))], ['open', chrome.launcher]]);
  assert.deepEqual(done.steps, ext.pasteSteps());
  assert.match(manager.ownBrowserSteps()[0], /Do the task in Helm's window now/);
  const routes = createBrowserRoutes({ sessions: { get: () => { throw new Error('no chat needed'); } }, manager });
  assert.equal((await routes.dispatch('browser.setup', {})).state, 'one-step');
  assert.equal((await routes.dispatch('browser.setup', { do: 'mode', mode: 'window' })).state, 'off');
  const none = new BrowserManager({ directory: join(dir, 'none'), canWindow: true, browsers: () => [] });
  t.after(() => none.stop());
  assert.equal((await none.modeInfo()).state, 'none');
  await assert.rejects(none.ownerSetup(), /no Chromium-based browser/);
  assert.equal((await new BrowserManager({ directory: join(dir, 'vm'), canWindow: false }).modeInfo()).state, 'no-screen');
});

test('until the owner\'s browser connects, tabs open in Helm\'s window, then move after the step', { skip: noChromium, timeout: 90000 }, async t => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Move</title><button>Ready</button>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const directory = mkdtempSync(join(process.env.HELM_DIR, 'fallback-'));
  const { chromium } = await import('patchright-core');
  const manager = new BrowserManager({ directory, session: sid => ({ id: sid }), canWindow: true, ownerQuietMs: 300, extensionWaitMs: 300, browsers: () => [],
    launchWindow: dir => chromium.launchPersistentContext(dir, { headless: true, executablePath: chromiumPath }) });
  t.after(() => manager.stop());
  await manager.prepare({ install: false });
  const opened = await manager.open('chat-1', { url });
  assert.match(opened.note, /opened in Helm's window/);
  assert.equal(manager.shared.helmOwnBrowser, undefined);
  assert.match((await manager.run('chat-1', opened.tab.id, { kind: 'look' })).text, /Ready/);

  await startBrowser(t, directory);
  assert.equal(await manager.relay.waitForExtension(20000), true, 'the add-on connects to Helm');
  // Helm's window closes once no step runs; the tab sleeps and opens again in the owner's browser.
  for (const until = Date.now() + 20000; Date.now() < until && manager.shared;) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(manager.shared, null, 'Helm\'s window was put away');
  const look = await manager.run('chat-1', opened.tab.id, { kind: 'look' });
  assert.match(look.text, /Ready/);
  assert.equal(manager.shared.helmOwnBrowser, true, 'the tab is in the owner\'s browser now');
  const again = await manager.open('chat-1', { url });
  assert.equal(again.note, undefined, 'no note once the owner\'s browser is in use');
});

test('a closed browser without a flags file is started with no window, so agents use the owner\'s real profile, never a copy', { skip: noChromium, timeout: 90000 }, async t => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Started</title><button>Ready</button>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const directory = mkdtempSync(join(process.env.HELM_DIR, 'start-'));
  ext.writeMode(directory, 'extended');
  // A launcher without a flags file, whose program is not running.
  const launcher = join(directory, 'brave'); writeFileSync(launcher, '#!/bin/sh\n');
  const started = [];
  const manager = new BrowserManager({ directory, session: sid => ({ id: sid }), canWindow: true, ownerQuietMs: 300, extensionWaitMs: 300,
    browsers: () => [{ name: 'Brave', program: join(directory, 'brave-bin'), launcher }],
    startOwn: browser => { started.push(browser); void startBrowser(t, directory); return true; },
    launchWindow: () => { throw new Error('Helm\'s own window must not open'); } });
  t.after(() => manager.stop());
  await manager.prepare({ install: false });
  const opened = await manager.open('chat-1', { url });
  assert.equal(opened.note, undefined, 'the tab is in the owner\'s browser, not in Helm\'s window');
  assert.equal(manager.shared.helmOwnBrowser, true);
  assert.deepEqual(started.map(browser => [browser.program, browser.launcher]), [[join(directory, 'brave-bin'), launcher]], 'Helm started the owner\'s browser once');
  assert.match((await manager.run('chat-1', opened.tab.id, { kind: 'look' })).text, /Ready/);
});

test('the owner\'s browser is found also when Chromium writes its command as one line', () => {
  assert.equal(ext.ownBrowserCommand('/opt/brave-bin/brave\0--password-store=basic\0'), true);
  assert.equal(ext.ownBrowserCommand('/opt/brave-bin/brave --password-store=basic --load-extension=/a,/b'), true);
  assert.equal(ext.ownBrowserCommand('/opt/brave-bin/brave --password-store=basic --user-data-dir=/home/me/.helm/app-window --app=http://127.0.0.1:8787/'), false, 'the Helm app window');
  assert.equal(ext.ownBrowserCommand('/opt/brave-bin/brave --type=renderer --lang=en-US'), false, 'a helper process');
  assert.equal(ext.ownBrowserCommand('/opt/brave-bin/brave\0--user-data-dir=/tmp/helm-window\0'), false);
  assert.equal(ext.ownBrowserCommand('browser.exe "--user-data-dir=C:/User Name/.helm/app-window"'), false);
  assert.equal(ext.ownBrowserCommand('browser.exe --user-data-dir "C:/User Name/.helm/app-window"'), false);
});

test('a restart closes only the owner\'s browser and opens it again with its last tabs', { skip: process.platform !== 'linux' && 'reads /proc' }, async t => {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'restart-'));
  // A stand-in for the browser program: its own file, so only it matches.
  const program = join(dir, 'browser'); writeFileSync(program, readFileSync('/bin/sh')); chmodSync(program, 0o755);
  const running = spawn(program, ['-c', 'while :; do sleep 0.2; done'], { stdio: 'ignore' }), gone = new Promise(resolve => running.once('exit', resolve));
  const helms = spawn(program, ['-c', 'while :; do sleep 0.2; done', '--user-data-dir=/tmp/helm-window'], { stdio: 'ignore' });
  t.after(() => { running.kill(); helms.kill(); });
  await new Promise(resolve => running.once('spawn', resolve));
  assert.deepEqual(ext.ownBrowserPids(program), [running.pid], 'Helm\'s own window is never the owner\'s browser');
  const said = join(dir, 'said'), launcher = join(dir, 'launcher');
  writeFileSync(launcher, `#!/bin/sh\necho "$@" > ${said}\n`); chmodSync(launcher, 0o755);
  const result = await ext.restartOwnBrowser({ program, launcher, env: { ...process.env, HELM_NO_SERVICE: '1' } });
  assert.equal(result.closed, 1); await gone;
  for (const until = Date.now() + 5000; Date.now() < until && !existsSync(said);) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(readFileSync(said, 'utf8').trim(), '--restore-last-session');
  assert.equal(helms.exitCode, null, 'other copies keep running');
});

test('helm browser mode asks the chat\'s machine, and an agent can never restart the owner\'s browser', async () => {
  const { runBrowserCommand } = await import('../packages/connect/src/browser-cli.js');
  const calls = [];
  const run = args => runBrowserCommand(args, { rpc: async (env, method, params, ms) => { calls.push({ method, params, ms }); return { mode: params.mode || 'window', tab: { id: 'x' } }; }, self: () => 'here', env: { HELM_SESSION_ID: 'chat-1' }, print: () => {} });
  await run(['mode']); await run(['mode', 'extended']); await run(['mode', 'window']);
  assert.deepEqual(calls.map(call => [call.method, call.params]), [['browser.mode', { id: 'chat-1' }], ['browser.mode', { id: 'chat-1', mode: 'extended' }], ['browser.mode', { id: 'chat-1', mode: 'window' }]]);
  await assert.rejects(run(['mode', 'other']), /window or extended/);
  await assert.rejects(run(['mode', 'extended', '--restart']), /never restart/);
  assert.equal(calls.length, 3, 'nothing was sent for --restart');
  await run(['open', 'https://example.com', '--profile', 'work']);
  assert.deepEqual(calls[3].params, { id: 'chat-1', url: 'https://example.com', profile: 'work' }, 'open names the profile');
  const seen = [];
  const manager = { owner: id => seen.push(['owner', id]), modeInfo: async () => ({ mode: 'window' }), setMode: async (mode, options) => { seen.push(['set', mode, options]); return { mode }; } };
  const routes = createBrowserRoutes({ sessions: { get: () => ({}) }, manager });
  assert.deepEqual(await routes.dispatch('browser.mode', { id: 'chat-1' }), { mode: 'window' });
  await routes.dispatch('browser.mode', { id: 'chat-1', mode: 'extended', restart: true });
  assert.deepEqual(seen, [['owner', 'chat-1'], ['owner', 'chat-1'], ['set', 'extended', { restart: true }]]);
});

test('the saved main browser wins, survives mode changes, and falls back when removed', async t => {
  const directory = mkdtempSync(join(process.env.HELM_DIR, 'main-'));
  let found = [{ name: 'Chromium', program: '/missing/chromium', systemDefault: true }, { name: 'Vivaldi', program: '/missing/vivaldi' }];
  const manager = new BrowserManager({ directory, canWindow: true, mode: 'window', browsers: () => found });
  t.after(() => manager.stop());
  assert.equal(manager.ownBrowser().name, 'Chromium');
  await manager.setMain('vIvAlDi');
  assert.equal(manager.ownBrowser().name, 'Vivaldi');
  ext.writeMode(directory, 'window');
  assert.equal(ext.readChoice(directory).main, 'Vivaldi');
  assert.deepEqual(manager.mainInfo().browsers.map(b => b.selected), [false, true]);
  found = found.slice(0, 1);
  assert.equal(manager.ownBrowser().name, 'Chromium');
  await assert.rejects(manager.setMain('Firefox'), /Choose a browser/);
  found = [{ name: 'Helium', program: '/missing/helium' }, ...found.map(b => ({ ...b, systemDefault: false }))];
  assert.equal(manager.mainNote(), '', 'a saved choice counts even when temporarily absent');
  const other = new BrowserManager({ directory: join(directory, 'other'), browsers: () => found });
  assert.match(other.mainNote(), /Ask the owner once/);
});

test('menu setup keeps Flatpak and other add-ons, then restores the owner entry', () => {
  const directory = mkdtempSync(join(process.env.HELM_DIR, 'menu-'));
  const desktopFile = join(directory, 'org.wave.Browser.desktop'), env = { HOME: directory };
  const original = '[Desktop Entry]\nName=Wave\nExec=/usr/bin/flatpak run org.wave.Browser --load-extension=/owner %U\n[Desktop Action private]\nExec=/usr/bin/flatpak run org.wave.Browser --incognito\n';
  writeFileSync(desktopFile, original);
  const browser = { name: 'Wave', program: '/usr/bin/flatpak', desktopFile };
  const target = ext.setDesktop(browser, '/helm folder/extension', true, env, 'linux');
  const added = readFileSync(target, 'utf8');
  assert.match(added, /# Helm browser entry:/);
  assert.match(added, /Exec=\/usr\/bin\/flatpak run org.wave.Browser "--load-extension=\/owner,\/helm folder\/extension" %U --silent-debugger-extension-api/);
  assert.equal((added.match(/--silent-debugger-extension-api/g) || []).length, 2);
  ext.setDesktop(browser, '/helm folder/extension', true, env, 'linux');
  assert.equal(readFileSync(target, 'utf8'), added);
  ext.setDesktop(browser, '/helm folder/extension', false, env, 'linux');
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(desktopFile, 'utf8'), original);
  mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, original);
  ext.setDesktop({ ...browser, desktopFile: target }, '/extension', true, env, 'linux');
  ext.setDesktop({ ...browser, desktopFile: target }, '/extension', false, env, 'linux');
  assert.equal(readFileSync(target, 'utf8'), original);
});

test('switching the main browser removes old setup and closes its link', async t => {
  const directory = mkdtempSync(join(process.env.HELM_DIR, 'switch-'));
  const before = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = join(directory, 'config');
  t.after(() => { if (before === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before; });
  const browsers = ['brave', 'vivaldi'].map(name => {
    const launcher = join(directory, name); writeFileSync(launcher, `#!/bin/sh\n${name}-flags.conf\n`);
    return { name, program: launcher, launcher };
  });
  const manager = new BrowserManager({ directory, canWindow: true, browsers: () => browsers });
  t.after(() => manager.stop()); await manager.prepare({ install: true });
  const relay = manager.relay, folder = ext.extensionFolder(directory);
  await manager.setMain('Brave');
  assert.equal(manager.relay, relay, 'saving the current browser keeps the live link');
  assert.equal((await manager.modeInfo()).folder, folder);
  await manager.setMain('Vivaldi');
  assert.notEqual(manager.relay, relay);
  assert.doesNotMatch(readFileSync(join(directory, 'config/brave-flags.conf'), 'utf8'), /load-extension/);
  assert.match(readFileSync(join(directory, 'config/vivaldi-flags.conf'), 'utf8'), /load-extension/);
  assert.notEqual((await manager.modeInfo()).folder, folder, 'the old browser cannot reconnect to the new browser link');
  await manager.setMode('window');
  assert.equal(readFileSync(join(directory, 'config/vivaldi-flags.conf'), 'utf8'), '');
});

test('Helm starts any supported browser with add-on flags and launcher arguments', async () => {
  const { watch } = await import('node:fs/promises');
  const directory = mkdtempSync(join(process.env.HELM_DIR, 'launch-'));
  const launcher = join(directory, 'launcher'), output = join(directory, 'args');
  writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > "${output}"\n`); chmodSync(launcher, 0o755);
  const watcher = watch(directory);
  try {
    assert.equal(ext.startOwnBrowser({ program: launcher, args: ['run', 'org.wave.Browser'], folder: '/helm/extension', env: { ...process.env, HELM_NO_SERVICE: '1' } }), true);
    for await (const event of watcher) {
      if (event.filename === 'args' && existsSync(output) && readFileSync(output, 'utf8').includes('--no-startup-window')) break;
    }
    assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), ['run', 'org.wave.Browser', '--load-extension=/helm/extension', ext.QUIET_FLAG, '--no-startup-window']);
  } finally { await watcher.return(); }
});

test('Chrome and Edge keep manual setup; other Chromium browsers load the add-on', async t => {
  for (const name of ['Google Chrome', 'Microsoft Edge', 'Edge', 'msedge']) {
    const manager = new BrowserManager({ directory: join(process.env.HELM_DIR, name), canWindow: true, browsers: () => [{ name, program: `/missing/${name}` }] });
    t.after(() => manager.stop());
    assert.equal((await manager.modeInfo()).state, 'one-step');
    assert.match(manager.ownBrowserSteps()[0], /one step from the owner/);
  }
  for (const name of ['Brave', 'Helium', 'Vivaldi', 'Chromium']) assert.equal(ext.manualBrowser({ name, program: `/missing/${name}` }), false);
});

test('helm browser main lists and sets the main browser on the chat machine', async () => {
  const { runBrowserCommand } = await import('../packages/connect/src/browser-cli.js');
  const calls = [], output = [];
  const routes = createBrowserRoutes({ manager: { owner() {}, mainInfo: () => ({ browsers: [{ name: 'Brave', selected: true }] }), setMain: name => ({ browser: name }) } });
  const run = args => runBrowserCommand(args, { rpc: async (env, method, params) => { calls.push([method, params]); return routes.dispatch(method, params); }, self: () => 'here', env: { HELM_SESSION_ID: 'chat' }, print: text => output.push(JSON.parse(text)) });
  await run(['main']); await run(['main', 'Google', 'Chrome']);
  assert.equal(output[0].browsers[0].selected, true);
  assert.equal(output[1].browser, 'Google Chrome');
  assert.deepEqual(calls, [['browser.main', { id: 'chat' }], ['browser.main', { id: 'chat', name: 'Google Chrome' }]]);
  await runBrowserCommand(['main'], { rpc: (env, method, params) => routes.dispatch(method, params), self: () => 'here', env: {}, print() {} });
});

 test('launch flags keep existing add-ons and do not mistake Helium for Chrome', () => {
  const directory = mkdtempSync(join(process.env.HELM_DIR, 'launch-flags-'));
  const launcher = join(directory, 'launcher'); writeFileSync(launcher, '#!/bin/sh\nwave-flags.conf\n');
  writeFileSync(join(directory, 'wave-flags.conf'), '--load-extension=/owner\n');
  assert.deepEqual(ext.extensionArgs('/helm', false, launcher, ['run', 'org.wave.Browser', '--load-extension=/other'], { XDG_CONFIG_HOME: directory }), ['run', 'org.wave.Browser', '--load-extension=/owner,/other,/helm', ext.QUIET_FLAG]);
  assert.equal(ext.manualBrowser({ name: 'Helium', program: '/opt/helium/chrome' }), false);
});

 test('macOS and Windows find the real browser and exclude Helm app windows', () => {
  const program = '/Applications/Wave.app/Contents/MacOS/Wave';
  assert.deepEqual(ext.ownBrowserPids(program, { platform: 'darwin', run: () => `12 ${program} --no-first-run\n13 ${program} --user-data-dir=/helm/app-window\n14 ${program} --type=renderer` }), [12]);
  const exe = 'C:/Wave/browser.exe';
  assert.deepEqual(ext.ownBrowserPids(exe, { platform: 'win32', run: () => JSON.stringify([
    { ProcessId: 12, ExecutablePath: exe, CommandLine: `${exe} --no-first-run` },
    { ProcessId: 13, ExecutablePath: exe, CommandLine: `${exe} --user-data-dir=/helm/app-window` },
    { ProcessId: 14, ExecutablePath: exe, CommandLine: `${exe} --type=renderer` },
  ]) }), [12]);
});
