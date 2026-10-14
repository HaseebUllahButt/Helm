import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, statSync, readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-native-agents-'));
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const claudeHome = join(process.env.HELM_DIR, 'claude-home');
const workdir = join(process.env.HELM_DIR, 'work.dir');
mkdirSync(workdir, { recursive: true });
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'claude-main', label: 'Claude', engine: 'claude', cmd: process.execPath, env: { CLAUDE_CONFIG_DIR: claudeHome }, source: 'custom' },
  { id: 'codex-main', label: 'Codex', engine: 'codex', cmd: process.execPath, source: 'custom' },
] }));

const { nativeSubagents, nativeSubagent, nativeStatus, subagentsDir, findSubagentsDir, NATIVE_STALE_MS } = await import('../packages/connect/src/native-subagents.js');
const { Sessions, wire } = await import('../packages/connect/src/sessions.js');

const at = (ms) => new Date(ms).toISOString();
const user = (text, t) => ({ type: 'user', isSidechain: true, agentId: 'x', timestamp: at(t), message: { role: 'user', content: text } });
const toolResult = (t) => ({ type: 'user', isSidechain: true, timestamp: at(t), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] } });
const reply = (id, content, stop, t, extra = {}) => ({ type: 'assistant', isSidechain: true, timestamp: at(t), ...extra,
  message: { id, role: 'assistant', model: 'claude-opus-test', content, stop_reason: stop } });
const text = (s) => ({ type: 'text', text: s });
const tool = (name, input) => ({ type: 'tool_use', id: `toolu_${randomUUID()}`, name, input });

let dirs = 0;
function agentDir() {
  const dir = join(process.env.HELM_DIR, `fixture-${++dirs}`, 'sess', 'subagents');
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writeAgent(dir, id, records, { meta, ageMs = 0 } = {}) {
  const path = join(dir, `agent-${id}.jsonl`);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (meta !== null) writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta ?? {
    agentType: 'general-purpose', description: `Task ${id}`, model: 'opus', toolUseId: `toolu_${id}`,
    worktreeBranch: `worktree-agent-${id}`, worktreePath: `/tmp/wt-${id}`, spawnDepth: 1,
  }));
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(path, when, when);
  return path;
}

test('a subagent mid-tool is working and shows its latest step', async () => {
  const dir = agentDir();
  const t = Date.now() - 2000;
  writeAgent(dir, 'w1', [user('Find the bug\nin detail', t), reply('m1', [text('Looking.'), tool('Bash', { command: 'npm test', description: 'Run the tests' })], 'tool_use', t + 10)]);
  const [agent] = await nativeSubagents(dir);
  assert.equal(agent.id, 'w1');
  assert.equal(agent.native, true);
  assert.equal(agent.status, 'working');
  assert.equal(agent.title, 'Task w1');
  assert.equal(agent.agentType, 'general-purpose');
  assert.equal(agent.model, 'claude-opus-test');
  assert.equal(agent.branch, 'worktree-agent-w1');
  assert.equal(agent.toolUseId, 'toolu_w1');
  assert.equal(agent.startedAt, t);
  assert.equal(agent.last, 'Bash: Run the tests');
});

test('end_turn settles as done once the file is quiet, with the whole final reply', async () => {
  const dir = agentDir();
  const t = Date.now() - 60_000;
  const records = [user('Review it', t), reply('m1', [tool('Read', { file_path: '/a.js' })], 'tool_use', t + 1), toolResult(t + 2),
    reply('m2', [{ type: 'thinking', thinking: '' }], null, t + 3), reply('m2', [text('All good.')], null, t + 4), reply('m2', [text('One nit.')], 'end_turn', t + 5)];
  writeAgent(dir, 'd1', records, { ageMs: 30_000 });
  const [agent] = await nativeSubagents(dir);
  assert.equal(agent.status, 'done');
  assert.equal(agent.last, 'All good. One nit.');
  const detail = await nativeSubagent(dir, 'd1');
  assert.equal(detail.result, 'All good.\n\nOne nit.');
  assert.deepEqual(detail.activity, ['Read: /a.js', 'All good.', 'One nit.']);
  assert.equal(detail.task, 'Review it');
  assert.equal(detail.worktree, '/tmp/wt-d1');

  // Just written: a queued follow-up may still arrive, so not yet "Finished".
  writeAgent(dir, 'd2', records);
  assert.equal((await nativeSubagents(dir)).find((a) => a.id === 'd2').status, 'working');
});

