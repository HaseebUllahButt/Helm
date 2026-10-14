import './automation-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { Driver } = await import('../packages/connect/src/drivers/index.js');
const { usageResetAt, recoveryDue, mergeUsageLimits, isUsageLimit } = await import('../packages/connect/src/usage-recovery.js');
const { EventLog } = await import('../packages/connect/src/events.js');
mkdirSync(process.env.HELM_DIR, { recursive: true });
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [{ id: 'fake', engine: 'claude', cmd: 'claude', env: { CLAUDE_CONFIG_DIR: process.env.HELM_DIR } }] }));
class Provider extends Driver {
  sent = [];
  constructor(options) { super(options); this.engineSessionId ||= randomUUID(); }
  async start() {}
  async send(text) { if (this.refuse) { const error = this.refuse; this.refuse = null; throw error; } this.sent.push(text); this.turn = randomUUID(); this.push('turn.start', { turnId: this.turn, text }); this.push('status', { status: 'working' }); }
  fail(resetAt) { this.push('turn.done', { turnId: this.turn, status: 'error', error: 'usage limit reached', resetAt }); this.push('status', { status: 'idle' }); }
  async interrupt() {}
  async kill() {}
}
function backend(clear = true) {
  if (clear) rmSync(join(process.env.HELM_DIR, 'sessions.json'), { force: true });
  const drivers = [], runtime = new EventEmitter(); runtime.watch = () => {};
  const sessions = new Sessions(runtime, { events: new EventLog(join(process.env.HELM_DIR, 'events')), nativeDiscovery: false, turnSettleMs: 5,
    makeDriver: (_, options) => { const d = new Provider(options); drivers.push(d); return d; } });
  return { sessions, drivers };
}
async function until(predicate) { for (let i = 0; i < 50; i++) { if (predicate()) return; await delay(5); } assert.ok(predicate(), 'bounded wait completed'); }
async function limited(f) {
  const s = await f.sessions.start({ cwd: process.env.HELM_DIR, profileId: 'fake' });
  await f.sessions.input(s.id, 'Original task');
  const resetAt = Date.now() + 60000; f.drivers.at(-1).fail(resetAt); return { s, resetAt };
}

test('reset inference accepts absolute timestamps, chooses exhausted windows and rejects stale windows', () => {
  const at = Date.parse('2026-10-14T10:00:00Z');
  assert.equal(usageResetAt({ error: 'usage limit|1791975600' }, null, at), Date.parse('2026-10-14T11:00:00Z'));
  assert.equal(usageResetAt({}, { codex: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: (at + 60000) / 1000 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: (at + 120000) / 1000 } } }, at), at + 120000);
  assert.equal(usageResetAt({ resetAt: at - 1 }, null, at), null);
  assert.equal(usageResetAt({ error: 'resets 5pm' }, null, at), null);
  assert.equal(isUsageLimit({ error: "You've hit your limit |1234567890" }), true);
  const windows = mergeUsageLimits(mergeUsageLimits(null, { claude: { rateLimitType: 'seven_day', utilization: 1, resetsAt: (at + 120000) / 1000 } }),
    { claude: { rateLimitType: 'five_hour', utilization: 1, resetsAt: (at + 60000) / 1000 } });
  assert.equal(usageResetAt({}, windows, at), at + 120000);
  assert.equal(usageResetAt({}, { codex: { primary: { usedPercent: 100, windowDurationMins: 300 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: at + 120000 } } }, at), null);
  assert.equal(recoveryDue({ driver: 'claude', autoResumeLimited: true, recovery: { kind: 'limited', at, resetAt: at - 1 } }, at), false);
});

test('auto-continuation is opt-in, persists provider reset and resumes once when due', async t => {
  const f = backend(); t.after(() => f.sessions.stop()); const { s, resetAt } = await limited(f);
  assert.equal(s.recovery.resetAt, resetAt);
  assert.equal(JSON.parse(readFileSync(join(process.env.HELM_DIR, 'sessions.json'), 'utf8')).sessions[0].recovery.resetAt, resetAt);
  await f.sessions.tickLimitRecovery(resetAt + 1); assert.equal(f.drivers[0].sent.length, 1);
  f.sessions.setAutoResumeLimited(s.id, true);
  await f.sessions.tickLimitRecovery(resetAt - 1); assert.equal(f.drivers[0].sent.length, 1);
  await f.sessions.tickLimitRecovery(resetAt + 1); await until(() => f.drivers[0].sent.length === 2);
  await f.sessions.tickLimitRecovery(resetAt + 1); assert.equal(f.drivers[0].sent.length, 2); assert.equal(s.recovery, undefined);
  const tickets = f.sessions.events.tail(s.id, 0).filter(e => e.type === 'turn.start' && e.turnId.startsWith('local-limit-'));
  assert.equal(tickets.length, 1);
});

