import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A note the owner adds to an approval reaches the agent once: with Claude's
// decline, or else as the owner's next message after the answer was taken.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-approval-note-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [
    { id: 'claudea', engine: 'claude', cmd: 'claude', source: 'alias' },
    { id: 'devin', engine: 'devin', cmd: 'devin', source: 'alias' },
  ],
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
    this.engineSessionId = 'engine-1';
    this.pending = new Map();
    this.sent = [];
    FakeDriver.made.push(this);
  }
  push(type, payload) {
    if (type === 'status') this.status = payload.status;
    this.emit('event', { type, ...payload });
  }
  async start() { this.started = true; }
  async send(text) {
    this.sent.push(text);
    this.push('status', { status: 'working' });
    this.push('turn.start', { turnId: `t${this.sent.length}`, text });
  }
  ask(requestId = 'r1') {
    this.push('status', { status: 'blocked' });
    this.push('permission.request', { requestId, kind: 'command', title: 'Run a command', options: [] });
    this.pending.set(requestId, {});
  }
  async answer(requestId, decision) {
    if (this.refuse) throw new Error('no pending request');
    this.answers = [...(this.answers ?? []), { requestId, decision }];
    this.pending.delete(requestId);
    this.push('permission.resolved', { requestId, decision: decision.option });
    this.push('status', { status: 'working' });
  }
  finish() {
    this.push('turn.done', { turnId: `t${this.sent.length}`, status: 'ok' });
    this.push('status', { status: 'idle' });
  }
  async interrupt() {}
  async kill() { this.push('status', { status: 'exited' }); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function chat(t, profileId) {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.HELM_DIR, `events-${Math.random().toString(36).slice(2)}`)),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  t.after(() => sessions.stop());
  const session = await sessions.start({ cwd: '/tmp', profileId });
  const driver = FakeDriver.made.at(-1);
  await sessions.input(session.id, 'Work');
  driver.ask();
  return { sessions, session, driver, notes: () => sessions.history(session.id).events
    .filter((event) => event.type === 'turn.start' && event.turnId?.startsWith('approval-note-')) };
}

test('a decline note goes to an agent without a note field as the next owner message', async (t) => {
  const { sessions, session, driver, notes } = await chat(t, 'devin');
  const result = await sessions.answer(session.id, 'r1', { option: 'deny', message: '  not now  ' });
  assert.equal(result.note, 'sent');
  assert.equal(notes().length, 1);
  assert.match(notes()[0].text, /^\[helm The owner declined "Run a command" and added this note\.\]\n\nnot now$/);
  // The answer went first; the note waits for the turn, then goes out.
  const log = sessions.history(session.id).events;
  assert.ok(log.findIndex((e) => e.type === 'permission.resolved') < log.findIndex((e) => e.turnId === notes()[0].turnId));
  driver.finish();
  await tick();
  assert.match(driver.sent.at(-1), /not now$/);
});

test('an approve note is sent as a message for every engine, Claude too', async (t) => {
  const { sessions, session, notes } = await chat(t, 'claudea');
  await sessions.answer(session.id, 'r1', { option: 'allow', message: 'then run the tests' });
  assert.equal(notes().length, 1);
  assert.match(notes()[0].text, /approved "Run a command".*\n\nthen run the tests$/);
});

test('Claude takes a decline note with its answer, so it is not sent again', async (t) => {
  const { sessions, session, driver, notes } = await chat(t, 'claudea');
  const result = await sessions.answer(session.id, 'r1', { option: 'deny', message: 'use ls' });
  assert.equal(result.note, undefined);
  assert.equal(driver.answers[0].decision.message, 'use ls');
  assert.equal(notes().length, 0);
});

test('no note, no extra message', async (t) => {
  const { sessions, session, notes } = await chat(t, 'devin');
  await sessions.answer(session.id, 'r1', { option: 'allow', message: '   ' });
  assert.equal(notes().length, 0);
});

test('a failed answer sends no note', async (t) => {
  const { sessions, session, driver, notes } = await chat(t, 'devin');
  driver.refuse = true;
  await assert.rejects(sessions.answer(session.id, 'r1', { option: 'deny', message: 'not now' }), /no pending request/);
  assert.equal(notes().length, 0);
});

test('the same answer twice sends the note once', async (t) => {
  const { sessions, session, driver, notes } = await chat(t, 'devin');
  await sessions.answer(session.id, 'r1', { option: 'deny', message: 'not now' });
  await sessions.answer(session.id, 'r1', { option: 'deny', message: 'not now' });
  driver.finish();
  await tick();
  assert.equal(notes().length, 1);
  assert.equal(driver.sent.filter((text) => text.endsWith('not now')).length, 1);
});
