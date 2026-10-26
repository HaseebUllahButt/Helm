import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-cli-agents-'));
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const codexHome = join(process.env.HELM_DIR, 'codex-home');
const dataHome = join(process.env.HELM_DIR, 'data');
const workdir = join(process.env.HELM_DIR, 'work');
mkdirSync(workdir, { recursive: true });
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'codex-main', label: 'Codex', engine: 'codex', cmd: process.execPath, env: { CODEX_HOME: codexHome }, source: 'custom' },
  { id: 'oc-main', label: 'OpenCode', engine: 'opencode2', cmd: process.execPath, env: { XDG_DATA_HOME: dataHome }, source: 'custom' },
  { id: 'devin-main', label: 'Devin', engine: 'devin', cmd: process.execPath, source: 'custom' },
] }));

const { codexSubagents, codexChildMessages, opencodeSubagents, cursorSubagents, cursorMessages, eventSubagents, relayToSubagent, unwrapCoordinator } =
  await import('../packages/connect/src/cli-subagents.js');
const { Sessions } = await import('../packages/connect/src/sessions.js');

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = opts.engineSessionId ?? randomUUID(); this.status = 'idle'; this.sent = []; }
  async start() {}
  push(type, extra = {}) { if (type === 'status') this.status = extra.status; this.emit('event', { type, ...extra }); }
  async send(text) { this.sent.push(text); this.push('turn.start', { turnId: `t${this.sent.length}`, text }); this.push('status', { status: 'working' }); }
  async messageSubagent(threadId, text) { (this.toChild ??= []).push([threadId, text]); }
  finish() { this.push('turn.done', { turnId: `t${this.sent.length}`, status: 'ok' }); this.push('status', { status: 'idle' }); }
  async kill() { this.push('status', { status: 'exited' }); }
  async interrupt() { this.finish(); }
}
function setup(t, engineSessionId) {
  const drivers = new Map();
  const runtime = new EventEmitter();
  runtime.listLive = async () => new Map();
  const sessions = new Sessions(runtime, { makeDriver: (_engine, opts) => {
    const d = new FakeDriver({ ...opts, engineSessionId: opts.engineSessionId ?? engineSessionId }); drivers.set(opts.env.HELM_SESSION_ID, d); return d;
  } });
  t.after(async () => { for (const id of drivers.keys()) await sessions.kill(id).catch(() => {}); });
  return { sessions, drivers };
}

const stamp = (ms) => new Date(ms).toISOString();
const line = (type, payload, t) => JSON.stringify({ timestamp: stamp(t), type, payload });

