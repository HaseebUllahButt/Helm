import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-native-chat-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NATIVE_SOCKET = join(root, 'native.sock');
process.env.HELM_NO_SERVICE = '1';
mkdirSync(process.env.HELM_DIR);
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { sendHook } = await import('../packages/connect/src/claude-hooks.js');

class Host extends EventEmitter {
  writes = [];
  renewals = [];
  nativeSessions() { return [{ id: 'native-test', engine: 'claude', nativeChat: true, cwd: root, createdAt: 1 }]; }
  has() { return true; }
  async write(id, text) { this.writes.push(text); }
  async renew(id) { this.renewals.push(id); }
  detach() {}
}
const create = (host = new Host()) => new Sessions(new EventEmitter(), { nativeHost: host, nativeDiscovery: false });
async function until(fn) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timed out');
}
test.after(() => rmSync(root, { recursive: true, force: true }));

test('two app messages keep their paste and submit paired', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    await Promise.all([sessions.input('native-test', 'first'), sessions.input('native-test', 'second')]);
    assert.deepEqual(host.writes, ['\x1b[200~first\x1b[201~', '\r', '\x1b[200~second\x1b[201~', '\r']);
  } finally { await sessions.stop(); }
});

test('watching native chat renews its terminal lease; a blocked chat keeps it after the viewer leaves', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    sessions.watch('native-test', 'phone');
    assert.deepEqual(host.renewals, ['native-test']);
    sessions.unwatch('native-test', 'phone');
    sessions.get('native-test').status = 'blocked';
    await until(() => host.renewals.length > 1);
  } finally { await sessions.stop(); }
});

test('native question answers round trip, block messages, and disappear when the process exits', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    const waiting = sendHook('native-test', { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which color?', options: [{ label: 'Blue' }] }] } });
    await until(() => sessions.events.pending('native-test').length === 1);
    assert.equal(sessions.get('native-test').status, 'blocked');
    await assert.rejects(sessions.input('native-test', 'do not press Enter'), /question first/);
    const request = sessions.events.pending('native-test')[0];
    await sessions.answer('native-test', request.requestId, { option: 'allow', answers: { 'Which color?': 'Blue' } });
    const output = await waiting;
    assert.deepEqual(output.hookSpecificOutput.decision.updatedInput.answers, { 'Which color?': 'Blue' });
    assert.equal(sessions.events.pending('native-test').length, 0);
    const next = sendHook('native-test', { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/tmp/test' } });
    await until(() => sessions.events.pending('native-test').length === 1);
    host.emit('exit', { id: 'native-test', code: 0 });
    assert.equal(await next, null);
    assert.equal(sessions.events.pending('native-test').length, 0);
  } finally { await sessions.stop(); }
});

test('a restart clears an orphaned native approval card', async () => {
  const first = create();
  await first.hooks;
  first.events.append('native-test', { type: 'permission.request', requestId: 'orphan', title: 'Old question' });
  await first.stop();
  const second = create();
  try {
    await second.hooks;
    assert.equal(second.events.pending('native-test').length, 0);
  } finally { await second.stop(); }
});
