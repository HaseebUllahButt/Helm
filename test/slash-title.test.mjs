import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A slash command is a verb for the CLI, not a description of the work: it
// must reach the driver but never count as a prompt the thread is titled
// from. And a driver's own settings event - an ACP agent switching its mode
// behind helm's back - lands on the session record like a composer pick.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-slash-title-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [{ id: 'devina', label: 'Devin', engine: 'devin', cmd: 'devin', args: [], env: {}, source: 'alias' }],
}));

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}

class FakeDriver extends EventEmitter {
  static made = [];
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.status = 'idle';
    this.pending = new Map();
    FakeDriver.made.push(this);
  }
  push(type, payload) { this.emit('event', { type, ...payload }); }
  async start() { this.started = true; }
  async send(text) { this.sent = (this.sent ?? []).concat(text); }
  async compact(hint) { this.compacted = hint ?? ''; }
  async kill() { this.push('status', { status: 'exited' }); }
}

const { Sessions } = await import('../packages/connect/src/sessions.js');
const { EventLog } = await import('../packages/connect/src/events.js');
const events = new EventLog(join(process.env.HELM_DIR, 'events'));
const sessions = new Sessions(new StubRuntime(), { events, makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }) });

test('slash input goes to the driver and prompts stay at zero', async () => {
  const s = await sessions.start({ cwd: '/tmp', profileId: 'devina' });
  const d = FakeDriver.made.at(-1);
  await sessions.input(s.id, '/status');
  await sessions.input(s.id, '/code fix the flaky test');
  await sessions.input(s.id, '/compact');
  assert.deepEqual(d.sent, ['/status', '/code fix the flaky test']);
  assert.equal(d.compacted, '', 'helm-owned /compact is intercepted, not sent');
  assert.equal(sessions.get(s.id).prompts ?? 0, 0, 'slash commands are not prompts about the work');

  await sessions.input(s.id, 'fix the flaky login test');
  assert.equal(sessions.get(s.id).prompts, 1, 'a real prompt still counts');
  await sessions.kill(s.id);
});

test('a driver settings event lands on the session record', async () => {
  const s = await sessions.start({ cwd: '/tmp', profileId: 'devina' });
  const d = FakeDriver.made.at(-1);
  d.push('settings', { mode: 'read', model: 'swe-2-fast' });
  const rec = sessions.get(s.id);
  assert.equal(rec.mode, 'read');
  assert.equal(rec.model, 'swe-2-fast');
  // Keys the event did not carry are left alone.
  assert.equal(rec.effort, null);
  await sessions.kill(s.id);
});
