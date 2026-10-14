import './automation-env.mjs';
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

test('fixed time uses an explicit zone and weekdays, skips stale slots and follows DST', async t => {
  const f = setup(t), scheduler = new Schedules(f);
  const { nextScheduledRun } = await import('../packages/connect/src/schedules.js');
  const config = { type: 'fixed_time', timeOfDay: '09:00', timeZone: 'America/New_York', weekdays: [1] };
  assert.equal(new Date(nextScheduledRun(config, Date.parse('2026-03-06T15:00:00Z'))).toISOString(), '2026-03-09T13:00:00.000Z');
  assert.equal(new Date(nextScheduledRun({ type: 'fixed_time', timeOfDay: '01:30', timeZone: 'America/New_York' }, Date.parse('2026-11-01T05:30:00Z'))).toISOString(), '2026-11-02T06:30:00.000Z');
  const { schedule } = scheduler.save({ sessionId: 'thread', prompt: 'Daily', ...config, nextRunAt: f.now() + 60000 });
  f.advance(12 * 60000); await scheduler.tick(); assert.equal(f.sends.length, 0);
  assert.ok(scheduler.list().schedules[0].nextRunAt > f.now());
  scheduler.remove(schedule.id);
  assert.throws(() => scheduler.save({ sessionId: 'thread', prompt: 'Daily', ...config, timeZone: 'Invalid/Zone' }), /zone/);
});

test('webhook authenticates, bounds and deduplicates durable deliveries, and recovers after restart', async t => {
  const f = setup(t), scheduler = new Schedules(f);
  const { createHmac } = await import('node:crypto');
  f.setIdle(false);
  const secret = 'a-signature-secret-123';
  const { schedule } = scheduler.save({ sessionId: 'thread', prompt: 'Review {{body.action}} {{query.name}} {{headers.authorization}}', type: 'webhook', hmacSecret: secret });
  const token = schedule.webhook.path.split('/').at(-1), body = '{"action":"opened"}';
  const request = { body, headers: { 'x-github-delivery': 'delivery-1', authorization: 'private', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, query: { name: 'PR' } };
  assert.equal((await scheduler.receive(schedule.id, 'bad', request)).status, 404);
  assert.equal((await scheduler.receive(schedule.id, token, { body })).status, 401);
  assert.equal((await scheduler.receive(schedule.id, token, { body: 'x'.repeat(16385) })).status, 413);
  assert.equal((await scheduler.receive(schedule.id, token, request)).status, 202);
  assert.equal((await scheduler.receive(schedule.id, token, request)).duplicate, true);
  assert.equal(f.sends.length, 0);
  const visible = JSON.stringify(scheduler.list());
  assert.ok(!visible.includes(secret)); assert.ok(!visible.includes('private'));
  const recovered = new Schedules(f); f.setIdle(true); await recovered.tick(); await recovered.tick();
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].text, 'Review opened PR ');
  assert.equal(recovered.list().schedules[0].deliveries[0].status, 'sent');
  const rotated = recovered.save({ id: schedule.id, rotateToken: true }).schedule;
  assert.notEqual(rotated.webhook.path, schedule.webhook.path);
  assert.equal((await recovered.receive(schedule.id, token, request)).status, 404);
});

test('fresh executions reuse a persisted thread/turn after an uncertain dispatch', async t => {
  const f = setup(t), children = new Map(); let starts = 0;
  f.sessions.findAutomationSession = id => children.get(id);
  f.sessions.start = async options => {
    starts++; const child = { id: 'fresh', status: 'idle', ...options }; children.set(options.originAutomationId, child); return child;
  };
  const original = f.sessions.input;
  f.sessions.input = async (...args) => { await original(...args); throw new Error('reply lost'); };
  const scheduler = new Schedules(f), { schedule } = scheduler.save({ sessionId: 'thread', prompt: 'Fresh', intervalMinutes: 5, freshThread: true });
  await assert.rejects(scheduler.run(schedule.id), /reply lost/);
  const recovered = new Schedules(f); recovered.save({ id: schedule.id, enabled: true }); f.sessions.input = original;
  await recovered.run(schedule.id);
  assert.equal(starts, 1); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].id, 'fresh');
  assert.equal(recovered.list().schedules[0].lastSessionId, 'fresh');
});

