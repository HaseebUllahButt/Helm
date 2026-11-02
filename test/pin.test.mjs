import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-pin-'));
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

test('a pinned chat stays pinned on every device and across a restart', async (t) => {
  const sessions = open();
  const chat = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  t.after(() => sessions.stop());
  const told = [];
  sessions.on('session', (s) => told.push(s));

  const { session } = sessions.pin(chat.id);
  assert.ok(session.pinnedAt > 0);
  assert.equal(told.at(-1).pinnedAt, session.pinnedAt, 'every device is told');
  assert.equal(told.at(-1).updatedAt, chat.updatedAt, 'a pin does not make the chat newer');

  const again = open();
  t.after(() => again.stop());
  assert.equal(again.get(chat.id).pinnedAt, session.pinnedAt, 'kept across a Helm restart');

  assert.equal(sessions.pin(chat.id, false).session.pinnedAt, null);
  assert.throws(() => sessions.pin('found:codex:abc'), /cannot pin/);
  assert.throws(() => sessions.pin('nope'), /unknown session/);
});
