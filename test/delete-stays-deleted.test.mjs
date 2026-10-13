import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-delete-'));
const claudeHome = join(root, 'claude-home');
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_PROCS_SOCKET = join(root, 'procs.sock');
process.env.HELM_TERMINALS_SOCKET = join(root, 'terminals.sock');
process.env.HELM_NATIVE_SOCKET = join(root, 'native.sock');
mkdirSync(process.env.HELM_DIR, { recursive: true });
test.after(() => rmSync(root, { recursive: true, force: true }));
// A real project folder: chats under /tmp or Helm's own folders are never listed.
const project = process.cwd();
const sid = '22222222-3333-4444-8555-666666666666';
const transcript = join(claudeHome, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`);
mkdirSync(join(transcript, '..'), { recursive: true });
writeFileSync(transcript, [
  JSON.stringify({ type: 'user', uuid: 'u1', cwd: project, sessionId: sid, timestamp: new Date(Date.now() - 600_000).toISOString(), message: { role: 'user', content: 'tidy the readme' } }),
  JSON.stringify({ type: 'assistant', uuid: 'a1', cwd: project, sessionId: sid, timestamp: new Date(Date.now() - 600_000).toISOString(), message: { id: 'a1', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'done' }] } }),
].join('\n') + '\n');
const old = (Date.now() - 600_000) / 1000;
utimesSync(transcript, old, old);
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'claude', label: 'Claude', engine: 'claude', cmd: process.execPath, env: { CLAUDE_CONFIG_DIR: claudeHome }, source: 'custom' },
] }));
const { Sessions } = await import('../packages/connect/src/sessions.js');

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = sid; this.status = 'idle'; }
  async start() {}
  async kill() { this.emit('event', { type: 'status', status: 'exited' }); }
}

test('a deleted chat does not come back as one the CLI remembers', async (t) => {
  const runtime = new EventEmitter();
  runtime.listLive = async () => new Map();
  const sessions = new Sessions(runtime, { makeDriver: (_e, opts) => new FakeDriver(opts) });
  t.after(() => sessions.stop());
  const chat = await sessions.start({ cwd: project, profileId: 'claude' });
  const ids = async () => (await sessions.list({ includeDetected: true })).map((s) => s.id);
  assert.ok((await ids()).includes(chat.id));
  assert.ok(!(await ids()).includes(`found:claude:${sid}`), 'Helm\'s own chat is listed once');

  await sessions.kill(chat.id);
  const after = await ids();
  assert.ok(!after.includes(chat.id));
  assert.ok(!after.includes(`found:claude:${sid}`), 'the CLI\'s copy is not listed in its place');

  // Picked up again in a terminal later, it is the owner's again.
  const now = Date.now() / 1000 + 120;
  utimesSync(transcript, now, now);
  writeFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'u2', cwd: project, sessionId: sid, timestamp: new Date(Date.now() + 120_000).toISOString(), message: { role: 'user', content: 'one more thing' } }) + '\n', { flag: 'a' });
  utimesSync(transcript, now, now);
  assert.ok((await ids()).includes(`found:claude:${sid}`));
});
