import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schedules } from '../packages/connect/src/schedules.js';

function setup(context) {
  const directory = mkdtempSync(join(tmpdir(), 'helm-automation-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1_000_000;
  let idle = true;
  const session = { id: 'thread', driver: 'claude', engine: 'claude', profileId: 'account', model: 'model', lastUsage: { at: time, cacheRead: 4000 } };
  const sends = [];
  const seen = new Set();
  const sessions = {
    get(id) { if (id !== session.id) throw new Error('missing session'); return session; },
    canReturnTask() { return idle; },
    async input(id, text, options) {
      if (!seen.has(options.turnId)) { seen.add(options.turnId); sends.push({ id, text, options }); }
    },
  };
  return { directory, session, sessions, sends, now: () => time, advance: (ms) => { time += ms; }, setIdle: (value) => { idle = value; } };
}

test('schedules persist, skip busy work, and dispatch only one missed interval', async (context) => {
  const fixture = setup(context);
  let scheduler = new Schedules(fixture);
  const { schedule } = scheduler.save({ sessionId: 'thread', name: 'Review', prompt: 'Review changes', intervalMinutes: 5 });
  scheduler = new Schedules(fixture);
  assert.equal(scheduler.list().schedules[0].id, schedule.id);
  fixture.advance(60 * 60000);
  fixture.setIdle(false);
  await scheduler.tick();
  assert.equal(fixture.sends.length, 0);
  fixture.setIdle(true);
  fixture.advance(60000);
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(fixture.sends.length, 1);
  assert.equal(fixture.sends[0].options.source, 'schedule');
  scheduler.save({ id: schedule.id, enabled: false });
  fixture.advance(600000);
  await scheduler.tick();
  assert.equal(fixture.sends.length, 1);
  scheduler.remove(schedule.id);
  assert.equal(new Schedules(fixture).list().schedules.length, 0);
});

test('a schedule cannot dispatch twice concurrently and retains a durable retry identity', async (context) => {
  const fixture = setup(context);
  let finish;
  const original = fixture.sessions.input;
  fixture.sessions.input = async (...args) => {
    await original(...args);
    await new Promise((resolve) => { finish = resolve; });
  };
  const scheduler = new Schedules(fixture);
  const { schedule } = scheduler.save({ sessionId: 'thread', prompt: 'Review', intervalMinutes: 5 });
  const pending = scheduler.run(schedule.id);
  assert.equal((await scheduler.run(schedule.id)).skipped, true);
  assert.throws(() => scheduler.remove(schedule.id), /dispatch/);
  const recovered = new Schedules(fixture);
  assert.equal(recovered.list().schedules[0].dispatching, fixture.sends[0].options.turnId);
  finish(); await pending;
  fixture.sessions.input = original;
  await recovered.run(schedule.id);
  assert.equal(fixture.sends.length, 1);
});

test('schedule errors pause the task and invalid configuration never dispatches', async (context) => {
  const fixture = setup(context);
  const scheduler = new Schedules(fixture);
  assert.throws(() => scheduler.save({ sessionId: 'thread', prompt: 'Review', intervalMinutes: 0 }), /interval/);
  assert.throws(() => scheduler.save({ sessionId: 'missing', prompt: 'Review', intervalMinutes: 5 }), /missing/);
  const { schedule } = scheduler.save({ sessionId: 'thread', prompt: 'Review', intervalMinutes: 5 });
  fixture.sessions.input = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(scheduler.run(schedule.id), /provider unavailable/);
  assert.equal(scheduler.list().schedules[0].enabled, false);
  assert.equal(scheduler.list().schedules[0].lastError, 'provider unavailable');
});

test('stopped, archived and attention-needed threads never receive scheduled messages', async (context) => {
  const fixture = setup(context);
  const scheduler = new Schedules(fixture);
  const { schedule } = scheduler.save({ sessionId: 'thread', prompt: 'Review', intervalMinutes: 5 });
  for (const field of ['stoppedAt', 'archived', 'recovery']) {
    fixture.session[field] = true;
    fixture.advance(600000);
    await scheduler.tick();
    assert.equal((await scheduler.run(schedule.id)).skipped, true);
    assert.equal(fixture.sends.length, 0);
    delete fixture.session[field];
  }
  await scheduler.run(schedule.id);
  assert.equal(fixture.sends.length, 1);
});

test('stopping the scheduler during a dispatch does not launch later due tasks', async (context) => {
  const fixture = setup(context);
  const scheduler = new Schedules(fixture);
  scheduler.save({ sessionId: 'thread', prompt: 'First', intervalMinutes: 5 });
  scheduler.save({ sessionId: 'thread', prompt: 'Second', intervalMinutes: 5 });
  const input = fixture.sessions.input;
  fixture.sessions.input = async (...args) => { await input(...args); scheduler.stop(); };
  fixture.advance(600000);
  await scheduler.tick();
  assert.equal(fixture.sends.length, 1);
});