test('an unfinished subagent that went quiet reads as stopped, never working forever', async () => {
  const dir = agentDir();
  const t = Date.now() - NATIVE_STALE_MS - 120_000;
  writeAgent(dir, 's1', [user('Long job', t), reply('m1', [tool('Bash', { command: 'sleep 1' })], 'tool_use', t + 1)], { ageMs: NATIVE_STALE_MS + 60_000 });
  const [agent] = await nativeSubagents(dir);
  assert.equal(agent.status, 'interrupted');
  assert.equal(nativeStatus('working', Date.now() - 1000), 'working');
  assert.equal(nativeStatus('done', Date.now() - NATIVE_STALE_MS * 2), 'done');
});

test('interrupts and provider errors are their own endings', async () => {
  const dir = agentDir();
  const t = Date.now() - 60_000;
  writeAgent(dir, 'i1', [user('Go', t), reply('m1', [tool('Bash', { command: 'x' })], 'tool_use', t + 1), user('[Request interrupted by user for tool use]', t + 2)], { ageMs: 10_000 });
  writeAgent(dir, 'e1', [user('Go', t), reply('m1', [text('API Error: overloaded')], 'stop_sequence', t + 1, { isApiErrorMessage: true })], { ageMs: 10_000 });
  const list = await nativeSubagents(dir);
  assert.equal(list.find((a) => a.id === 'i1').status, 'interrupted');
  const failed = list.find((a) => a.id === 'e1');
  assert.equal(failed.status, 'error');
  assert.equal(failed.last, 'API Error: overloaded');
});

test('missing meta falls back to the first line of the task', async () => {
  const dir = agentDir();
  writeAgent(dir, 'n1', [user('Summarise the README\nand more', Date.now() - 5000)], { meta: null });
  const [agent] = await nativeSubagents(dir);
  assert.equal(agent.title, 'Summarise the README');
  assert.equal(agent.agentType, null);
  assert.equal(agent.toolUseId, null);
  assert.equal(agent.status, 'working');
});

test('a huge transcript is read only at its head and tail, and not again until it changes', async () => {
  const dir = agentDir();
  const path = join(dir, 'agent-h1.jsonl');
  writeFileSync(join(dir, 'agent-h1.meta.json'), JSON.stringify({ description: 'Huge' }));
  const t = Date.now() - 60_000;
  const fd = openSync(path, 'w');
  const put = (r) => writeSync(fd, JSON.stringify(r) + '\n');
  put(user('Start here', t));
  const pad = { type: 'progress', isSidechain: true, pad: 'x'.repeat(4000) };
  for (let i = 0; i < 500; i++) put(pad);
  // Read whole, this would be the final reply; nothing after it has text.
  put(reply('mid', [text('MIDDLE')], 'end_turn', t + 1));
  for (let i = 0; i < 500; i++) put(pad);
  put(reply('m9', [tool('Grep', { pattern: 'needle' })], 'tool_use', t + 2));
  put(toolResult(t + 3));
  closeSync(fd);
  const stamp = new Date(Math.floor(Date.now() / 1000) * 1000 - 30_000);
  utimesSync(path, stamp, stamp);
  assert.ok(statSync(path).size > 3_000_000);
  const [agent] = await nativeSubagents(dir);
  assert.equal(agent.startedAt, t);
  assert.equal(agent.status, 'working');
  assert.equal(agent.last, 'Grep: needle');
  const detail = await nativeSubagent(dir, 'h1');
  assert.equal(detail.result, '');
  assert.ok(!detail.activity.includes('MIDDLE'));

  // Same size and mtime: the cached reading stands, the file is not opened.
  writeFileSync(path, 'z'.repeat(statSync(path).size));
  utimesSync(path, stamp, stamp);
  assert.equal((await nativeSubagents(dir))[0].last, 'Grep: needle');
});

test('only the newest runs are listed, oldest first', async () => {
  const dir = agentDir();
  const t = Date.now() - 600_000;
  for (const [i, id] of ['r1', 'r2', 'r3', 'r4'].entries()) {
    writeAgent(dir, id, [user(`Run ${id}`, t + i * 1000), reply('m', [text('ok')], 'end_turn', t + i * 1000 + 1)], { ageMs: 400_000 - i * 60_000 });
  }
  assert.deepEqual((await nativeSubagents(dir, { limit: 2 })).map((a) => a.id), ['r3', 'r4']);
});

