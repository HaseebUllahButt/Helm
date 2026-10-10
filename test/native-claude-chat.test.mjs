import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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


test('native images are stored on the thread host and referenced in the same serialized prompt', async () => {
  const host = new Host(), sessions = create(host);
  const data = 'iVBORw0KGgo=';
  try {
    await sessions.hooks;
    await Promise.all([
      sessions.input('native-test', 'look at [Image #1]', { attachments: [{ filename: '../../remote.png', mime: 'image/png', data }] }),
      sessions.input('native-test', '' , { attachments: [{ filename: 'second.jpg', mime: 'image/jpeg', data }] }),
    ]);
    assert.equal(host.writes.length, 4);
    for (const index of [0, 2]) {
      const path = JSON.parse(host.writes[index].match(/\[Image #1\]: ("[^\n]+")/)[1]);
      assert.ok(path.startsWith(join(process.env.HELM_DIR, 'native-images')));
      assert.deepEqual(readFileSync(path), Buffer.from(data, 'base64'));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(host.writes[index + 1], '\r');
    }
    assert.match(host.writes[0], /look at \[Image #1\]/);
    assert.match(host.writes[2], /Read the attached image files/);
    const transcript = join(root, 'native-images.jsonl');
    const prompt = host.writes[0].slice('\x1b[200~'.length, -'\x1b[201~'.length);
    writeFileSync(transcript, JSON.stringify({type:'user',message:{role:'user',content:prompt},timestamp:new Date().toISOString()})+'\n');
    sessions.get('native-test').transcript = transcript;
    const history = await sessions.messages('native-test');
    assert.equal(history.messages[0].text, 'look at [Image #1]');
    assert.equal(history.messages[0].attachments[0].data, data);

  } finally { await sessions.stop(); }
});

test('invalid native images fail before any terminal input', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    await assert.rejects(sessions.input('native-test', 'look', { attachments: [{ mime: 'image/png', data: 'bad!' }] }), /valid base64/);
    await assert.rejects(sessions.input('native-test', 'look', { attachments: [{ mime: 'image/svg+xml', data: 'aGk=' }] }), /JPEG, PNG/);
    assert.deepEqual(host.writes, []);
  } finally { await sessions.stop(); }
});

test('native controls and slash commands share the live terminal without claiming settings were accepted', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    const original = { model: sessions.get('native-test').model, effort: sessions.get('native-test').effort };
    const results = await Promise.all([
      sessions.setModel('native-test', 'claude-opus-5-5[1m]'),
      sessions.setEffort('native-test', 'high'),
      sessions.input('native-test', '/permissions'),
    ]);
    assert.ok(results.every(result => result.terminal === true));
    assert.deepEqual(host.writes, [
      '\x1b[200~/model claude-opus-5-5[1m]\x1b[201~', '\r',
      '\x1b[200~/effort high\x1b[201~', '\r',
      '\x1b[200~/permissions\x1b[201~', '\r',
    ]);
    assert.deepEqual({ model: sessions.get('native-test').model, effort: sessions.get('native-test').effort }, original);
    assert.ok((await sessions.commands('native-test')).some(command => command.name === 'model'));
    assert.equal(sessions.get('native-test').driver, undefined);
  } finally { await sessions.stop(); }
});

test('invalid native controls and slash commands with images never write to the terminal', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    for (const model of ['opus\n/clear', 'opus\x1b[201~', {}, ' opus']) {
      await assert.rejects(sessions.setModel('native-test', model), /invalid Claude model/);
    }
    await assert.rejects(sessions.setEffort('native-test', 'high\n/clear'), /invalid Claude thinking effort/);
    await assert.rejects(sessions.input('native-test', '/model', { attachments: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }] }), /without images/);
    assert.deepEqual(host.writes, []);
  } finally { await sessions.stop(); }
});

test('a pending native approval blocks settings as well as ordinary messages', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    const waiting = sendHook('native-test', { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {} });
    await until(() => sessions.events.pending('native-test').length === 1);
    await assert.rejects(sessions.setModel('native-test', 'opus'), /question first/);
    await assert.rejects(sessions.setEffort('native-test', 'low'), /question first/);
    assert.deepEqual(host.writes, []);
    host.emit('exit', { id: 'native-test', code: 0 });
    await waiting;
  } finally { await sessions.stop(); }
});

test('native commands fail when the original process is gone', async () => {
  const host = new Host(); host.has = () => false;
  const sessions = create(host);
  try {
    await sessions.hooks;
    await assert.rejects(sessions.setModel('native-test', 'opus'), /no longer running/);
    assert.deepEqual(host.writes, []);
  } finally { await sessions.stop(); }
});

test('Claude model hooks update the reported setting only after the provider switches', async () => {
  const sessions = create();
  try {
    await sessions.hooks;
    await sendHook('native-test', { hook_event_name: 'SessionStart', model: 'claude-opus-5-5' });
    assert.equal(sessions.get('native-test').engineModel, 'claude-opus-5-5');
    await sessions.setModel('native-test', 'sonnet');
    assert.equal(sessions.get('native-test').engineModel, 'claude-opus-5-5');
    await sendHook('native-test', { hook_event_name: 'PostModelSwitch', to_model: 'claude-sonnet-5', source: 'command' });
    assert.equal(sessions.get('native-test').engineModel, 'claude-sonnet-5');
    assert.equal(sessions.get('native-test').model, null);
    assert.equal(sessions.get('native-test').status, 'idle');
  } finally { await sessions.stop(); }
});

test("a terminal Claude's own busy/idle word fixes what hooks miss, never a newer hook", async (t) => {
  // Stop does not run when a turn is interrupted, and nothing marks a turn
  // Claude starts by itself. Claude's session file says both.
  const { spawn } = await import('node:child_process');
  const home = join(root, 'claude-home');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const fake = spawn('bash', ['-c', 'exec -a claude sleep 30'], { cwd: root, stdio: 'ignore' });
  t.after(() => fake.kill());
  await until(() => { try { return readFileSync(`/proc/${fake.pid}/cmdline`, 'utf8').startsWith('claude\0'); } catch { return false; } });
  const say = (status, statusUpdatedAt) => writeFileSync(join(home, 'sessions', `${fake.pid}.json`), JSON.stringify({
    pid: fake.pid, sessionId: 'conv-live', cwd: root, kind: 'interactive', status, statusUpdatedAt }));
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    Object.assign(sessions.get('native-test'), { nativeHome: home, nativePid: process.pid, engineSessionId: 'conv-live' });
    // An older file never undoes a fresh hook.
    say('idle', Date.now() - 60_000);
    await sendHook('native-test', { hook_event_name: 'UserPromptSubmit' });
    assert.equal(sessions.get('native-test').status, 'working');
    await new Promise((r) => setTimeout(r, 2700));
    assert.equal(sessions.get('native-test').status, 'working');
    // Interrupted at the keyboard: no Stop hook, but Claude writes idle.
    say('idle', Date.now() + 1);
    await until(() => sessions.get('native-test').status === 'idle');
    // A turn Claude starts by itself.
    say('busy', Date.now() + 1);
    await until(() => sessions.get('native-test').status === 'working');
  } finally { await sessions.stop(); }
});