test('working, blocked, pending approvals, archive and stop prevent automatic continuation', async t => {
  const f = backend(); t.after(() => f.sessions.stop()); const { s, resetAt } = await limited(f); f.sessions.setAutoResumeLimited(s.id, true);
  for (const status of ['working', 'blocked', 'starting']) { s.status = status; await f.sessions.tickLimitRecovery(resetAt + 1); assert.equal(f.drivers[0].sent.length, 1); }
  s.status = 'idle'; f.sessions.events.append(s.id, { type: 'permission.request', requestId: 'ask', kind: 'command' });
  assert.equal(f.sessions.canReturnTask(s.id), false); await f.sessions.tickLimitRecovery(resetAt + 1); assert.equal(f.drivers[0].sent.length, 1);
  f.sessions.events.append(s.id, { type: 'permission.resolved', requestId: 'ask' });
  f.sessions.archive(s.id); await f.sessions.tickLimitRecovery(resetAt + 1); assert.equal(f.drivers[0].sent.length, 1);
  f.sessions.archive(s.id, false); await f.sessions.tickLimitRecovery(resetAt + 1); assert.equal(f.drivers[0].sent.length, 1);
  await f.sessions.interrupt(s.id); await f.sessions.tickLimitRecovery(resetAt + 1);
  assert.equal(f.drivers[0].sent.length, 1); assert.equal(s.recovery.kind, 'interrupted');
});

test('restart restores reset choice and queued work resumes without adding an extra prompt', async t => {
  let f = backend(); const { s, resetAt } = await limited(f); f.sessions.setAutoResumeLimited(s.id, true);
  await f.sessions.input(s.id, 'Queued request', { turnId: 'local-queued-work', source: 'schedule', delivery: 'queue' });
  assert.equal(f.drivers[0].sent.length, 1); await f.sessions.stop();
  f = backend(false); t.after(() => f.sessions.stop());
  await f.sessions.resume(); assert.equal(f.sessions.get(s.id).recovery.resetAt, resetAt);
  await f.sessions.tickLimitRecovery(resetAt + 1); await until(() => f.drivers.some(d => d.sent.length));
  assert.equal(f.drivers[0].sent[0], 'Queued request');
  assert.equal(f.sessions.events.tail(s.id, 0).filter(e => e.type === 'turn.start' && e.turnId.startsWith('local-limit-')).length, 0);
});

test('disabling during continuation staging withdraws its ticket; fresh-thread identity survives restart', async t => {
  const f = backend(); t.after(() => f.sessions.stop()); const { s, resetAt } = await limited(f); f.sessions.setAutoResumeLimited(s.id, true);
  const input = f.sessions.input.bind(f.sessions); let release;
  f.sessions.input = async (...args) => { await input(...args); await new Promise(resolve => { release = resolve; }); };
  const pending = f.sessions.tickLimitRecovery(resetAt + 1); await until(() => !!release);
  f.sessions.setAutoResumeLimited(s.id, false); release(); await pending;
  assert.equal(f.drivers[0].sent.length, 1); assert.equal(s.recovery.kind, 'limited');
  assert.equal(f.sessions.events.turnState(s.id, f.sessions.events.tail(s.id, 0).find(e => e.turnId?.startsWith('local-limit-')).turnId), 'removed');
  f.sessions.input = input;
  const child = await f.sessions.start({ cwd: process.env.HELM_DIR, profileId: 'fake', originAutomationId: 'local-schedule-durable' });
  assert.equal((await f.sessions.start({ cwd: process.env.HELM_DIR, profileId: 'fake', originAutomationId: 'local-schedule-durable' })).id, child.id);
  assert.equal(f.sessions.findAutomationSession('local-schedule-durable').id, child.id);
  assert.equal(JSON.parse(readFileSync(join(process.env.HELM_DIR, 'sessions.json'), 'utf8')).sessions.find(r => r.id === child.id).originAutomationId, 'local-schedule-durable');
});

test('a pre-delivery limit refusal retries the original request before queued follow-ups', async t => {
  const f = backend(); t.after(() => f.sessions.stop());
  const s = await f.sessions.start({ cwd: process.env.HELM_DIR, profileId: 'fake' });
  f.sessions.setAutoResumeLimited(s.id, true);
  const resetAt = Date.now() + 60000;
  f.drivers[0].refuse = Object.assign(new Error('Codex usage limit reached'), { resetAt });
  await assert.rejects(f.sessions.input(s.id, 'The original refused request'), /usage limit/);
  assert.equal(s.recovery.resetAt, resetAt); assert.ok(s.recovery.retryTurnId);
  await f.sessions.input(s.id, 'Later request', { turnId: 'local-after-refusal', source: 'schedule', delivery: 'queue' });
  await f.sessions.tickLimitRecovery(resetAt + 1); await until(() => f.drivers[0].sent.length === 1);
  assert.equal(f.drivers[0].sent[0], 'The original refused request');
  f.drivers[0].push('turn.done', { turnId: f.drivers[0].turn, status: 'ok' }); f.drivers[0].push('status', { status: 'idle' });
  await until(() => f.drivers[0].sent.length === 2); assert.equal(f.drivers[0].sent[1], 'Later request');
});
