import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-channel-test-'));
process.env.HELM_DIR = root;
process.env.HELM_NATIVE_SOCKET = join(root, 'native.sock');
const { runClaudeChannel, claudeChannelRpc, claudeChannelSocket } = await import('../packages/connect/src/claude-channel.js');
const id = 'native-1122334455667788';
test.after(() => rmSync(root, { recursive: true, force: true }));

test('native Claude messages and permission answers travel over MCP without terminal input', async t => {
  const input = new PassThrough(), output = new PassThrough();
  let raw = ''; output.on('data', chunk => raw += chunk);
  const channel = await runClaudeChannel(id, { input, output });
  t.after(() => { channel.close(); input.destroy(); output.destroy(); });
  assert.equal(statSync(claudeChannelSocket(id)).mode & 0o777, 0o600);
  await assert.rejects(claudeChannelRpc(id, 'send', { text: 'hello' }), /still connecting/);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal((await claudeChannelRpc(id, 'status')).initialized, true);
  assert.equal(await runClaudeChannel(id, { input, output }).then(() => false, e => e.message), 'channel already running');
  await claudeChannelRpc(id, 'send', { text: 'hello\nfrom Helm' });
  const messages = () => raw.trim().split('\n').map(line => JSON.parse(line));
  const sent = messages().find(m => m.method === 'notifications/claude/channel');
  assert.deepEqual(sent.params, { content: 'hello\nfrom Helm', meta: { surface: 'helm', sender: 'owner' } });
  input.write(JSON.stringify({ method: 'notifications/claude/channel/permission_request', params: {
    request_id: 'abcde', tool_name: 'Bash', description: 'Print demo', input_preview: 'echo demo',
  } }) + '\n');
  assert.equal((await claudeChannelRpc(id, 'status')).permissions[0].request_id, 'abcde');
  await assert.rejects(claudeChannelRpc(id, 'answer', { requestId: 'wrong', behavior: 'allow' }), /already closed/);
  await assert.rejects(claudeChannelRpc(id, 'answer', { requestId: 'abcde', behavior: 'always' }), /allow or deny/);
  await claudeChannelRpc(id, 'answer', { requestId: 'abcde', behavior: 'deny' });
  assert.deepEqual(messages().find(m => m.method === 'notifications/claude/channel/permission').params, { request_id: 'abcde', behavior: 'deny' });
  assert.equal((await claudeChannelRpc(id, 'status')).permissions.length, 0);
  await assert.rejects(claudeChannelRpc(id, 'answer', { requestId: 'abcde', behavior: 'allow' }), /already closed/);
  assert.throws(() => claudeChannelSocket('../other'), /invalid native/);
});

test('the Helm chat preserves channel messages and approvals across a daemon restart', async t => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const sessionId = 'native-aabbccddeeff0011';
  const input = new PassThrough(), output = new PassThrough();
  let raw = ''; output.on('data', chunk => raw += chunk);
  const channel = await runClaudeChannel(sessionId, { input, output });
  t.after(() => { channel.close(); input.destroy(); output.destroy(); });
  input.write(JSON.stringify({ method: 'notifications/initialized' }) + '\n');
  class Host extends EventEmitter {
    nativeSessions() { return [{ id: sessionId, engine: 'claude', cwd: root, nativeChat: true, nativePid: 123, createdAt: Date.now() }]; }
    has() { return true; }
    async ensure() {}
    async close() {}
    write() { throw new Error('chat must not write to the terminal'); }
  }
  const host = new Host(), runtime = new EventEmitter();
  const first = new Sessions(runtime, { nativeHost: host, nativeDiscovery: false });
  t.after(() => first.stop());
  await first.input(sessionId, 'Hello through Helm\n');
  assert.equal((await first.messages(sessionId)).messages[0].text, 'Hello through Helm');
  await assert.rejects(first.input(sessionId, '/clear'), /slash commands/);
  await first.stop();
  const second = new Sessions(new EventEmitter(), { nativeHost: host, nativeDiscovery: false });
  t.after(() => second.stop());
  assert.equal((await second.messages(sessionId)).messages[0].text, 'Hello through Helm');
  const transcript = join(root, 'conversation.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() + 1000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Reply in the same conversation' }] } }) + '\n');
  second.get(sessionId).transcript = transcript;
  assert.deepEqual((await second.messages(sessionId)).messages.map(m => m.text), ['Hello through Helm', 'Reply in the same conversation']);
  input.write(JSON.stringify({ method: 'notifications/claude/channel/permission_request', params: {
    request_id: 'abcde', tool_name: 'Bash', description: 'Print demo', input_preview: 'echo demo',
  } }) + '\n');
  await second.messages(sessionId);
  assert.equal(second.events.pending(sessionId)[0].requestId, 'abcde');
  await second.answer(sessionId, 'abcde', { option: 'allow' });
  assert.equal(second.events.pending(sessionId).length, 0);
  assert.ok(raw.includes('notifications/claude/channel/permission'));
});