test('webhook HTTP listener only exposes secret POST routes through its virtual share', async t => {
  const f = setup(t), scheduler = new Schedules({ ...f, shareName: 'helm-hooks-test', publicOrigin: () => 'https://helm-hooks-test.example.com' });
  t.after(() => scheduler.stop());
  const { schedule } = scheduler.save({ sessionId: 'thread', prompt: 'Review {{body}}', type: 'webhook' });
  await scheduler.listen();
  assert.equal(scheduler.share().name, 'helm-hooks-test');
  assert.equal(scheduler.list().schedules[0].webhook.url, `https://helm-hooks-test.example.com${schedule.webhook.path}`);
  const url = `http://127.0.0.1:${scheduler.port}${schedule.webhook.path}`;
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(`${url}bad`, { method: 'POST', body: 'x' })).status, 404);
  assert.equal((await fetch(url, { method: 'POST', body: 'x'.repeat(16385) })).status, 413);
  assert.equal((await fetch(url, { method: 'POST', body: 'payload' })).status, 202);
});

test('stop wins while a fresh thread is being created and webhook bursts are bounded', async t => {
  const f = setup(t), scheduler = new Schedules(f);
  f.sessions.start = async () => { f.session.stoppedAt = 1; return { id: 'new' }; };
  const { schedule } = scheduler.save({ sessionId: 'thread', prompt: 'Fresh', intervalMinutes: 5, freshThread: true });
  await assert.rejects(scheduler.run(schedule.id), /cancelled/); assert.equal(f.sends.length, 0);
  delete f.session.stoppedAt; f.setIdle(false);
  const hook = scheduler.save({ sessionId: 'thread', prompt: '{{body}}', type: 'webhook' }).schedule;
  const token = hook.webhook.path.split('/').at(-1);
  for (let n = 0; n < 8; n++) assert.equal((await scheduler.receive(hook.id, token, { body: 'work', headers: { 'idempotency-key': String(n) } })).status, 202);
  assert.equal((await scheduler.receive(hook.id, token, { body: 'work' })).status, 429);
  scheduler.save({ id: hook.id, enabled: false });
  assert.equal((await scheduler.receive(hook.id, token, { body: 'work' })).status, 409);
});

test('a public share carries signed webhook bytes to the advertised automation listener', async t => {
  const { createShareRoute } = await import('../apps/relay/src/share.js');
  const { Daemon } = await import('../packages/connect/src/agent.js');
  const { createServer, request } = await import('node:http');
  const { connect } = await import('node:net');
  const { createHmac } = await import('node:crypto');
  const f = setup(t), scheduler = new Schedules({ ...f, shareName: 'helm-hooks-routing' });
  const secret = 'isolated-webhook-secret';
  const hook = scheduler.save({ sessionId: 'thread', type: 'webhook', prompt: 'Received {{body.event}}', hmacSecret: secret }).schedule;
  await scheduler.listen();
  const oldDomain = process.env.HELM_SHARE_DOMAIN; process.env.HELM_SHARE_DOMAIN = 'hooks.test';
  const streams = new Set();
  const shareRoute = createShareRoute({ online: new Map([['fake-machine', {}]]),
    callEnv: (_, method, params) => Daemon.prototype.dispatch.call({ schedules: scheduler }, method, params),
    openTcp: async (_, port) => { assert.equal(port, scheduler.port); const socket = connect({ host: '127.0.0.1', port }); streams.add(socket); return socket; } });
  const hub = createServer((req, res) => void shareRoute.route(req, res));
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  t.after(() => { if (oldDomain == null) delete process.env.HELM_SHARE_DOMAIN; else process.env.HELM_SHARE_DOMAIN = oldDomain; for (const socket of streams) socket.destroy(); hub.closeAllConnections(); hub.close(); scheduler.stop(); });
  const body = '{"event":"reviewed"}';
  const result = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: hub.address().port, path: hook.webhook.path, method: 'POST', headers: {
      host: 'helm-hooks-routing.hooks.test', 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(body);
  });
  assert.equal(result, 202); assert.equal(f.sends[0].text, 'Received reviewed');
});

test('a known pre-delivery failure can retry with a new ticket after explicit resume', async t => {
  const f = setup(t), scheduler = new Schedules(f); let failed = true;
  f.sessions.events = { turnState: () => failed ? 'failed' : null };
  const original = f.sessions.input; f.sessions.input = async (...args) => { if (failed) throw Object.assign(new Error('send refused'), { code: 'turn_failed' }); await original(...args); };
  const { schedule } = scheduler.save({ sessionId: 'thread', prompt: 'Retry task', intervalMinutes: 5 });
  await assert.rejects(scheduler.run(schedule.id), /refused/);
  assert.equal(scheduler.list().schedules[0].dispatching, undefined);
  scheduler.save({ id: schedule.id, enabled: true }); failed = false; await scheduler.run(schedule.id);
  assert.equal(f.sends.length, 1);
});
