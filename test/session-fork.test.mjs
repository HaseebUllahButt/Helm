import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Branching a conversation. What must hold: the branch is cut at the answer to
 * the turn before the chosen message, the original is left alone, a message
 * with nothing before it cannot be branched, and only Claude Code can.
 */
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-fork-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [
    { id: 'claudea', label: 'Claude', engine: 'claude', cmd: 'claude', args: [], env: {}, source: 'alias' },
    { id: 'codexa', label: 'Codex', engine: 'codex', cmd: 'codex', args: [], env: {}, source: 'alias' },
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
    this.engineSessionId = opts.engineSessionId ?? '99999999-9999-4999-8999-999999999999';
    this.pending = new Map();
    FakeDriver.made.push(this);
  }
  push(type, payload) { this.emit('event', { type, ...payload }); }
  async start() {}
  async send() {}
  async kill() {}
}

const { Sessions } = await import('../packages/connect/src/sessions.js');
const { EventLog } = await import('../packages/connect/src/events.js');
const events = new EventLog(join(process.env.HELM_DIR, 'events'));
const sessions = new Sessions(new StubRuntime(), { events, makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }) });

const ANSWER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANSWER_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A thread that has had two turns, each with an answer the CLI could cut at. */
async function twoTurns() {
  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea', title: 'fix login' });
  const d = FakeDriver.made.at(-1);
  d.push('turn.start', { turnId: 'turn-1', text: 'first question' });
  d.push('turn.done', { turnId: 'turn-1', status: 'ok', resumeAt: ANSWER_1, costTotalUsd: 0.5 });
  d.push('turn.start', { turnId: 'turn-2', text: 'second question' });
  d.push('turn.done', { turnId: 'turn-2', status: 'ok', resumeAt: ANSWER_2, costTotalUsd: 1.5 });
  return s;
}

test('a branch is cut at the answer before the chosen message, into a new thread', async () => {
  const parent = await twoTurns();
  const child = (await sessions.fork(parent.id, 'turn-2'));
  assert.notEqual(child.id, parent.id);
  assert.equal(child.title, 'fix login (branch)');
  assert.equal(child.cwd, parent.cwd);
  const d = FakeDriver.made.at(-1);
  assert.deepEqual(d.forkFrom, { sessionId: parent.engineSessionId, at: ANSWER_1 },
    'cut after the FIRST answer: the chosen message is the one being asked differently');
});

test('the thread it came from is left exactly as it was', async () => {
  const parent = await twoTurns();
  const before = JSON.stringify(sessions.get(parent.id));
  const seq = events.last(parent.id);
  await sessions.fork(parent.id, 'turn-2');
  assert.equal(JSON.stringify(sessions.get(parent.id)), before);
  assert.equal(events.last(parent.id), seq, 'no events were added to it');
});

test('the first message has nothing before it, so it cannot be branched', async () => {
  const parent = await twoTurns();
  await assert.rejects(sessions.fork(parent.id, 'turn-1'), /nothing comes before/);
});

test('a message that is not in the conversation is refused', async () => {
  const parent = await twoTurns();
  await assert.rejects(sessions.fork(parent.id, 'turn-404'), /not in this conversation/);
});

test('only Claude Code can be branched, and only a real thread', async () => {
  const codex = await sessions.start({ cwd: '/tmp', profileId: 'codexa' });
  await assert.rejects(sessions.fork(codex.id, 'x'), /only Claude Code/);
  await assert.rejects(sessions.fork('nope', 'x'), /no such thread/);
});

test("a branch's first result does not bill it for everything its parent cost", async () => {
  const parent = await twoTurns(); // ran up $1.50
  const child = await sessions.fork(parent.id, 'turn-2');
  const d = FakeDriver.made.at(-1);
  d.push('turn.start', { turnId: 'b-1', text: 'a different second question' });
  d.push('turn.done', { turnId: 'b-1', status: 'ok', resumeAt: ANSWER_2, costTotalUsd: 1.6 }); // carries the parent's total
  const rec = sessions.get(child.id);
  assert.equal(rec.costUsd ?? 0, 0, 'the inherited total is a baseline, not a charge');
  assert.equal(rec.forkFrom, undefined, 'and it stands alone from its first turn');
  d.push('turn.start', { turnId: 'b-2', text: 'next' });
  d.push('turn.done', { turnId: 'b-2', status: 'ok', resumeAt: ANSWER_2, costTotalUsd: 1.75 });
  assert.ok(Math.abs(sessions.get(child.id).costUsd - 0.15) < 1e-6, 'later turns are counted as usual');
});