/** A Codex home with one parent thread and a forked child that did some work. */
function codexFixture({ parent, child, finished = true, ageMs = 60_000 }) {
  mkdirSync(join(codexHome, 'sessions'), { recursive: true });
  const rollout = join(codexHome, 'sessions', `rollout-${child}.jsonl`);
  const t = Date.now() - 120_000;
  const msg = (role, text) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
  writeFileSync(rollout, [
    line('session_meta', { id: child, forked_from_id: parent }, t),
    line('response_item', msg('user', 'The parent chat the child was forked from'), t + 1),
    line('response_item', msg('assistant', 'The parent answering, before the fork'), t + 2),
    line('event_msg', { type: 'task_started' }, t + 10),
    line('response_item', { type: 'agent_message', author: '/root', recipient: '/root/audit_flow',
      content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/audit_flow\nSender: /root\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'gAAAA' }] }, t + 11),
    line('response_item', { type: 'function_call', name: 'exec', arguments: '{"command":"rg intake"}' }, t + 12),
    line('response_item', msg('assistant', 'The intake flow saves twice.'), t + 13),
    ...(finished ? [line('event_msg', { type: 'task_complete', last_agent_message: 'The intake flow saves twice.' }, t + 14)] : []),
    line('response_item', { type: 'agent_message', author: '/root', recipient: '/root/audit_flow',
      content: [{ type: 'input_text', text: 'Message Type: MESSAGE\nTask name: /root/audit_flow\nSender: /root\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'gAAAA' }] }, t + 60_000),
  ].join('\n') + '\n');
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(rollout, when, when);
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at_ms INTEGER, agent_nickname TEXT, agent_role TEXT,
    agent_path TEXT, title TEXT, first_user_message TEXT, model TEXT);
    CREATE TABLE IF NOT EXISTS thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL);`);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(child, rollout, t, 'Dewey', null, '/root/audit_flow', 'title', 'forked opener', 'gpt-test');
  db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(parent, child, 'open');
  db.close();
  return { rollout, t };
}

test('a Codex chat lists the children its spawn edges name, with their own part of the rollout', async () => {
  const parent = randomUUID(), child = randomUUID();
  const { rollout, t } = codexFixture({ parent, child });
  const [card] = await codexSubagents({ home: codexHome, threadId: parent });
  assert.equal(card.id, child);
  assert.equal(card.engine, 'codex');
  assert.equal(card.title, 'audit flow');
  assert.equal(card.agentType, 'Dewey');
  assert.equal(card.model, 'gpt-test');
  assert.equal(card.status, 'done');
  assert.equal(card.target, '/root/audit_flow');
  assert.equal(card.last, 'The intake flow saves twice.');
  assert.deepEqual(await codexSubagents({ home: codexHome, threadId: randomUUID() }), []);

  // The fork's copy of the parent chat is not the child's conversation; the
  // sealed follow-up is filled in from what Helm passed on.
  const found = await codexChildMessages(rollout, { sent: [{ text: 'Check the quote path too', at: t + 59_000 }] });
  assert.deepEqual(found.map((m) => [m.role, m.text || m.tools[0]?.name]), [
    ['user', 'New task from the main chat.'], ['assistant', 'exec'], ['assistant', 'The intake flow saves twice.'],
    ['user', 'Check the quote path too'],
  ]);
});

test('an OpenCode chat lists child sessions by parent id, finished once the last reply completes', () => {
  const dir = join(dataHome, 'opencode');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);`);
  const old = Date.now() - 60_000;
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)').run('ses_child', 'ses_parent', 'Verify perf claims', 'general', null, old, old);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)').run('ses_live', 'ses_parent', 'Tone down rocks', 'general', null, old + 1, Date.now());
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run('m1', 'ses_child', 'assistant', 1, old,
    JSON.stringify({ time: { created: old, completed: old }, model: { id: 'big-pickle' }, content: [{ type: 'text', text: 'Claims hold.' }] }));
  // OpenCode closes a run with an idle row; the session's own stamp is not moved.
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run('m1e', 'ses_child', 'idle', 2, old + 5, JSON.stringify({ outcome: 'succeeded' }));
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run('m2', 'ses_live', 'assistant', 1, Date.now(),
    JSON.stringify({ time: { created: Date.now() }, content: [{ type: 'tool', name: 'shell' }] }));
  db.close();
  const cards = opencodeSubagents({ dataHome, sessionId: 'ses_parent' });
  assert.deepEqual(cards.map((c) => [c.id, c.title, c.status, c.agentType, c.target]), [
    ['ses_child', 'Verify perf claims', 'done', 'general', 'ses_child'], ['ses_live', 'Tone down rocks', 'working', 'general', 'ses_live'],
  ]);
  assert.equal(cards[0].model, 'big-pickle');
  assert.equal(cards[0].last, 'Claims hold.');
});

