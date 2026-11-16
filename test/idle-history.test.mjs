import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIG_HISTORY, DEFAULT_CACHE_TTL, cacheTtlOf, staleHistory, historySize } from '../packages/usage/src/idle-history.js';

const root = mkdtempSync(join(tmpdir(), 'helm-idle-history-'));
Object.assign(process.env, { HELM_DIR: root, HELM_NO_SERVICE: '1', XDG_STATE_HOME: join(root, 'state') });
test.after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, 'profiles.json'), JSON.stringify({ version: 1,
  profiles: [{ id: 'fake', engine: 'claude', cmd: 'claude', env: {}, source: 'alias' }] }));
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { EventLog } = await import('../packages/connect/src/events.js');
const { InputDelivery } = await import('../packages/connect/src/input-delivery.js');
const { AgentMessages } = await import('../packages/connect/src/agent-messages.js');
const { runMessageCommand } = await import('../packages/connect/src/agent-message-cli.js');
const { wire } = await import('../packages/connect/src/session-wire.js');

const HOUR = 60 * 60_000;
const chat = (context, extra = {}) => ({ engine: 'claude', status: 'idle', context, ...extra });

test('a big Claude history is cold only after its cache time, and only while idle', () => {
  const now = 10 * HOUR;
  const big = { used: 510_000, window: 1_000_000, at: now - 2 * HOUR };
  assert.deepEqual(staleHistory(chat(big), now), { tokens: 510_000, idleMs: 2 * HOUR });
  assert.equal(staleHistory(chat({ ...big, used: BIG_HISTORY - 1 }), now), null, 'small history');
  assert.equal(staleHistory(chat({ ...big, at: now - DEFAULT_CACHE_TTL + 1 }), now), null, 'still cached');
  assert.ok(staleHistory(chat({ ...big, at: now - 6 * 60_000, ttl: 5 * 60_000 }), now), 'a five-minute cache runs out sooner');
  assert.equal(staleHistory(chat({ ...big, compacted: true }), now), null, 'just compacted');
  assert.equal(staleHistory(chat(big, { status: 'working' }), now), null, 'working');
  assert.equal(staleHistory(chat(big, { status: 'blocked' }), now), null, 'waiting on a prompt');
  assert.equal(staleHistory(chat(big, { engine: 'codex' }), now), null, 'Codex has no such choice');
  assert.equal(staleHistory(chat(undefined), now), null);
  assert.equal(cacheTtlOf({ cache_creation: { ephemeral_1h_input_tokens: 9, ephemeral_5m_input_tokens: 0 } }), HOUR);
  assert.equal(cacheTtlOf({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 9 } }), 5 * 60_000);
  assert.equal(cacheTtlOf({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }), undefined);
  assert.equal(historySize(510_000), '510k');
  assert.equal(historySize(1_240_000), '1.2M');
});

class Runtime extends EventEmitter {
  async listLive() { return new Map(); }
  async read() { return { text: '' }; }
  watch() {}
}
class Driver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.status = 'idle'; this.pending = new Map(); this.engineSessionId = 'fake'; this.sent = []; }
  async start() {}
  async send(text) {
    this.sent.push(text);
    this.emit('event', { type: 'turn.start', turnId: 'native', text });
    this.status = 'working'; this.emit('event', { type: 'status', status: 'working' });
  }
  async compact(hint) { return this.send('/compact' + (hint ? ` ${hint}` : '')); }
  async kill() {}
  async suspend() {}
}

async function setup(t) {
  const dir = mkdtempSync(join(root, 'case-'));
  let driver;
  const sessions = new Sessions(new Runtime(), { events: new EventLog(join(dir, 'events')),
    makeDriver: (_engine, opts) => (driver = new Driver(opts)) });
  t.after(() => sessions.stop());
  const session = await sessions.start({ cwd: root, profileId: 'fake' });
  const record = sessions.get(session.id);
  record.context = { used: 510_000, window: 1_000_000, at: Date.now() - 2 * HOUR, ttl: HOUR };
  const inbox = new InputDelivery(sessions, { dir: join(dir, 'inbox') });
  const starts = () => sessions.history(session.id).events.filter((e) => e.type === 'turn.start' && e.turnId !== 'native').map((e) => e.text);
  return { sessions, session, record, inbox, starts, driver: () => driver };
}
const mid = (n) => n.toString(16).padStart(32, '0');

