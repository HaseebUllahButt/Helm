import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'helm-takeover-')));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NO_SYSTEMD_RUN = '1';
process.env.HELM_NATIVE_SOCKET = join(root, 'native.sock');
const home = join(root, 'claude-home'), work = join(root, 'work'), bin = join(root, 'bin');
const conversation = '22222222-3333-4444-8555-666666666666';
const transcript = join(home, 'projects', '-work', `${conversation}.jsonl`);
for (const dir of [process.env.HELM_DIR, work, bin, join(home, 'projects', '-work')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'claude', label: 'Claude', engine: 'claude', cmd: 'claude', args: [], env: { CLAUDE_CONFIG_DIR: home }, source: 'custom' }] }));
writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: work, sessionId: conversation,
  message: { role: 'user', content: 'first prompt' } }) + '\n');
// A stand-in for Claude Code: its live registry, its arguments, a prompt.
const fake = join(bin, 'claude');
writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), home = process.env.CLAUDE_CONFIG_DIR;
fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
const reg = path.join(home, 'sessions', process.pid + '.json');
fs.writeFileSync(reg, JSON.stringify({ pid: process.pid, sessionId: ${JSON.stringify(conversation)}, cwd: process.cwd(),
  kind: 'interactive', status: args.includes('--resume') ? 'idle' : 'busy' }));
console.log('ARGS=' + JSON.stringify(args) + ' ACCOUNT=' + home + ' PID=' + process.pid);
process.stdin.setEncoding('utf8');
let line = '';
process.stdin.on('data', (d) => { line += d; if (/[\\r\\n]/.test(line)) { console.log('GOT=' + line.trim()); line = ''; } });
process.on('SIGTERM', () => { fs.rmSync(reg, { force: true }); process.exit(0); });
setInterval(() => {}, 1000);
`, { mode: 0o755 });

const { loadPty } = await import('../packages/connect/src/pty.js');
const { TerminalHost, NATIVE_SOCKET_PATH } = await import('../packages/connect/src/terminals.js');
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { resumeCommand } = await import('../packages/connect/src/takeover.js');
const { sharedConversation } = await import('../packages/connect/src/native-cli.js');
const pty = await loadPty();

async function until(fn, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const r = await fn(); if (r) return r; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out');
}

test.after(async () => {
  const host = new TerminalHost({ socketPath: NATIVE_SOCKET_PATH });
  if (await host.ensure({ spawn: false })) await host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test('reopening keeps the settings and drops what picked the conversation and the opening prompt', () => {
  assert.deepEqual(resumeCommand('claude', ['/bin/claude', '--model', 'opus', '-c', 'fix the bug'], 'abc', 'fix the bug'),
    { cmd: '/bin/claude', args: ['--model', 'opus', '--resume', 'abc'] });
  assert.deepEqual(resumeCommand('claude', ['/bin/claude', '--resume', 'old', '--permission-mode', 'plan'], 'abc'),
    { cmd: '/bin/claude', args: ['--permission-mode', 'plan', '--resume', 'abc'] });
  assert.deepEqual(resumeCommand('codex', ['/bin/codex', 'resume', 'old', '--yolo'], 'abc'),
    { cmd: '/bin/codex', args: ['resume', 'abc', '--yolo'] });
});

test('claude -c or --resume in the old window joins the shared terminal instead of starting another', () => {
  const open = [{ id: 'native-a', engine: 'claude', configHome: '/h', cwd: '/w', conversation: 'abc', createdAt: 1 },
    { id: 'native-b', engine: 'claude', configHome: '/h', cwd: '/w', conversation: null, createdAt: 2 }];
  assert.equal(sharedConversation(open, 'claude', '/h', ['--resume', 'abc'], '/w').id, 'native-a');
  assert.equal(sharedConversation(open, 'claude', '/h', ['-c'], '/w').id, 'native-b');
  assert.equal(sharedConversation(open, 'claude', '/other', ['-c'], '/w'), null, 'another account is another conversation');
  assert.equal(sharedConversation(open, 'claude', '/h', [], '/w'), null);
});

test('take over waits for the running step, then moves the same CLI into a shared terminal and carries on', { skip: !pty && 'no pty' }, async (t) => {
  // The CLI the owner started from their shell before Helm, mid-task. The
  // shell keeps the window open after the CLI leaves, as a real one does.
  const window = pty.spawn('/bin/sh', ['-c', `'${fake}' --model opus 'first prompt'; echo SHELL-BACK; sleep 60`], { cwd: work, cols: 100, rows: 30,
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, HELM_NATIVE_SESSION: '', HELM_SESSION_ID: '' } });
  t.after(() => { try { window.kill(); } catch {} });
  let screen = ''; window.onData((d) => { screen += d; });
  await until(() => /PID=\d+/.test(screen));
  const original = Number(screen.match(/PID=(\d+)/)[1]);

  class Runtime extends EventEmitter { async listLive() { return new Map(); } watch() {} }
  const host = new TerminalHost({ socketPath: NATIVE_SOCKET_PATH, unit: 'helm-native-test' });
  const sessions = new Sessions(new Runtime(), { nativeHost: host, nativeDiscovery: false, makeDriver: () => ({ start() {}, kill() {}, on() {} }) });
  t.after(() => sessions.stop());
  const updates = []; sessions.on('session', (s) => updates.push(s));
  const external = await sessions.resumeExternal({ engine: 'claude', account: 'claude', id: conversation, cwd: work });
  assert.equal(external.externalActive, true);

  assert.deepEqual(await sessions.takeOver(external.id), { waiting: true });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(screen.includes('moved to Helm'), false, 'never cut off mid-step');
  assert.ok(updates.some((u) => u.id === external.id && u.takeover === 'waiting'));
  // The step finishes: its result lands in the conversation.
  appendFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }) + '\n');

  const moved = await until(() => updates.find((u) => u.id === external.id && u.movedTo)?.movedTo, 20000);
  await until(() => screen.includes('moved to Helm'));
  assert.match(screen, /claude -c/);
  assert.throws(() => process.kill(original, 0), 'the old copy has closed');
  const next = sessions.get(moved.id);
  assert.equal(next.nativeCli, true);
  assert.equal(next.engineSessionId, conversation);
  let shared = (await sessions.attach(moved.id)).text;
  sessions.on('data', (d) => { if (d.id === moved.id) shared += d.text; });
  await until(() => shared.includes('GOT=continue'), 20000);
  const args = JSON.parse(shared.match(/ARGS=(\[[^\]]*\])/)[1]);
  assert.deepEqual(args, ['--model', 'opus', '--resume', conversation]);
  assert.match(shared, new RegExp(`ACCOUNT=${home}`));
  assert.throws(() => sessions.get(external.id), 'the old monitor row is gone');
});