test('folders and ids are found the way Claude names them, never outside the folder', async () => {
  assert.equal(subagentsDir('/h/projects/-p/abc.jsonl'), '/h/projects/-p/abc/subagents');
  assert.equal(subagentsDir(null), null);
  const sid = randomUUID();
  const dashed = join(claudeHome, 'projects', workdir.replace(/[^a-zA-Z0-9]/g, '-'), sid, 'subagents');
  mkdirSync(dashed, { recursive: true });
  assert.equal(findSubagentsDir({ home: claudeHome, cwd: workdir, sessionId: sid }), dashed);
  assert.equal(findSubagentsDir({ home: claudeHome, cwd: workdir, sessionId: '../x' }), null);
  assert.equal(await nativeSubagent(dashed, '../agent-x'), null);
  assert.deepEqual(await nativeSubagents(join(dashed, 'missing')), []);
});

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = randomUUID(); this.status = 'idle'; }
  async start() {}
  push(type, extra = {}) { if (type === 'status') this.status = extra.status; this.emit('event', { type, ...extra }); }
  async send() { this.push('status', { status: 'working' }); }
  async kill() { this.push('status', { status: 'exited' }); }
  async interrupt() {}
}

test('the team counts native subagents beside delegated children, once each', async (context) => {
  const drivers = new Map();
  const runtime = new EventEmitter();
  runtime.listLive = async () => new Map();
  const sessions = new Sessions(runtime, { makeDriver: (_engine, opts) => {
    const d = new FakeDriver(opts); drivers.set(opts.env.HELM_SESSION_ID, d); return d;
  } });
  context.after(async () => { for (const id of drivers.keys()) await sessions.kill(id).catch(() => {}); });
  const parent = await sessions.start({ cwd: workdir, profileId: 'claude-main' });
  const sid = sessions.get(parent.id).engineSessionId;
  const dir = join(claudeHome, 'projects', workdir.replace(/[^a-zA-Z0-9]/g, '-'), sid, 'subagents');
  mkdirSync(dir, { recursive: true });
  const t = Date.now() - 60_000;
  writeAgent(dir, 'live', [user('Dig', t), reply('m1', [tool('Bash', { command: 'ls' })], 'tool_use', t + 1)]);
  writeAgent(dir, 'over', [user('Check', t), reply('m1', [text('Done.')], 'end_turn', t + 1)], { ageMs: 20_000 });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'codex-main', task: 'Review' });
  assert.equal(parent.team.working, 1);

  const updates = [];
  sessions.on('session', (s) => { if (s.id === parent.id) updates.push(s); });
  const { agent } = await sessions.nativeAgent(parent.id, 'over');
  assert.equal(agent.result, 'Done.');
  assert.deepEqual(parent.nativeCards.map((a) => [a.id, a.status]), [['live', 'working'], ['over', 'done']]);
  assert.deepEqual(parent.team, { working: 2, blocked: 0, failed: 0 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].nativeCards.length, 2);

  // Reading again finds nothing new: no second card, no second count.
  await sessions.nativeAgent(parent.id, 'over');
  assert.equal(parent.nativeCards.length, 2);
  assert.equal(parent.team.working, 2);
  assert.equal(updates.length, 1);

  // Opened as a chat: the whole conversation, drawn from its own file.
  const full = await sessions.nativeAgent(parent.id, 'live', { full: true });
  assert.equal(full.more, false);
  assert.deepEqual(full.events.map((e) => [e.seq, e.type, e.kind ?? e.text ?? e.name]), [
    [1, 'turn.start', 'Dig'], [2, 'item.start', 'tool'], [3, 'item.done', undefined],
  ], 'a working subagent leaves its turn open');
  assert.equal(full.events[1].name, 'Bash');
  const done = await sessions.nativeAgent(parent.id, 'over', { full: true });
  assert.deepEqual(done.events.map((e) => e.type), ['turn.start', 'item.start', 'item.delta', 'item.done', 'turn.done']);
  assert.equal(done.events[2].text, 'Done.');
  assert.equal(updates.length, 1, 'reading it whole changes nothing');

  // Delegated children still list as Helm sessions, untouched.
  const listed = await sessions.list({ parentId: parent.id });
  assert.deepEqual(listed.map((s) => s.id), [child.id]);
  assert.equal(listed[0].nativeCards, undefined);

  // The live one finishes: one event, and the working count drops.
  writeAgent(dir, 'live', [user('Dig', t), reply('m1', [text('Found it.')], 'end_turn', t + 1)], { ageMs: 20_000 });
  await sessions.nativeAgent(parent.id, 'live');
  assert.equal(parent.nativeCards.find((a) => a.id === 'live').status, 'done');
  assert.equal(parent.team.working, 1);
  assert.equal(updates.length, 2);

  // Shown inline under its tool call in the chat, it is still one of the
  // chat's helpers: one card, and the step in the chat opens the same one.
  drivers.get(parent.id).push('item.start', { id: 'toolu_over', kind: 'subagent', turnId: 't1', name: 'Agent', input: {} });
  await sessions.nativeAgent(parent.id, 'over');
  assert.deepEqual(parent.nativeCards.map((a) => [a.id, a.toolUseId, a.canMessage]), [['live', 'toolu_live', true], ['over', 'toolu_over', true]]);

  // What Claude's files say is never written into Helm's own index.
  const saved = JSON.parse(readFileSync(join(process.env.HELM_DIR, 'sessions.json'), 'utf8'));
  assert.ok(saved.sessions.every((s) => !('nativeCards' in s)));
});