test('the owner chose compact: Claude compacts the cold history first, then reads the message', async (t) => {
  const f = await setup(t);
  assert.equal(wire(f.record).compactFirst, true, 'the app is told this machine can do it');
  const result = await f.inbox.deliver({ id: f.session.id, data: 'Next step please', messageId: mid(1), history: 'compact' }, 'phone');
  assert.equal(result.compacted, 510_000);
  assert.deepEqual(f.starts(), ['/compact', 'Next step please']);
  assert.deepEqual(f.driver().sent, ['/compact'], 'the message waits until the compaction ends');
});

test('the owner chose full history, or sent with an app that offers no choice: nothing is compacted', async (t) => {
  const f = await setup(t);
  await f.inbox.deliver({ id: f.session.id, data: 'Keep it all', messageId: mid(2), history: 'full' }, 'phone');
  assert.deepEqual(f.starts(), ['Keep it all']);
  const g = await setup(t);
  await g.inbox.deliver({ id: g.session.id, data: 'Old app', messageId: mid(3) }, 'phone');
  assert.deepEqual(g.starts(), ['Old app']);
});

test('a slash command or a warm cache never compacts first', async (t) => {
  const f = await setup(t);
  await f.sessions.input(f.session.id, '/status', { history: 'compact' });
  assert.ok(!f.starts().includes('/compact'));
  const g = await setup(t);
  g.record.context = { ...g.record.context, at: Date.now() - 60_000 };
  await g.sessions.input(g.session.id, 'Warm', { history: 'compact' });
  assert.deepEqual(g.starts(), ['Warm']);
});

test('an agent message compacts a cold history unless the chat still has helpers at work', async (t) => {
  const f = await setup(t);
  await f.sessions.input(f.session.id, 'From a helper', { source: 'agent' });
  assert.deepEqual(f.starts(), ['/compact', 'From a helper']);
  const g = await setup(t);
  g.record.team = { working: 1, blocked: 0, failed: 0 };
  await g.sessions.input(g.session.id, 'Lead is mid-job', { source: 'agent' });
  assert.deepEqual(g.starts(), ['Lead is mid-job']);
  const h = await setup(t);
  await h.sessions.input(h.session.id, 'Keep it', { source: 'agent', history: 'full' });
  assert.deepEqual(h.starts(), ['Keep it']);
});

test('helm say reports the compaction, and --full-history keeps the history', async (t) => {
  const f = await setup(t);
  const other = await f.sessions.start({ cwd: root, profileId: 'fake' });
  const messages = new AgentMessages({ sessions: f.sessions, delivery: f.inbox, self: 'local', dir: join(root, `messages-${f.session.id}`),
    rpc: () => assert.fail('unexpected remote') });
  const lines = [];
  const deps = { self: 'local', senderId: other.id, findSession: async () => ({ env: 'local', session: { id: f.session.id } }),
    rpc: async (_env, method, p) => { assert.equal(method, 'session.agent-send'); return messages.send(p); }, write: (s) => lines.push(s) };
  await runMessageCommand('say', [f.session.id, '--', 'Please check the build'], deps);
  assert.match(lines[0], /idle with 510k tokens of history, so Claude compacts that history first\. Add --full-history/);
  assert.equal(f.starts()[0], '/compact');

  const g = await setup(t);
  const sender = await g.sessions.start({ cwd: root, profileId: 'fake' });
  const gm = new AgentMessages({ sessions: g.sessions, delivery: g.inbox, self: 'local', dir: join(root, `messages-${g.session.id}`),
    rpc: () => assert.fail('unexpected remote') });
  const out = [];
  await runMessageCommand('say', [g.session.id, '--full-history', '--', 'Keep everything'], { ...deps, senderId: sender.id,
    findSession: async () => ({ env: 'local', session: { id: g.session.id } }), rpc: async (_e, _m, p) => gm.send(p), write: (s) => out.push(s) });
  assert.doesNotMatch(out[0], /compacts/);
  assert.equal(g.starts().length, 1);
  assert.match(g.starts()[0], /Keep everything/);
});

test('the Claude driver says how long its cache lasts, and the chat keeps the last known time', async (t) => {
  const f = await setup(t);
  f.sessions.get(f.session.id).context = undefined;
  const d = f.driver() ?? (await f.sessions.input(f.session.id, 'start', { history: 'full' }), f.driver());
  d.emit('event', { type: 'context', used: 250_000, window: 1_000_000, ttl: HOUR });
  assert.equal(f.sessions.get(f.session.id).context.ttl, HOUR);
  d.emit('event', { type: 'context', used: 260_000, window: 1_000_000 });
  assert.equal(f.sessions.get(f.session.id).context.ttl, HOUR, 'a reply that wrote no cache keeps the last time');
});
