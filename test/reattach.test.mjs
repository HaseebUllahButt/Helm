import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// After a daemon restart the agent processes it hosted are still running.
// Listening to them again can fail (a busy machine times the check out).
// That failure must not read as "task failed" on a chat that had nothing in
// flight; a chat that was working is held, marked, and retried.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-reattach-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [{ id: 'claudea', label: 'Claude', engine: 'claude', cmd: 'claude', args: [], env: {}, source: 'alias' },
    { id: 'codex', label: 'Codex', engine: 'codex', cmd: 'codex', args: [], env: {}, source: 'alias' }],
}));

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}

class FakeDriver extends EventEmitter {
  static failStarts = new Set();
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.status = 'idle';
    this.engineSessionId = opts.engineSessionId ?? 'engine-1';
    this.pending = new Map();
  }
  push(type, payload) { if (type === 'status') this.status = payload.status; this.emit('event', { type, ...payload }); }
  async start() {
    if (FakeDriver.failStarts.has(this.env.HELM_SESSION_ID)) throw new Error('codex live thread read failed: Codex thread/read timed out');
    this.started = true;
  }
  async send(text) {
    this.sent = (this.sent ?? []).concat(text);
    this.push('status', { status: 'working' });
    this.push('turn.start', { turnId: `t${this.sent.length}`, text });
  }
  finish(turnId, extra = {}) {
    this.push('turn.done', { turnId, status: 'ok', ...extra });
    this.push('status', { status: 'idle' });
  }
  async kill() {}
  suspend() {}
}

const setup = (name, extra = {}) => {
  const drivers = new Map();
  const make = async () => {
    const { Sessions } = await import('../packages/connect/src/sessions.js');
    const { EventLog } = await import('../packages/connect/src/events.js');
    return new Sessions(new StubRuntime(), {
      events: new EventLog(join(process.env.HELM_DIR, `events-${name}`)),
      // Every hosted process survived the restart.
      procHost: Object.assign(new EventEmitter(), { hasProc: () => true, procPipe: () => null }),
      makeDriver: (engine, opts) => { const d = new FakeDriver({ engine, ...opts }); drivers.set(opts.env.HELM_SESSION_ID, d); return d; },
      reattachRetryMs: 30,
      ...extra,
    });
  };
  return { make, drivers };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a failed reconnect leaves an idle chat idle and quiet, but holds and marks one that was working', async () => {
  const { make, drivers } = setup('idle-vs-busy');
  const first = await make();
  const idle = await first.start({ cwd: '/tmp', profileId: 'claudea' });
  await first.input(idle.id, 'hello');
  drivers.get(idle.id).finish('t1');
  const busy = await first.start({ cwd: '/tmp', profileId: 'claudea' });
  await first.input(busy.id, 'work on it');
  await settle();
  assert.equal(first.get(busy.id).status, 'working');
  await first.stop();

  FakeDriver.failStarts.add(idle.id); FakeDriver.failStarts.add(busy.id);
  const again = await make();
  await again.resume();
  await settle();
  const quiet = again.get(idle.id);
  assert.equal(quiet.status, 'idle');
  assert.equal(quiet.recovery, undefined, 'nothing was in flight, so nothing failed');
  assert.notEqual(quiet.queuePaused, true);
  const held = again.get(busy.id);
  assert.equal(held.status, 'idle');
  assert.equal(held.recovery?.kind, 'error');
  assert.match(held.recovery.message, /Could not reconnect/);
  assert.equal(held.queuePaused, true);

  // The next retry reaches the agent: the mark goes and the queue moves.
  FakeDriver.failStarts.clear();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(again.get(busy.id).recovery, undefined, 'a retry that connects clears the mark');
  assert.notEqual(again.get(busy.id).queuePaused, true);
  await again.stop();
});

test('a mark left by an earlier restart clears when the chat has nothing in flight', async () => {
  const { make, drivers } = setup('stale-mark');
  const first = await make();
  const s = await first.start({ cwd: '/tmp', profileId: 'claudea' });
  await first.input(s.id, 'hello'); drivers.get(s.id).finish('t1');
  // What the old daemon left behind: a failed-reconnect mark on an idle chat.
  first.get(s.id).recovery = { kind: 'error', message: 'Could not reconnect to the agent: Codex thread/read timed out', at: Date.now() };
  first.get(s.id).queuePaused = true;
  await first.stop();
  FakeDriver.failStarts.add(s.id);
  const again = await make();
  await again.resume();
  await settle();
  assert.equal(again.get(s.id).recovery, undefined);
  assert.notEqual(again.get(s.id).queuePaused, true);
  FakeDriver.failStarts.clear();
  await again.stop();
});

