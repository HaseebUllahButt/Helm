import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-seen-'));
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
process.env.HELM_DB = join(process.env.HELM_DIR, 'hub.sqlite');
process.env.HELM_PROCS_SOCKET = join(process.env.HELM_DIR, 'procs.sock');
process.env.HELM_TERMINALS_SOCKET = join(process.env.HELM_DIR, 'terminals.sock');
process.env.HELM_NATIVE_SOCKET = join(process.env.HELM_DIR, 'native.sock');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'codex-main', label: 'Codex', engine: 'codex', cmd: process.execPath, source: 'custom' },
] }));
const { Sessions } = await import('../packages/connect/src/sessions.js');

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = randomUUID(); this.status = 'idle'; }
  async start() {}
  async kill() { this.emit('event', { type: 'status', status: 'exited' }); }
}
const open = () => {
  const runtime = new EventEmitter();
  runtime.listLive = async () => new Map();
  return new Sessions(runtime, { makeDriver: (_engine, opts) => new FakeDriver(opts) });
};

test('a chat opened on one device is seen on all of them, and the machine remembers it', async (t) => {
  const sessions = open();
  const chat = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  t.after(() => sessions.stop());
  const told = [];
  sessions.on('session', (s) => told.push(s));

  const { seenAt } = sessions.markSeen(chat.id);
  assert.ok(seenAt >= chat.updatedAt);
  assert.equal(told.at(-1).seenAt, seenAt, 'every device is told');
  assert.equal(told.at(-1).updatedAt, chat.updatedAt, 'looking at a chat does not make it newer');

  // A chat the CLI started itself has no record of Helm's to write on.
  sessions.markSeen('found:codex:abc');
  assert.equal(told.at(-1).id, 'found:codex:abc');
  assert.throws(() => sessions.markSeen('nope'), /unknown session/);

  const again = open();
  t.after(() => again.stop());
  assert.equal(again.get(chat.id).seenAt, seenAt, 'kept across a Helm restart');
});
