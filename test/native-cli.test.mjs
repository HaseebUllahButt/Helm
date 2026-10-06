import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'helm-native-test-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NO_SYSTEMD_RUN = '1';
process.env.HELM_NATIVE_SOCKET = join(root, 'native.sock');
mkdirSync(process.env.HELM_DIR);
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [] }));
const { TerminalHost, NATIVE_SOCKET_PATH } = await import('../packages/connect/src/terminals.js');
const { interactiveLaunch, installNativeLaunchers, integrateNativeCommands, removeNativeLaunchers } = await import('../packages/connect/src/native-cli.js');
const { loadPty } = await import('../packages/connect/src/pty.js');
const { Sessions } = await import('../packages/connect/src/sessions.js');

async function until(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error('timed out');
}

test('normal interactive commands integrate; scripts, auth, app-server and desktop retain their provider path', () => {
  for (const [engine, args] of [['claude', []], ['claude', ['--model', 'fable']], ['claude', ['--resume', 'native-id']], ['codex', ['--yolo']], ['codex', ['resume', 'native-id']], ...['pi', 'omp', 'devin', 'opencode', 'opencode2', 'grok', 'cursor', 'rovo', 'agy', 'gemini', 'kimi', 'muse'].map(engine => [engine, []])]) {
    assert.equal(interactiveLaunch(engine, args, {}, true), true);
  }
  for (const [engine, args] of [['claude', ['-p', 'hello']], ['claude', ['auth', 'status']], ['claude', ['--desktop']], ['codex', ['app-server', '--stdio']], ['codex', ['exec', 'hello']], ['codex', ['login']], ['codex', ['cloud', 'list']], ['codex', ['--version']], ['codex', ['-V']], ['pi', ['--mode', 'rpc']], ['omp', ['--mode', 'json']], ['opencode', ['acp']], ['opencode2', ['run', 'hello']], ['devin', ['acp']], ['grok', ['agent', 'stdio']], ['gemini', ['--experimental-acp']], ['cursor', ['--print=hello']], ['muse', ['login']], ['shell', []]]) {
    assert.equal(interactiveLaunch(engine, args, {}, true), false);
  }
  assert.equal(interactiveLaunch('codex', ['--model', 'cloud'], {}, true), true, 'a flag value is not a subcommand');
  assert.equal(interactiveLaunch('claude', [], {}, false), false);
  assert.equal(interactiveLaunch('claude', [], { HELM_SESSION_ID: 'managed' }, true), false);
});

test('launchers are idempotent and only cover CLIs Helm can share', () => {
  const dir = join(root, 'launchers');
  assert.deepEqual(installNativeLaunchers({ claude: 'claude', shell: 'shell', 'bad name': 'claude' }, { dir }), ['claude']);
  const first = readFileSync(join(dir, 'claude'), 'utf8');
  assert.deepEqual(installNativeLaunchers({ claude: 'claude' }, { dir }), ['claude']);
  assert.equal(readFileSync(join(dir, 'claude'), 'utf8'), first);
  installNativeLaunchers({}, { dir });
  assert.throws(() => readFileSync(join(dir, 'claude')));
});

test('bash login PATH changes cannot bypass the shared CLI launcher', () => {
  const home = join(root, 'shell-home'), real = join(home, 'local-bin'), dir = join(home, 'helm-bin');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const rc = join(home, '.bashrc'), login = join(home, '.bash_profile');
  writeFileSync(rc, '# existing interactive configuration\n');
  writeFileSync(login, `. '${rc}'\nexport PATH='${real}':"$PATH"\n`);
  const originalPath = process.env.PATH, originalShell = process.env.SHELL;
  process.env.PATH = `${real}:/usr/bin:/bin`; process.env.SHELL = '/bin/bash';
  try {
    integrateNativeCommands({ enable: true, home, dir });
    const installed = readFileSync(login, 'utf8');
    assert.equal(execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', '. "$1"; command -v claude', 'test', login],
      { encoding: 'utf8', env: { ...process.env, PATH: `${real}:/usr/bin:/bin` } }).trim(), join(dir, 'claude'));
    integrateNativeCommands({ enable: true, home, dir });
    assert.equal(readFileSync(login, 'utf8'), installed, 'repair remains idempotent');
    removeNativeLaunchers({ home, dir });
    assert.equal(readFileSync(login, 'utf8').includes('helm: normal CLI'), false);
    assert.match(readFileSync(login, 'utf8'), /export PATH=/, 'keep the owner login configuration');
  } finally {
    process.env.PATH = originalPath;
    if (originalShell === undefined) delete process.env.SHELL; else process.env.SHELL = originalShell;
  }
});

