import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A headless agent session, end to end inside the daemon: starting one goes
// to a driver, its events land in the log with sequence numbers, pushes flow
// only while watched, a pending prompt survives the driver, and a kill
// removes everything.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-session-driver-'));
process.env.HELM_NO_SERVICE = '1';

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}

/** A driver that does what it is told and reports it, without any CLI. */
class FakeDriver extends EventEmitter {
  static made = [];
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.status = 'idle';
    this.engineSessionId = opts.engineSessionId ?? 'engine-1';
    this.pending = new Map();
    FakeDriver.made.push(this);
  }
  push(type, payload) {
    if (type === 'status') this.status = payload.status;
    this.emit('event', { type, ...payload });
  }
  async start() { this.started = true; }
  async send(text) {
    this.sent = (this.sent ?? []).concat(text);
    this.push('status', { status: 'working' });
    this.push('turn.start', { turnId: 't1', text });
    this.push('item.start', { id: 'i1', kind: 'text', turnId: 't1' });
    this.push('item.delta', { id: 'i1', text: 'hello' });
  }
  ask() {
    this.push('status', { status: 'blocked' });
    this.push('permission.request', { requestId: 'r1', kind: 'command', title: 'Run a command', options: [] });
    this.pending.set('r1', {});
  }
  async answer(requestId, decision) {
    this.answered = { requestId, decision };
    this.pending.delete(requestId);
    this.push('permission.resolved', { requestId, decision: decision.option });
    this.push('status', { status: 'working' });
  }
  async interrupt() { this.interrupted = true; }
  async setMode(m) { this.mode = m; }
  async setModel(m) { this.model = m; }
  async kill() { this.killed = true; this.push('status', { status: 'exited' }); }
}

test('a headless session: start, stream, watch, prompt, resume, kill', async (t) => {
  t.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
  // A profile for the fake to be started from.
  writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
    version: 1,
    profiles: [{ id: 'claudea', label: 'Claude · personal', engine: 'claude', cmd: 'claude', args: ['--model', 'x'], env: { CLAUDE_CONFIG_DIR: '~/.claude-personal' }, source: 'alias' }],
  }));
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const events = new EventLog(join(process.env.HELM_DIR, 'events'));
  const sessions = new Sessions(new StubRuntime(), { events, makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }) });

  const updates = [];
  const pushed = [];
  sessions.on('session', (s) => updates.push(s.status));
  sessions.on('event', (e) => pushed.push(e));

  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea', mode: 'acceptEdits', model: 'opus', effort: 'high' });
  assert.equal(s.driver, 'claude');
  assert.equal(s.mode, 'acceptEdits');
  assert.equal(s.engineSessionId, 'engine-1');
  const d = FakeDriver.made.at(-1);
  assert.equal(d.cmd, 'claude');
  assert.deepEqual(d.args, ['--model', 'x']);
  assert.ok(d.env.CLAUDE_CONFIG_DIR.endsWith('/.claude-personal'), 'the account home is passed through');
  assert.equal(d.model, 'opus');
  assert.ok(d.started);

  const listed = (await sessions.list()).find((x) => x.id === s.id);
  assert.equal(listed.alive, true);
  assert.equal(listed.pending, 0);

  await sessions.input(s.id, 'hi\n');
  assert.deepEqual(d.sent, ['hi']);
  const h = sessions.history(s.id);
  assert.deepEqual(h.events.map((e) => e.type), ['status', 'turn.start', 'item.start', 'item.delta']);
  assert.deepEqual(h.events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(sessions.history(s.id, { since: 3 }).events.length, 1);
  assert.equal(pushed.length, 4, 'every event reaches the daemon; the daemon decides who gets it');
  assert.ok(updates.includes('working'));

  // A prompt: the session is blocked, the prompt is pending, and answering it clears it.
  d.ask();
  assert.equal((await sessions.list()).find((x) => x.id === s.id).status, 'blocked');
  assert.equal(sessions.history(s.id).pending.length, 1);
  assert.equal(sessions.history(s.id).pending[0].requestId, 'r1');
  await sessions.answer(s.id, 'r1', { option: 'allow' });
  assert.deepEqual(d.answered, { requestId: 'r1', decision: { option: 'allow' } });
  assert.equal(sessions.history(s.id).pending.length, 0);

  // Watching has a TTL.
  assert.equal(sessions.watching(s.id), false);
  sessions.watch(s.id);
  assert.equal(sessions.watching(s.id), true);
  sessions.unwatch(s.id);
  assert.equal(sessions.watching(s.id), false);

  // Mode and model changes reach the driver and the record.
  await sessions.setMode(s.id, 'plan');
  await sessions.setModel(s.id, 'sonnet');
  assert.equal(d.mode, 'plan');
  assert.equal(d.model, 'sonnet');
  assert.equal(sessions.get(s.id).mode, 'plan');

  // The process going away is not the end of the session: the next message resumes it.
  d.push('status', { status: 'idle' });
  d.push('status', { status: 'exited' });
  assert.equal(sessions.get(s.id).status, 'idle');
  assert.equal((await sessions.list()).find((x) => x.id === s.id).alive, false);
  await sessions.input(s.id, 'again');
  const d2 = FakeDriver.made.at(-1);
  assert.notEqual(d2, d);
  assert.equal(d2.engineSessionId, 'engine-1', 'resumed with the same engine session');
  assert.equal(d2.mode, 'plan');

  // Kill removes the record and the log.
  await sessions.kill(s.id);
  assert.ok(d2.killed);
  assert.throws(() => sessions.get(s.id), /unknown session/);
  assert.equal(events.since(s.id, 0).length, 0);
});

test('a daemon restart lists a driven session as idle and resumable', async (t) => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const sessions = new Sessions(new StubRuntime(), { makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }) });
  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea' });
  const again = new Sessions(new StubRuntime(), { makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }) });
  again.resume();
  const listed = (await again.list()).find((x) => x.id === s.id);
  assert.equal(listed.alive, false);
  assert.equal(listed.status, 'idle');
  assert.equal(listed.mode, 'default');
  t.after(() => again.kill(s.id));
});