test('a Cursor chat lists the files in its subagents folder', async () => {
  const home = join(process.env.HELM_DIR, 'cursor');
  const dir = join(home, 'projects', 'home-me-app', 'agent-transcripts', 'chat-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'kid-1.jsonl');
  writeFileSync(path, [
    { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\nRewrite the mountains\nproperly\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Rewrote them.' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const when = (Date.now() - 60_000) / 1000;
  utimesSync(path, when, when);
  const [card] = await cursorSubagents({ home, chatId: 'chat-1' });
  assert.deepEqual([card.id, card.title, card.status, card.last], ['kid-1', 'Rewrite the mountains', 'done', 'Rewrote them.']);
  assert.deepEqual((await cursorMessages(path)).map((m) => [m.role, m.text]), [['user', 'Rewrite the mountains\nproperly'], ['assistant', 'Rewrote them.']]);
});

test('the log finds every spawn, never a wait or a message, and keeps what the driver reported', () => {
  const cards = eventSubagents([
    { type: 'item.start', id: 'spawn1', kind: 'subagent', name: 'spawnAgent', input: { prompt: 'Audit the flow' }, at: 1 },
    { type: 'item.start', id: 'wait1', kind: 'subagent', name: 'wait', at: 2 },
    { type: 'item.update', id: 'spawn1', agent: { id: 'thread-1', status: 'running' }, at: 3 },
    { type: 'item.done', id: 'spawn1', status: 'ok', at: 4 },
    { type: 'subagent.status', id: 'spawn1', status: 'working', at: 5 },
    { type: 'item.start', id: 'inner', kind: 'subagent', parentId: 'spawn1', name: 'spawnAgent', at: 6 },
  ], { engine: 'codex' });
  assert.deepEqual(cards.map((c) => [c.id, c.title, c.status, c.threadId, c.fromLog]), [['spawn1', 'Audit the flow', 'working', 'thread-1', true]]);
  // OpenCode's task answers with the child session it ran in.
  const [task] = eventSubagents([
    { type: 'item.start', id: 'call_1', kind: 'subagent', name: 'task', input: { description: 'Reply apple' } },
    { type: 'item.done', id: 'call_1', status: 'ok', output: '<subagent sessionID="ses_kid" state="completed">\napple\n</subagent>' },
  ], { engine: 'opencode2' });
  assert.deepEqual([task.threadId, task.last, task.status], ['ses_kid', 'apple', 'done']);
});

test('a message for a helper is passed on by its parent, in words its CLI acts on', () => {
  const card = { title: 'Reply with "apple"', target: 'ade1563', agentType: 'general' };
  const claude = relayToSubagent('claude', card, 'Now say banana');
  assert.match(claude, /^<subagent-message to="ade1563" title="Reply with 'apple'">\nNow say banana\n<\/subagent-message>/);
  assert.match(claude, /SendMessage \(to: "ade1563"\)/);
  assert.match(relayToSubagent('codex', { ...card, target: '/root/audit' }, 'x'), /send_message .* followup_task/);
  assert.match(relayToSubagent('opencode2', card, 'x'), /task_id "ade1563", subagent_type "general"/);
  assert.equal(unwrapCoordinator('The coordinator sent a message while you were working:\nNow say banana\n\nAddress this before completing your current task.'), 'Now say banana');
  assert.equal(unwrapCoordinator('Plain'), 'Plain');
});

test('a Codex chat shows its children, opens one, and messages it on its own thread', async (t) => {
  const parentThread = randomUUID(), child = randomUUID();
  codexFixture({ parent: parentThread, child });
  const { sessions, drivers } = setup(t, parentThread);
  const parent = await sessions.start({ cwd: workdir, profileId: 'codex-main' });
  assert.equal(sessions.get(parent.id).engineSessionId, parentThread);
  const { agent } = await sessions.nativeAgent(parent.id, child);
  assert.equal(agent.title, 'audit flow');
  assert.equal(agent.canMessage, true);
  assert.deepEqual(parent.nativeCards.map((c) => c.id), [child]);

  await sessions.messageNative(parent.id, child, 'Check the quote path too');
  // Straight to the helper's thread: the parent's model is not asked to relay it.
  assert.deepEqual(drivers.get(parent.id).toChild, [[child, 'Check the quote path too']]);
  assert.equal(drivers.get(parent.id).sent.length, 0);
  assert.equal(sessions.get(parent.id).nativeSent[child][0].text, 'Check the quote path too');
  const full = await sessions.nativeAgent(parent.id, child, { full: true });
  assert.ok(full.events.some((e) => e.type === 'turn.start' && e.text === 'Check the quote path too'));
  await assert.rejects(sessions.messageNative(parent.id, child, '   '), /write a message/);
});

test('a CLI with no readable records still shows the helpers its chat started, read from the log', async (t) => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: workdir, profileId: 'devin-main' });
  await sessions.input(parent.id, 'Split the work');
  const driver = drivers.get(parent.id);
  driver.push('item.start', { id: 'sub1', kind: 'subagent', turnId: 't1', name: 'run_subagent', input: { description: 'Read the parser', prompt: 'Read the parser and report' } });
  driver.push('item.start', { id: 'grep1', kind: 'tool', turnId: 't1', name: 'grep', input: { pattern: 'parse' }, parentId: 'sub1' });
  driver.push('item.done', { id: 'grep1', status: 'ok' });
  driver.push('item.done', { id: 'sub1', status: 'ok', output: 'The parser is fine.' });
  driver.finish();
  const { agent } = await sessions.nativeAgent(parent.id, 'sub1');
  assert.deepEqual([agent.title, agent.status, agent.canMessage], ['Read the parser', 'done', false]);
  assert.equal(sessions.get(parent.id).spawned, true);
  const full = await sessions.nativeAgent(parent.id, 'sub1', { full: true });
  assert.deepEqual(full.events.map((e) => [e.type, e.name ?? e.text ?? e.kind]), [
    ['turn.start', 'Read the parser and report'], ['item.start', 'grep'], ['item.done', undefined],
    ['item.start', 'text'], ['item.delta', 'The parser is fine.'], ['item.done', undefined], ['turn.done', undefined],
  ]);
  await assert.rejects(sessions.messageNative(parent.id, 'sub1', 'More'), /cannot pass messages/);
});

test('Codex v2 children show their own reply and status through the Helm subagent view', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: workdir, profileId: 'codex-main' });
  await sessions.input(parent.id, 'Use a child');
  const { CodexDriver } = await import('../packages/connect/src/drivers/codex.js');
  const source = new CodexDriver({ cmd: 'unused', env: {}, cwd: workdir });
  source.threadId = parent.engineSessionId;
  source.on('event', event => drivers.get(parent.id).emit('event', event));
  const activity = { type: 'subAgentActivity', id: 'v2-start', kind: 'started', agentThreadId: 'v2-child', agentPath: 'root/check', model: 'small-model' };
  source.onNotification('item/started', { threadId: source.threadId, turnId: 't1', item: activity });
  source.onNotification('item/completed', { threadId: source.threadId, turnId: 't1', item: activity });
  assert.equal(parent.team.working, 1);
  const working = await sessions.nativeAgent(parent.id, 'v2-start');
  assert.equal(working.agent.status, 'working');
  assert.equal(working.agent.threadId, 'v2-child');
  source.onNotification('item/started', { threadId: 'v2-child', turnId: 'child-turn', item: { type: 'agentMessage', id: 'v2-reply' } });
  source.onNotification('item/agentMessage/delta', { threadId: 'v2-child', itemId: 'v2-reply', delta: 'The child reply.' });
  source.onNotification('item/completed', { threadId: 'v2-child', item: { type: 'agentMessage', id: 'v2-reply', text: 'The child reply.' } });
  source.onNotification('item/completed', { threadId: source.threadId, turnId: 't1', item: { ...activity, id: 'v2-end', kind: 'completed' } });
  const done = await sessions.nativeAgent(parent.id, 'v2-start', { full: true });
  assert.equal(done.agent.status, 'done');
  assert.equal(parent.team.working, 0);
  assert.ok(done.events.some(e => e.type === 'item.delta' && e.text === 'The child reply.'));
  assert.equal(parent.nativeCards.length, 1);
});

test('finding the helpers a chat started does not re-read its whole log each time', async (t) => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: workdir, profileId: 'devin-main' });
  await sessions.input(parent.id, 'Split the work');
  const driver = drivers.get(parent.id);
  driver.push('item.start', { id: 'sub1', kind: 'subagent', turnId: 't1', name: 'run_subagent', input: { description: 'Read the parser', prompt: 'Read the parser and report' } });
  driver.push('item.done', { id: 'sub1', status: 'ok', output: 'Fine.' });
  driver.finish();
  const tail = sessions.events.tail.bind(sessions.events);
  const whole = [];
  sessions.events.tail = (id, n) => { if (n === 0) whole.push(id); return tail(id, n); };
  for (let i = 0; i < 3; i++) assert.equal((await sessions.nativeAgent(parent.id, 'sub1')).agent.title, 'Read the parser');
  assert.deepEqual(whole, []);
});
