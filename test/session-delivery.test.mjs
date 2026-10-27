import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-delivery-identity-'));
Object.assign(process.env, { HELM_DIR: root, HELM_NO_SERVICE: '1', XDG_STATE_HOME: join(root, 'state') });
test.after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, 'profiles.json'), JSON.stringify({ version: 1,
  profiles: [{ id: 'fake', engine: 'claude', cmd: 'claude', env: {}, source: 'alias' }] }));
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { EventLog } = await import('../packages/connect/src/events.js');
const { InputDelivery } = await import('../packages/connect/src/input-delivery.js');
class Runtime extends EventEmitter {
  async listLive() { return new Map(); }
  async read() { return { text: '' }; }
  watch() {}
}
class Driver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.status = 'idle'; this.pending = new Map(); this.engineSessionId = 'fake'; }
  async start() {}
  async send(text) {
    this.emit('event', { type: 'turn.start', turnId: 'native', text });
    this.status = 'working'; this.emit('event', { type: 'status', status: 'working' });
  }
  async kill() {}
  async suspend() {}
}
test('durable sends keep their identities in queued history and across a restart', async t => {
  const folder = join(root, 'events');
  const options = () => ({ events: new EventLog(folder), makeDriver: (_engine, opts) => new Driver(opts) });
  const original = new Sessions(new Runtime(), options()); t.after(() => original.stop());
  const session = await original.start({ cwd: root, profileId: 'fake' });
  const inbox = new InputDelivery(original, { dir: join(root, 'inbox') });
  const first = { id: session.id, data: 'same words', messageId: 'a'.repeat(32) };
  const second = { ...first, messageId: 'b'.repeat(32), delivery: 'queue' };
  await inbox.deliver(first, 'device-one'); await inbox.deliver(second, 'device-two');
  const starts = () => original.history(session.id).events.filter(e => e.type === 'turn.start' && e.messageId);
  assert.deepEqual(starts().map(e => e.messageId), [first.messageId, second.messageId]);
  assert.equal(starts()[1].queued, true);
  const queuedId = starts()[1].turnId;
  await original.stop();
  const restarted = new Sessions(new Runtime(), options()); t.after(() => restarted.stop()); await restarted.resume();
  const restored = restarted.history(session.id).events.filter(e => e.type === 'turn.start' && e.messageId);
  assert.deepEqual(restored.map(e => e.messageId), [first.messageId, second.messageId]);
  const replay = new InputDelivery(restarted, { dir: join(root, 'inbox') }); await replay.deliver(second, 'device-two');
  assert.equal(restarted.history(session.id).events.filter(e => e.type === 'turn.start' && e.turnId === queuedId).length, 1);
});
