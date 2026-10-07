import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-native-conversation-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NATIVE_SOCKET = join(root, 'native.sock');
process.env.HELM_NO_SERVICE = '1';
const home = join(root, 'claude');
const project = join(home, 'projects', 'test');
mkdirSync(process.env.HELM_DIR);
mkdirSync(project, { recursive: true });
mkdirSync(join(home, 'sessions'));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'claude', engine: 'claude', cmd: 'claude', args: [], env: { CLAUDE_CONFIG_DIR: home }, source: 'custom' },
] }));
const { processStart } = await import('../packages/connect/src/procinfo.js');
const { dedupeNativeConversations } = await import('../packages/connect/src/external-process.js');
const { Sessions } = await import('../packages/connect/src/sessions.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('native dedupe keeps the terminal with a pending question and separates accounts', () => {
  const base = { engine: 'claude', engineSessionId: 'same', profileId: 'one', nativeCli: true, alive: true };
  const older = { ...base, id: 'older', pending: 1, status: 'blocked', createdAt: 1 };
  const newer = { ...base, id: 'newer', status: 'working', createdAt: 2 };
  const otherAccount = { ...newer, id: 'other', profileId: 'two' };
  assert.deepEqual(dedupeNativeConversations([newer, older, otherAccount]), [older, otherAccount]);
  assert.deepEqual(dedupeNativeConversations([{ ...older, alive: false }, newer]), [newer]);
});

test('two native Claude terminals on one transcript use their own status and show one row', async (t) => {
  const children = [];
  const records = [];
  const metas = [];
  for (const [i, conversation, status] of [[0, 'shared', 'idle'], [1, 'shared', 'busy'], [2, 'separate', 'busy']]) {
    writeFileSync(join(project, `${conversation}.jsonl`), [
      { type: 'user', uuid: 'u', cwd: root, message: { content: 'identical title' } },
      { type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'done' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
      { argv0: 'claude', cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    await once(child.stdout, 'data');
    const rec = { pid: child.pid, sessionId: conversation, cwd: root, kind: 'interactive', procStart: processStart(child.pid), status };
    records.push(rec);
    writeFileSync(join(home, 'sessions', `${child.pid}.json`), JSON.stringify(rec));
    metas.push({ id: `native-${i}`, engine: 'claude', cwd: root, configHome: home, nativePid: child.pid,
      nativeChat: true, conversation: i === 2 ? 'shared' : conversation, createdAt: i + 1 });
  }
  class Host extends EventEmitter {
    nativeSessions() { return metas; }
    has(id) { return metas.some(s => s.id === id); }
    async ensure() { return true; }
    async renew() {}
    detach() {}
  }
  class Runtime extends EventEmitter { async listLive() { return new Map(); } }
  const sessions = new Sessions(new Runtime(), { nativeHost: new Host(), nativeDiscovery: false });
  try {
    await sessions.hooks;
    const listed = await sessions.list({ includeDetected: true });
    assert.equal(sessions.get('native-0').status, 'idle', 'busy sibling does not make this process busy');
    assert.equal(sessions.get('native-1').status, 'working');
    assert.deepEqual(listed.filter(s => s.engineSessionId === 'shared').map(s => s.id), ['native-1']);
    assert.equal(listed.find(s => s.id === 'native-2').engineSessionId, 'separate', 'process ownership corrects a stale conversation ID');
    assert.equal(listed.filter(s => s.nativeCli).length, 2, 'different conversations with the same title and cwd stay separate');
    for (const child of children) assert.doesNotThrow(() => process.kill(child.pid, 0), 'dedupe preserves both terminal processes');

    records[0].status = 'waiting';
    writeFileSync(join(home, 'sessions', `${children[0].pid}.json`), JSON.stringify(records[0]));
    const waiting = await sessions.list();
    assert.equal(waiting.find(s => s.engineSessionId === 'shared').id, 'native-0', 'permission terminal takes priority');
    assert.equal(waiting.find(s => s.id === 'native-0').status, 'blocked');
  } finally { await sessions.stop(); }
});