test('what the driver reported and what the files say about one subagent make one card', async (context) => {
  const drivers = new Map();
  const runtime = new EventEmitter();
  runtime.listLive = async () => new Map();
  const sessions = new Sessions(runtime, { makeDriver: (_engine, opts) => {
    const d = new FakeDriver(opts); drivers.set(opts.env.HELM_SESSION_ID, d); return d;
  } });
  context.after(async () => { for (const id of drivers.keys()) await sessions.kill(id).catch(() => {}); });
  const parent = await sessions.start({ cwd: workdir, profileId: 'claude-main' });
  const driver = drivers.get(parent.id);
  const sid = sessions.get(parent.id).engineSessionId;
  const dir = join(claudeHome, 'projects', workdir.replace(/[^a-zA-Z0-9]/g, '-'), sid, 'subagents');
  mkdirSync(dir, { recursive: true });
  const t = Date.now() - 60_000;
  writeAgent(dir, 'hooked', [user('Dig', t), reply('m1', [tool('Bash', { command: 'ls' })], 'tool_use', t + 1)]);
  writeAgent(dir, 'quiet', [user('Look', t), reply('m1', [tool('Grep', { pattern: 'x' })], 'tool_use', t + 1)]);
  writeAgent(dir, 'over', [user('Check', t), reply('m1', [text('Done.')], 'end_turn', t + 1)], { ageMs: 20_000 });

  // The driver knows one of them by its tool call; the others it never saw.
  driver.push('subagent.status', { id: 'toolu_hooked', status: 'working' });
  await sessions.nativeAgent(parent.id, 'quiet');
  assert.deepEqual(parent.nativeAgents, { toolu_hooked: 'working' }, 'the driver map is kept as it was');
  assert.deepEqual(parent.nativeCards.map((a) => [a.id, a.status]), [['hooked', 'working'], ['over', 'done'], ['quiet', 'working']], 'started together: in name order, every time');
  assert.deepEqual(parent.team, { working: 2, blocked: 0, failed: 0 }, 'one subagent, counted once');
  assert.equal(sessions.hasActiveDelegations(parent.id), true);

  // It waits on an approval: the card says so, and it counts as blocked only.
  driver.push('subagent.status', { id: 'toolu_hooked', status: 'blocked' });
  const hooked = parent.nativeCards.find((a) => a.id === 'hooked');
  assert.equal(hooked.status, 'blocked');
  assert.equal(hooked.title, 'Task hooked', 'the file still names it');
  assert.equal(hooked.branch, 'worktree-agent-hooked');
  assert.deepEqual(parent.team, { working: 1, blocked: 1, failed: 0 });
  const { agent } = await sessions.nativeAgent(parent.id, 'hooked');
  assert.equal(agent.status, 'blocked');
  assert.equal(agent.task, 'Dig');

  // A finished file the driver says failed reads failed, counted once as before.
  driver.push('subagent.status', { id: 'toolu_over', status: 'error' });
  assert.equal(parent.nativeCards.find((a) => a.id === 'over').status, 'error');
  assert.deepEqual(parent.team, { working: 1, blocked: 1, failed: 1 });

  // The driver lets go: the file's own reading stands again.
  driver.push('subagent.status', { id: 'toolu_hooked', status: 'idle' });
  assert.equal(parent.nativeCards.find((a) => a.id === 'hooked').status, 'working');
  assert.deepEqual(parent.team, { working: 2, blocked: 0, failed: 1 });

  // A card the driver does not know still does not hold the thread open.
  driver.push('subagent.status', { id: 'toolu_over', status: 'idle' });
  assert.deepEqual(parent.nativeAgents, {});
  assert.equal(parent.nativeCards.find((a) => a.id === 'over').status, 'done');
  assert.equal(sessions.hasActiveDelegations(parent.id), false);
  assert.deepEqual(parent.team, { working: 2, blocked: 0, failed: 0 });

  // The app gets the cards, never the driver's own map; the index keeps the map only.
  driver.push('subagent.status', { id: 'toolu_hooked', status: 'working' });
  const sent = wire(sessions.get(parent.id));
  assert.equal(sent.nativeCards.length, 3);
  assert.equal('nativeAgents' in sent, false);
  const saved = JSON.parse(readFileSync(join(process.env.HELM_DIR, 'sessions.json'), 'utf8')).sessions.find((s) => s.id === parent.id);
  assert.deepEqual(saved.nativeAgents, { toolu_hooked: 'working' });
  assert.equal('nativeCards' in saved, false);
});