for (const engine of ['claude', 'pi', 'devin', 'opencode']) test(`${engine}: native launch preserves arguments and account; phone answers after laptop closes and daemon restarts`, { skip: !(await loadPty()) }, async (t) => {
  const pty = await loadPty();
  const provider = join(root, 'native-provider.cjs');
  writeFileSync(provider, `const readline = require('node:readline');
console.log(JSON.stringify({pid:process.pid,args:process.argv.slice(2),cwd:process.cwd(),account:process.env.CLAUDE_CONFIG_DIR}));
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
rl.question('Permission: allow harmless operation? [y/n] ', answer=>{
 console.log('APPROVAL='+answer); rl.question('Question: choose a color: ', color=>{
 console.log('ANSWER='+color); rl.question('Message: ', message=>{console.log('MESSAGE='+message); console.log('SAME_PID='+process.pid); setTimeout(()=>rl.close(),200)});
 });
});`);
  const bin = fileURLToPath(new URL('../packages/connect/bin/helm-native-cli.js', import.meta.url));
  const client = pty.spawn(process.execPath, [bin, engine, process.execPath, provider, '--model', 'provider-model'], {
    cwd: root, cols: 100, rows: 30,
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'personal-account'), HELM_SESSION_ID: '', HELM_NATIVE_SESSION: '' },
  });
  t.after(() => { try { client.kill(); } catch {} });
  let local = ''; client.onData((chunk) => { local += chunk; });
  await until(() => local.includes('Permission:'));
  const host = new TerminalHost({ socketPath: NATIVE_SOCKET_PATH, unit: 'helm-native-test' });
  assert.equal(await host.ensure({ spawn: false }), true);
  const meta = host.nativeSessions()[0];
  assert.ok(meta.id.startsWith('native-'));
  assert.equal(meta.engine, engine);
  const identity = JSON.parse(local.slice(local.indexOf('{'), local.indexOf('}') + 1));
  assert.deepEqual(identity.args, ['--model', 'provider-model']);
  assert.equal(identity.cwd, root);
  assert.equal(identity.account, join(root, 'personal-account'));
  assert.equal(identity.pid, meta.nativePid);
  class Runtime extends EventEmitter { async listLive() { return new Map(); } }
  const first = new Sessions(new Runtime(), { nativeHost: host, nativeDiscovery: false });
  await first.adoptTerminals();
  assert.equal(first.get(meta.id).nativeCli, true);
  const rows = await first.list();
  const row = rows.find((s) => s.id === meta.id);
  assert.equal(row.shared, true); assert.equal(row.alive, true);
  assert.equal(row.nativeHome, undefined, 'internal account paths stay machine-side');
  await first.attach(meta.id);
  await first.input(meta.id, 'y\r', { raw: true });
  await until(() => local.includes('APPROVAL=y') && local.includes('Question:'));
  assert.equal(host.nativeSessions()[0].nativePid, identity.pid, 'Helm controls the same process while the laptop CLI stays open');
  // The laptop disappears without ending the provider.
  client.kill('SIGTERM');
  await first.stop();
  const secondHost = new TerminalHost({ socketPath: NATIVE_SOCKET_PATH, unit: 'helm-native-test' });
  const second = new Sessions(new Runtime(), { nativeHost: secondHost, nativeDiscovery: false });
  t.after(async () => { await second.stop(); });
  await second.adoptTerminals();
  const snapshot = await second.attach(meta.id);
  assert.match(snapshot.text, /Question:/);
  await assert.rejects(second.input(meta.id, 'an ordinary message'), /Live control/,
    'chat messages must never press Enter into a native permission menu');
  assert.equal(secondHost.nativeSessions()[0].nativePid, identity.pid);
  let remote = snapshot.text;
  second.on('data', (d) => { if (d.id === meta.id) remote += d.text; });
  await second.input(meta.id, 'blue\r', { raw: true });
  await until(() => remote.includes('ANSWER=blue') && remote.includes('Message:'));
  await second.input(meta.id, 'continue on phone\r', { raw: true });
  await until(() => remote.includes('MESSAGE=continue on phone'));
  assert.match(remote, new RegExp('SAME_PID='+identity.pid));
  await until(() => !secondHost.has(meta.id));
});

test.after(async () => {
  const host = new TerminalHost({ socketPath: NATIVE_SOCKET_PATH });
  if (await host.ensure({ spawn: false })) await host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test('Helm answers its own channel warning once, and nothing else', async () => {
  const { channelConsent } = await import('../packages/connect/src/native-cli.js');
  const sent = [];
  const watch = channelConsent((t) => sent.push(t));
  watch('\x1b[1mWARNING: Loading\x1b[1Cdevelopment channels\x1b[0m');
  assert.deepEqual(sent, [], 'not until the choice is on screen');
  watch('\n\x1b[36m❯ 1. I am using this for\x1b[1Clocal development\x1b[0m\n  2. Exit');
  watch('Loading development channels ... local development');
  assert.deepEqual(sent, ['\r']);
  const other = [];
  channelConsent((t) => other.push(t))('Quick safety check: Is this a project you trust?');
  assert.deepEqual(other, []);
});

test('an older Claude without channels keeps the plain terminal', async () => {
  const { claudeTakesChannels } = await import('../packages/connect/src/native-cli.js');
  const bin = join(root, 'fake-claude'), old = join(root, 'old-claude');
  writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 }); writeFileSync(old, '#!/bin/sh\n#old\n', { mode: 0o755 });
  const fail = (text) => () => { throw Object.assign(new Error('exit 1'), { stdout: '', stderr: text }); };
  assert.equal(claudeTakesChannels(bin, { run: fail('Error: Input contained only whitespace. Provide a prompt') }), true);
  assert.equal(claudeTakesChannels(bin, { run: fail("error: unknown option '--x'") }), true, 'remembered per version');
  assert.equal(claudeTakesChannels(old, { run: fail("error: unknown option '--dangerously-load-development-channels'") }), false);
});