test('a stale mark also clears when the process it was about is gone', async () => {
  const { make, drivers } = setup('stale-dead', { procHost: Object.assign(new EventEmitter(), { hasProc: () => false, procPipe: () => null }) });
  const first = await make();
  const s = await first.start({ cwd: '/tmp', profileId: 'claudea' });
  await first.input(s.id, 'hello'); drivers.get(s.id).finish('t1');
  first.get(s.id).recovery = { kind: 'error', message: 'Could not reconnect to the agent: Codex thread/read timed out', at: Date.now() };
  first.get(s.id).queuePaused = true;
  await first.stop();
  const again = await make();
  await again.resume();
  assert.equal(again.get(s.id).recovery, undefined);
  assert.notEqual(again.get(s.id).queuePaused, true);
  await again.stop();
});

test('reconnects run a few at a time, not all at once', async () => {
  const { make, drivers } = setup('concurrency', { reattachConcurrency: 2 });
  const first = await make();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const s = await first.start({ cwd: '/tmp', profileId: 'claudea' });
    await first.input(s.id, 'hi'); drivers.get(s.id).finish('t1'); ids.push(s.id);
  }
  await first.stop();
  let running = 0, peak = 0;
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const again = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.HELM_DIR, 'events-concurrency')),
    procHost: Object.assign(new EventEmitter(), { hasProc: () => true, procPipe: () => null }),
    reattachConcurrency: 2,
    makeDriver: (engine, opts) => {
      const d = new FakeDriver({ engine, ...opts });
      d.start = async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running--; };
      return d;
    },
  });
  await again.resume();
  assert.equal(peak, 2);
  await again.stop();
});

test('one account reconnecting slowly does not hold back another account', async () => {
  const { make, drivers } = setup('per-account', { reattachConcurrency: 1 });
  const first = await make();
  for (const profileId of ['claudea', 'claudea', 'codex', 'codex']) {
    const s = await first.start({ cwd: '/tmp', profileId });
    await first.input(s.id, 'hi'); drivers.get(s.id).finish('t1');
  }
  await first.stop();
  let running = 0, peak = 0;
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const again = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.HELM_DIR, 'events-per-account')),
    procHost: Object.assign(new EventEmitter(), { hasProc: () => true, procPipe: () => null }),
    reattachConcurrency: 1,
    makeDriver: (engine, opts) => {
      const d = new FakeDriver({ engine, ...opts });
      d.start = async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running--; };
      return d;
    },
  });
  await again.resume();
  assert.equal(peak, 2, 'each account reconnects one at a time, and the two accounts at once');
  await again.stop();
});

test('a turn that reports tokens but no price is priced at list rates, and a Claude total is not double counted', async () => {
  const { make, drivers } = setup('cost');
  const sessions = await make();
  const { priceTurn } = await import('../packages/connect/src/sessions.js');
  const codex = await sessions.start({ cwd: '/tmp', profileId: 'codex', model: 'gpt-5.5' });
  await sessions.input(codex.id, 'price me');
  const usage = { input: 12_000, output: 800, cacheRead: 10_000, inputIncludesCache: true };
  drivers.get(codex.id).finish('t1', { usage });
  await settle();
  const expected = priceTurn('codex', 'gpt-5.5', usage);
  assert.ok(expected > 0, 'the table prices this model');
  assert.equal(sessions.get(codex.id).costUsd, expected);
  // A second turn adds to it.
  await sessions.input(codex.id, 'again');
  drivers.get(codex.id).finish('t2', { usage });
  await settle();
  assert.equal(sessions.get(codex.id).costUsd, Math.round(expected * 2 * 1e6) / 1e6);
  // Claude says what it cost itself; its tokens are not priced a second time.
  const claude = await sessions.start({ cwd: '/tmp', profileId: 'claudea', model: 'claude-opus-5-5' });
  await sessions.input(claude.id, 'hello');
  drivers.get(claude.id).finish('t1', { costTotalUsd: 0.25, usage: { input: 5000, output: 500 } });
  await settle();
  assert.equal(sessions.get(claude.id).costUsd, 0.25);
  // An unknown model stays unpriced rather than wrong.
  assert.equal(priceTurn('codex', 'gpt-made-up', usage), null);
  await sessions.stop();
});
