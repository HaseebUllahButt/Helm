import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from 'node:http';
import WebSocket from 'ws';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-browser-extension-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rm(process.env.HELM_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { ExtensionRelay, extensionIdFromKey } = await import('../packages/connect/src/browser-relay.js');
const ext = await import('../packages/connect/src/browser-extension.js');
const { systemChromium } = await import('../packages/connect/src/browser-window.js');

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
  assert.equal(readFileSync(join(dir, 'config', 'chromium-flags.conf'), 'utf8'), '--load-extension=/x/extension\n');
  ext.setFlags(join(dir, 'launcher'), '/x/extension', false, env);
  assert.equal(readFileSync(join(dir, 'config', 'chromium-flags.conf'), 'utf8'), '');
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
  assert.equal(readFileSync(flags, 'utf8'), `--load-extension=/owner/add-on,${ext.extensionFolder(join(dir, 'helm'))}\n`);
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

test('helm browser mode asks the chat\'s machine, and --restart goes only with extended', async () => {
  const { runBrowserCommand } = await import('../packages/connect/src/browser-cli.js');
  const calls = [];
  const run = args => runBrowserCommand(args, { rpc: async (env, method, params, ms) => { calls.push({ method, params, ms }); return { mode: params.mode || 'window' }; }, self: () => 'here', env: { HELM_SESSION_ID: 'chat-1' }, print: () => {} });
  await run(['mode']); await run(['mode', 'extended', '--restart']); await run(['mode', 'window']);
  assert.deepEqual(calls.map(call => [call.method, call.params]), [['browser.mode', { id: 'chat-1' }], ['browser.mode', { id: 'chat-1', mode: 'extended', restart: true }], ['browser.mode', { id: 'chat-1', mode: 'window', restart: false }]]);
  assert.equal(calls[1].ms, 60000, 'a restart may take a while');
  await assert.rejects(run(['mode', 'other']), /window or extended/);
  await assert.rejects(run(['mode', 'window', '--restart']), /--restart/);
  const { createBrowserRoutes } = await import('../packages/connect/src/browser-routes.js');
  const seen = [];
  const manager = { owner: id => seen.push(['owner', id]), modeInfo: async () => ({ mode: 'window' }), setMode: async (mode, options) => { seen.push(['set', mode, options]); return { mode }; } };
  const routes = createBrowserRoutes({ sessions: { get: () => ({}) }, manager });
  assert.deepEqual(await routes.dispatch('browser.mode', { id: 'chat-1' }), { mode: 'window' });
  await routes.dispatch('browser.mode', { id: 'chat-1', mode: 'extended', restart: true });
  assert.deepEqual(seen, [['owner', 'chat-1'], ['owner', 'chat-1'], ['set', 'extended', { restart: true }]]);
});
