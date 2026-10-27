import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WRITING_REMINDER } from '../packages/protocol/brief.js';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-delegation-'));
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
process.env.HELM_DB = join(process.env.HELM_DIR, 'hub.sqlite');
process.env.HELM_PROCS_SOCKET = join(process.env.HELM_DIR, 'procs.sock');
process.env.HELM_TERMINALS_SOCKET = join(process.env.HELM_DIR, 'terminals.sock');
process.env.HELM_NATIVE_SOCKET = join(process.env.HELM_DIR, 'native.sock');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const profiles = [
  { id: 'codex-main', label: 'Codex personal', engine: 'codex', cmd: process.execPath, env: { CODEX_HOME: join(process.env.HELM_DIR, 'codex-home') }, source: 'custom' },
  { id: 'claude-main', label: 'Claude personal', engine: 'claude', cmd: process.execPath,
    env: { CLAUDE_CONFIG_DIR: '~/.claude-test', PRIVATE_TOKEN: 'never-advertise-me' }, args: ['--secret', 'never-advertise-me'], source: 'custom' },
];
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles }));
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { agentCatalog, parseAgentArgs, chooseAgent, delegationMode, delegationOutput, delegationNote, codexHelperFork, codexHelperHistory, readCodexHelperHistory } = await import('../packages/connect/src/delegation.js');
const { runAgentCommand } = await import('../packages/connect/src/agent-cli.js');
const { M } = await import('@helm/protocol');

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = opts.engineSessionId ?? randomUUID(); this.status = 'idle'; }
  async start() {}
  push(type, extra = {}) { if (type === 'status') this.status = extra.status; this.emit('event', { type, ...extra }); }
  async send(text) {
    this.sent = text;
    this.push('status', { status: 'working' });
    this.push('turn.start', { turnId: this.engineSessionId, text });
    this.push('item.start', { id: 'reply', kind: 'text', turnId: this.engineSessionId });
    this.push('item.delta', { id: 'reply', text: 'Opus reviewed the task.' });
  }
  finish(status = 'ok') {
    this.push('item.done', { id: 'reply', status });
    this.push('turn.done', { turnId: this.engineSessionId, status, ...(status === 'error' ? { error: 'provider failed' } : {}) });
    this.push('status', { status: 'idle' });
  }
  async kill() { this.push('status', { status: 'exited' }); }
  async interrupt() { this.finish('interrupted'); }
}

function setup(t, make = (opts) => new FakeDriver(opts), options = {}) {
  const drivers = new Map();
  const runtime = new EventEmitter();
  runtime.listLive = async () => new Map();
  const sessions = new Sessions(runtime, { ...options, makeDriver: (_engine, opts) => {
    const d = make(opts); drivers.set(opts.env.HELM_SESSION_ID, d); return d;
  } });
  t.after(async () => {
    for (const id of drivers.keys()) await sessions.kill(id).catch(() => {});
    await sessions.stop();
  });
  return { sessions, drivers };
}

test('Codex forks require the same local account, folder and native daemon', () => {
  const profile = profiles[0];
  const parent = { id: 'parent', engine: 'codex', engineSessionId: 'parent-thread', cwd: process.env.HELM_DIR };
  const fork = (p = parent, before = profile, after = profile, cwd = parent.cwd, worktree = false, socket = '/private/codex.sock') => codexHelperFork(p, before, after, cwd, worktree, socket);
  assert.equal(fork().threadId, 'parent-thread');
  assert.match(fork().note, /helper for chat parent/);
  assert.equal(fork(null), null);
  assert.equal(fork({ ...parent, engineSessionId: null }), null);
  assert.equal(fork({ ...parent, engine: 'claude' }), null);
  assert.equal(fork(parent, profile, profiles[1]), null);
  assert.equal(fork(parent, profile, { ...profile, env: { CODEX_HOME: '/other/account' } }), null);
  assert.equal(fork(parent, profile, { ...profile, env: { OPENAI_API_KEY: 'other-login' } }), null);
  assert.equal(fork(parent, profile, { ...profile, wraps: 'codex' }), null);
  assert.equal(fork(parent, profile, profile, '/different/folder'), null);
  assert.equal(fork(parent, profile, profile, parent.cwd, true), null);
  assert.equal(fork(parent, profile, profile, parent.cwd, false, null), null);
});

test('Codex recovery history leaves out queued tickets and keeps accepted tool results', () => {
  const events = [
    { type: 'turn.start', turnId: 'local-ticket', text: 'Unsent task' },
    { type: 'turn.start', turnId: 'own-turn', text: 'Accepted task' },
    { type: 'item.start', turnId: 'own-turn', id: 'tool', kind: 'command', name: 'exec', input: { command: 'echo saved' } },
    { type: 'item.done', id: 'tool', output: 'Saved result' },
  ];
  const history = codexHelperHistory(events);
  assert.match(history, /Accepted task/);
  assert.match(history, /Saved result/);
  assert.match(history, /echo saved/);
  assert.doesNotMatch(history, /Unsent task/);
});

test('Codex recovery reads earlier work from the saved log', async t => {
  const file = join(process.env.HELM_DIR, 'helper-recovery.jsonl');
  t.after(() => rmSync(file, { force: true }));
  writeFileSync(file, [
    { type: 'turn.start', turnId: 'early', text: 'Earlier helper task' },
    { type: 'item.start', turnId: 'early', id: 'reply', kind: 'text' },
    { type: 'item.delta', id: 'reply', text: 'Earlier helper reply' },
    ...Array.from({ length: 2400 }, () => ({ type: 'status', status: 'working' })),
  ].map(e => JSON.stringify(e)).join('\n'));
  const history = await readCodexHelperHistory(file);
  assert.match(history, /Earlier helper task/);
  assert.match(history, /Earlier helper reply/);
  assert.equal(await readCodexHelperHistory(file + '.missing'), '');
});

test('native children keep an idle parent active, expose questions, and settle independently', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  await sessions.input(parent.id, 'Review with a helper');
  const driver = drivers.get(parent.id);
  driver.push('subagent.status', { id: 'native-helper', status: 'working' });
  driver.finish();
  assert.equal(parent.status, 'idle', 'provider status stays separate from team activity');
  assert.deepEqual(parent.team, { working: 1, blocked: 0, failed: 0 });
  assert.equal(sessions.hasActiveDelegations(parent.id), true);
  driver.push('permission.request', { requestId: 'native-question', parentId: 'native-helper', kind: 'question', title: 'Which file?' });
  assert.deepEqual(parent.team, { working: 0, blocked: 1, failed: 0 });
  driver.push('subagent.status', { id: 'native-helper', status: 'working' });
  assert.equal(parent.team.blocked, 1, 'progress does not dismiss an unanswered question');
  driver.push('permission.resolved', { requestId: 'native-question', decision: 'allow' });
  assert.deepEqual(parent.team, { working: 1, blocked: 0, failed: 0 });
  driver.push('subagent.status', { id: 'native-helper', status: 'idle' });
  assert.deepEqual(parent.team, { working: 0, blocked: 0, failed: 0 });
  assert.equal(sessions.hasActiveDelegations(parent.id), false);
});

test('native child activity reaches a delegated ancestor and clears when its process exits', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  const driver = drivers.get(child.id);
  driver.push('subagent.status', { id: 'grandchild', status: 'working' });
  driver.finish();
  assert.equal(parent.team.working, 1);
  assert.equal(sessions.hasActiveDelegations(parent.id), true);
  driver.push('status', { status: 'exited' });
  assert.equal(parent.team.working, 0);
  assert.equal(sessions.hasActiveDelegations(parent.id), false);
});

test('a Claude chat in a terminal can start helpers; a plain terminal cannot', async t => {
  const { sessions } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const driver = parent.driver;
  // Shaped like a Claude terminal chat: no headless driver of its own. Put
  // back before the saved index outlives this test and reads as a terminal.
  delete parent.driver; parent.nativeCli = true; parent.nativeChat = true;
  try {
    const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Check the docs' });
    assert.equal(child.delegation.parentId, parent.id);
    assert.ok(parent.delegations.includes(child.id));
    parent.nativeChat = false;
    await assert.rejects(sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Again' }), /parent must be an agent session/);
  } finally { parent.driver = driver; delete parent.nativeCli; delete parent.nativeChat; }
});

test('agent capabilities show sign-in state without exposing launcher or credentials', async () => {
  const agents = await agentCatalog([...profiles, { ...profiles[1], id: 'wrapped', wraps: 'claude' }], new Map([['codex-main', 'authenticated'], ['claude-main', 'unauthenticated']]), { models: false });
  assert.equal(agents[0].available, true);
  assert.equal(agents[1].available, false);
  assert.equal(JSON.stringify(agents).includes('never-advertise-me'), false);
  for (const a of agents) for (const field of ['cmd', 'args', 'env', 'envFrom', 'credentials']) assert.equal(field in a, false);
});

test('credential diagnostics preserve current modes and never publish token values', async () => {
  const p = { ...profiles[0], env: { CODEX_HOME: process.env.HELM_DIR, OPENAI_API_KEY: 'diagnostic-secret' } };
  const statuses = new Map([[p.id, 'authenticated']]);
  const [basic] = await agentCatalog([p], statuses, { models: false });
  const [detailed] = await agentCatalog([p], statuses, { models: false, credentials: true });
  assert.equal(detailed.defaultMode, basic.defaultMode);
  assert.deepEqual(detailed.modes, basic.modes);
  assert.ok(detailed.credentials.some((c) => c.kind === 'env' && c.where === 'OPENAI_API_KEY' && c.via === 'profile'));
  assert.doesNotMatch(JSON.stringify(detailed), /diagnostic-secret/);
  for (const args of [[], ['--json']]) {
    const lines = [];
    await runAgentCommand('agents', args, { self: 'test', write: (line) => lines.push(line),
      rpc: async () => ({ agents: [detailed] }) });
    assert.match(lines.join('\n'), /OPENAI_API_KEY/);
    assert.doesNotMatch(lines.join('\n'), /diagnostic-secret/);
  }
});

test('a helper starts on the machine default for its account, never the parent model; explicit and saved helper defaults win', async t => {
  const { saveSubagentPrefs, saveModelPrefs } = await import('../packages/connect/src/settings.js');
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main', model: 'parent-model' });
  const launch = async (profileId, extra = {}) => {
    const { session } = await sessions.delegate({ id: parent.id, profileId, task: 'Inspect the task', ...extra });
    drivers.get(session.id).finish();
    return session;
  };
  const plain = await launch('codex-main');
  assert.notEqual(plain.model, 'parent-model');
  assert.equal(plain.delegation.requestedModel, null);
  saveModelPrefs(profiles[0], { default: 'machine-default' });
  t.after(() => saveModelPrefs(profiles[0], { default: null }));
  assert.equal((await launch('codex-main')).model, 'machine-default');
  assert.equal((await launch('codex-main', { model: 'override-model' })).model, 'override-model');
  saveSubagentPrefs(profiles[0], { model: 'helper-default', effort: 'high' });
  t.after(() => saveSubagentPrefs(profiles[0], { model: null, effort: null }));
  const saved = await launch('codex-main');
  assert.equal(saved.model, 'helper-default');
  assert.equal(saved.effort, 'high');
  const explicit = await launch('codex-main', { model: 'explicit', effort: 'low' });
  assert.equal(explicit.model, 'explicit');
  assert.equal(explicit.effort, 'low');
  saveSubagentPrefs(profiles[0], { model: null });
  assert.equal((await launch('codex-main')).model, 'machine-default');
});

test('helpers are offered the accounts new chats show: one row per account, hidden ones left out', async () => {
  const { markShown } = await import('../packages/connect/src/delegation.js');
  const list = [
    { id: 'codex', engine: 'codex', cmd: 'codex' },
    { id: 'codexx', engine: 'codex', cmd: 'codex', args: ['--yolo'] },
    { id: 'claude-p', engine: 'claude', cmd: 'claude', env: { CLAUDE_CONFIG_DIR: '~/.claude-personal' } },
    { id: 'claudea', engine: 'claude', cmd: 'claude', args: ['--x'], env: { CLAUDE_CONFIG_DIR: '~/.claude-personal' } },
    { id: 'grok', engine: 'grok', cmd: 'grok' },
  ];
  const rows = list.map((p) => ({ id: p.id, available: p.id !== 'claude-p' }));
  markShown(rows, list, ['grok||']);
  assert.deepEqual(rows.filter((r) => r.shown).map((r) => r.id), ['codex', 'claudea'],
    'the plainest alias, a signed-in one when the plainest is signed out, nothing hidden');
});

test("a chat's helper list answers from the index, without scanning processes or history", async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'codex-main', task: 'Check the list' });
  drivers.get(child.id).finish();
  sessions.runtime.listLive = async () => { throw new Error('the helper list should not scan processes'); };
  const listed = await sessions.list({ parentId: parent.id });
  assert.deepEqual(listed.map((s) => s.id), [child.id]);
  assert.equal(listed[0].alive, true);
  assert.equal(listed[0].delegation.parentId, parent.id);
});

test('Codex delegates to Claude with the selected model, folder, lineage and durable result', async (t) => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', model: 'opus', task: 'Review security' });
  assert.equal(child.engine, 'claude');
  assert.equal(child.model, 'opus');
  assert.equal(child.cwd, parent.cwd);
  assert.equal(child.delegation.parentId, parent.id);
  assert.equal(child.mode, 'bypassPermissions');
  assert.equal(child.notifyDone, false);
  assert.equal(drivers.get(child.id).delegated, true);
  assert.equal((await sessions.list()).some((s) => s.id === child.id), false);
  assert.equal((await sessions.list({ parentId: parent.id })).some((s) => s.id === child.id), true);
  assert.equal((await sessions.list({ includeDelegations: true })).some((s) => s.id === child.id), true);
  assert.equal(sessions.isDelegatedConversation(child.engine, child.engineSessionId), true);
  assert.equal(sessions.hasActiveDelegations(parent.id), true);
  assert.deepEqual(parent.delegations, [child.id]);
  assert.equal(drivers.get(child.id).env.HELM_SESSION_ID, child.id);
  assert.equal(drivers.get(child.id).sent, 'Review security');
  assert.equal(sessions.delegationResult(child.id).status, 'working');
  drivers.get(child.id).finish();
  assert.equal(sessions.hasActiveDelegations(parent.id), false);
  assert.equal(sessions.delegationResult(child.id).output, 'Opus reviewed the task.');
  assert.equal(sessions.delegationResult(child.id).status, 'done');
  const restarted = new Sessions(new EventEmitter(), { makeDriver: () => assert.fail('reading must not launch a CLI') });
  t.after(() => restarted.stop());
  assert.equal(restarted.get(child.id).delegation.parentId, parent.id);
  assert.equal(restarted.delegationResult(child.id).complete, true);
});

test('a long helper is still working after its turn start leaves the newest events', async () => {
  const { delegationOutput } = await import('../packages/connect/src/delegation.js');
  // The tail a 2,000-event window kept of a real helper at event 2,010: its
  // turn.start had scrolled out, Helm's own ticket for the task had closed.
  const tail = [
    { seq: 160, type: 'item.start', id: 'tool1', kind: 'tool', turnId: 'real', name: 'Bash' },
    { seq: 165, type: 'item.done', id: 'tool1', status: 'ok' },
    { seq: 166, type: 'turn.done', turnId: 'local-ticket', status: 'ok' },
    { seq: 169, type: 'item.start', id: 'text1', kind: 'text', turnId: 'real' },
    { seq: 170, type: 'item.delta', id: 'text1', text: 'Now I write the command.' },
  ];
  const session = { status: 'working', delegation: { status: 'working' } };
  const active = { seq: 4, type: 'turn.start', turnId: 'real' };
  const result = delegationOutput(session, tail, active);
  assert.equal(result.complete, false);
  assert.equal(result.status, 'working');
});

test('native CLI callers can delegate without a Helm parent session', async (t) => {
  const { sessions } = setup(t);
  const { session } = await sessions.delegate({ cwd: process.env.HELM_DIR, profileId: 'claude-main', task: 'Check this folder' });
  assert.equal(session.delegation.parentId, null);
  assert.equal(session.cwd, process.env.HELM_DIR);
});

test('finished children release promptly, retain their reply and resume the same provider conversation', async t => {
  const { sessions, drivers } = setup(t, opts => new FakeDriver(opts), { delegationIdleMs: 10 });
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Inspect' });
  const original = drivers.get(child.id); const providerId = child.engineSessionId;
  original.finish();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(original.status, 'exited');
  assert.equal(sessions.get(child.id).status, 'idle');
  assert.equal(sessions.get(child.id).engineSessionId, providerId);
  assert.equal(sessions.delegationResult(child.id).output, 'Opus reviewed the task.');
  assert.equal(sessions.delegationResult(child.id).status, 'done');
  assert.equal((await sessions.list({ includeDelegations: true })).find(s => s.id === child.id).alive, false);
  assert.notEqual(drivers.get(parent.id).status, 'exited');
  await sessions.messageDelegation(parent.id, child.id, 'Follow up');
  await new Promise(resolve => setTimeout(resolve, 10));
  const resumed = drivers.get(child.id);
  assert.notEqual(resumed, original); assert.equal(resumed.engineSessionId, providerId);
  assert.equal(resumed.sent, 'Follow up');
});

test('an idle child waiting on its own background command is not released until it ends', async t => {
  const { sessions, drivers } = setup(t, opts => new FakeDriver(opts), { delegationIdleMs: 10 });
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Run the checks' });
  const original = drivers.get(child.id);
  original.backgroundTasks = 1;
  original.finish();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(original.status, 'idle', 'releasing it would end the command it is waiting on');
  original.backgroundTasks = 0;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(original.status, 'exited');
});

test('a child sharing a Codex account releases its own driver without closing another thread', async t => {
  const { sessions, drivers } = setup(t, opts => new FakeDriver(opts), { delegationIdleMs: 10 });
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'codex-main', task: 'Inspect' });
  sessions.get(child.id).shared = true;
  const original = drivers.get(child.id); original.finish();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(original.status, 'exited');
  assert.notEqual(drivers.get(parent.id).status, 'exited');
  assert.equal(sessions.delegationResult(child.id).complete, true);
});

test('idle child cleanup waits for nested work and unfinished replies', async t => {
  const { sessions, drivers } = setup(t, opts => new FakeDriver(opts), { delegationIdleMs: 10 });
  const { session: child } = await sessions.delegate({ cwd: process.env.HELM_DIR, profileId: 'claude-main', task: 'Coordinate' });
  const { session: nested } = await sessions.delegate({ id: child.id, profileId: 'claude-main', task: 'Inspect' });
  const original = drivers.get(child.id); original.finish();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(original.status, 'idle');
  drivers.get(nested.id).finish();
  await new Promise(resolve => setTimeout(resolve, 5));
  if (original.status === 'working') original.finish();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(original.status, 'exited');
  const { session: unfinished } = await sessions.delegate({ cwd: process.env.HELM_DIR, profileId: 'claude-main', task: 'Unfinished' });
  const pending = drivers.get(unfinished.id); pending.push('status', {status:'idle'});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.notEqual(pending.status, 'exited');
});

test('a follow-up arriving during child release waits for the old process to exit', async t => {
  let release;
  const { sessions, drivers } = setup(t, opts => {
    const driver = new FakeDriver(opts);
    driver.kill = async () => { await new Promise(resolve => { release = resolve; }); driver.push('status', {status:'exited'}); };
    return driver;
  }, { delegationIdleMs: 10 });
  const { session: child } = await sessions.delegate({ cwd: process.env.HELM_DIR, profileId: 'claude-main', task: 'Inspect' });
  const original = drivers.get(child.id); original.finish();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(typeof release, 'function');
  const follow = sessions.input(child.id, 'Follow up');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(drivers.get(child.id), original);
  release(); await follow;
  await new Promise(resolve => setTimeout(resolve, 10));
  const resumed = drivers.get(child.id); assert.notEqual(resumed, original);
  assert.equal(resumed.engineSessionId, original.engineSessionId);
  assert.equal(resumed.sent, 'Follow up');
  resumed.kill = async () => resumed.push('status', {status:'exited'});
});

test('team attention updates after archive, restore and deletion', async (context) => {
  const { sessions, drivers } = setup(context);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  assert.equal(parent.team.working, 1);
  drivers.get(child.id).push('status', { status: 'blocked' });
  assert.equal(parent.team.blocked, 1);
  assert.equal(parent.team.working, 0);
  sessions.archive(child.id);
  assert.deepEqual(parent.team, { working: 0, blocked: 0, failed: 0 });
  sessions.archive(child.id, false);
  assert.equal(parent.team.blocked, 1);
  await sessions.kill(child.id);
  assert.deepEqual(parent.team, { working: 0, blocked: 0, failed: 0 });
});

test('stopping a parent cascades and late child results cannot restart it', async (context) => {
  const { sessions, drivers } = setup(context);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  const { session: grandchild } = await sessions.delegate({ id: child.id, profileId: 'codex-main', task: 'Check tests' });
  await sessions.interrupt(parent.id);
  assert.equal(sessions.get(child.id).delegation.status, 'interrupted');
  assert.equal(sessions.get(grandchild.id).delegation.status, 'interrupted');
  assert.equal(parent.recovery.message, 'You stopped this chat. Helm also stopped its helper.');
  assert.equal(sessions.get(grandchild.id).recovery.message, 'Stopped by you.', 'no helpers of its own: none are mentioned');
  assert.deepEqual(parent.team, { working: 0, blocked: 0, failed: 0 });
  await sessions.input(parent.id, 'A new user request');
  drivers.get(child.id).finish();
  drivers.get(grandchild.id).finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drivers.get(parent.id).sent, 'A new user request');
  assert.equal(sessions.history(parent.id).events.some((event) => String(event.turnId).startsWith('local-result-')), false);
  assert.equal(sessions.get(child.id).delegation.status, 'interrupted');
});

test('stopping a parent leaves a helper that already finished as it was', async (context) => {
  const { sessions, drivers } = setup(context);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: done } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  const { session: busy } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Check tests' });
  drivers.get(done.id).finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.get(done.id).delegation.status, 'done');
  const finishedAt = sessions.get(done.id).delegation.finishedAt;
  await sessions.interrupt(parent.id);
  assert.equal(sessions.get(done.id).delegation.status, 'done', 'a finished helper keeps its result');
  assert.equal(sessions.get(done.id).delegation.finishedAt, finishedAt);
  assert.equal(sessions.get(done.id).recovery, undefined, 'and is not marked stopped');
  assert.equal(sessions.get(busy.id).delegation.status, 'interrupted', 'one still at work is stopped');
  assert.equal(parent.recovery.message, 'You stopped this chat. Helm also stopped its helper.');
});

test('a child completion wakes its idle parent once with a durable result ticket', async (context) => {
  const { sessions, drivers } = setup(context);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  drivers.get(child.id).finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(drivers.get(parent.id).sent, /Opus reviewed the task/);
  const tickets = sessions.history(parent.id).events.filter((event) => event.type === 'turn.start' && String(event.turnId).startsWith('local-result-'));
  assert.equal(tickets.length, 1);
  assert.ok(sessions.get(child.id).delegation.notifiedSeq > 0);
  const duplicate = await sessions.input(parent.id, 'Duplicate result', { turnId: tickets[0].turnId, source: 'delegation' });
  assert.equal(duplicate.duplicate, true);
});

test('collecting a completed result removes its queued notice and survives restart', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  await sessions.input(parent.id, 'Implement and ship');
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Redesign' });
  drivers.get(child.id).finish();
  await new Promise(resolve => setImmediate(resolve));
  const ticket = sessions.history(parent.id).events.find(e => String(e.turnId).startsWith(`local-result-${child.id}-`));
  assert.equal(ticket.queued, true);
  sessions.delegationResult(child.id);
  sessions.delegationResult(child.id, { consume: true, parentId: parent.id, callerThreadId: 'another-thread' });
  assert.equal(sessions.turnState(parent.id, ticket.turnId), 'open', 'ordinary and unrelated reads cannot consume a notice');
  const result = sessions.delegationResult(child.id, { consume: true, parentId: parent.id, callerThreadId: parent.engineSessionId });
  assert.equal(result.complete, true);
  assert.equal(sessions.turnState(parent.id, ticket.turnId), 'removed');
  // Crash after the acknowledgement was saved but before turn.remove was
  // flushed: the durable marker still prevents queue restoration.
  writeFileSync(join(process.env.HELM_DIR, 'events', `${parent.id}.jsonl`),
    sessions.history(parent.id).events.filter(e => !(e.type === 'turn.remove' && e.turnId === ticket.turnId))
      .map(e => JSON.stringify(e)).join('\n') + '\n');
  const restarted = new Sessions(new EventEmitter(), { makeDriver: () => assert.fail('collected results must not launch an agent') });
  t.after(() => restarted.stop());
  await restarted.resume();
  assert.ok(restarted.get(child.id).delegation.consumedSeq > 0);
  assert.equal(restarted.turnState(parent.id, ticket.turnId), 'removed');
  drivers.get(parent.id).finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drivers.get(parent.id).sent, 'Implement and ship', 'finishing the parent does not deliver the result again');
});

test('a completion notice uses its outcome before idle arrives after a steering ticket', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  await sessions.input(parent.id, 'Work');
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  sessions.events.append(child.id, { type: 'turn.start', turnId: 'local-message-steered', queued: true, text: 'Check mobile' });
  sessions.events.append(child.id, { type: 'turn.accept', turnId: 'local-message-steered' });
  drivers.get(child.id).push('item.delta', { id: 'reply', text: 'Final review.' });
  drivers.get(child.id).push('turn.done', { turnId: drivers.get(child.id).engineSessionId, status: 'ok' });
  await new Promise(resolve => setImmediate(resolve));
  const ticket = sessions.history(parent.id).events.find(e => String(e.turnId).startsWith(`local-result-${child.id}-`));
  assert.match(ticket.text, /Status: done\n/);
  assert.doesNotMatch(ticket.text, /Status: working/);
});

test('a parent waiting on a result gets it once, not again as a notice', async t => {
  const { sessions, drivers } = setup(t, undefined, { waiterGraceMs: 200 });
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  // `delegate-result --wait` is polling while the child works.
  assert.equal(sessions.delegationResult(child.id, { consume: true, parentId: parent.id }).complete, false);
  drivers.get(child.id).finish();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sessions.delegationResult(child.id, { consume: true, parentId: parent.id }).complete, true);
  await new Promise(resolve => setTimeout(resolve, 400));
  const tickets = sessions.history(parent.id).events.filter(e => String(e.turnId).startsWith(`local-result-${child.id}-`));
  assert.deepEqual(tickets, [], 'the waiter took the result; the idle parent is not woken with it again');
  assert.equal(drivers.get(parent.id).sent, undefined);
});

test('a waiter that gave up still gets the result as a notice', async t => {
  const { sessions, drivers } = setup(t, undefined, { waiterGraceMs: 100 });
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  sessions.delegationResult(child.id, { consume: true, parentId: parent.id });
  drivers.get(child.id).finish();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.match(drivers.get(parent.id).sent, /Opus reviewed the task/);
});

test('collecting an earlier result leaves a later follow-up notification available', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  await sessions.input(parent.id, 'Work');
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  const kid = drivers.get(child.id);
  kid.finish();
  await new Promise(resolve => setImmediate(resolve));
  sessions.delegationResult(child.id, { consume: true, parentId: parent.id });
  kid.push('status', { status: 'working' });
  kid.push('turn.start', { turnId: 'followup', text: 'Check the follow-up' });
  kid.push('item.start', { id: 'followup-reply', kind: 'text', turnId: 'followup' });
  kid.push('item.delta', { id: 'followup-reply', text: 'Follow-up complete.' });
  kid.push('turn.done', { turnId: 'followup', status: 'ok' });
  kid.push('status', { status: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  const tickets = sessions.history(parent.id).events.filter(e => e.type === 'turn.start' && String(e.turnId).startsWith(`local-result-${child.id}-`));
  assert.equal(tickets.length, 2);
  assert.equal(sessions.turnState(parent.id, tickets[0].turnId), 'removed');
  assert.equal(sessions.turnState(parent.id, tickets[1].turnId), 'open');
  assert.match(tickets[1].text, /Follow-up complete/);
});

test('collecting a result while its notification is in flight cannot enqueue it later', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  await sessions.input(parent.id, 'Work');
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  const input = sessions.input.bind(sessions);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  sessions.input = async (id, text, options) => {
    if (options?.source === 'delegation') await gate;
    return input(id, text, options);
  };
  drivers.get(child.id).finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessions.delegationResult(child.id, { consume: true, parentId: parent.id }).complete, true);
  release();
  await new Promise(resolve => setImmediate(resolve));
  const tickets = sessions.history(parent.id).events.filter(e => e.type === 'turn.start' && String(e.turnId).startsWith(`local-result-${child.id}-`));
  assert.equal(tickets.length, 1);
  assert.equal(sessions.turnState(parent.id, tickets[0].turnId), 'removed');
  drivers.get(parent.id).finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drivers.get(parent.id).sent, 'Work');
});

test('a wake-up after a collected result never wakes the parent again', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  await sessions.input(parent.id, 'Work');
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  const kid = drivers.get(child.id);
  kid.finish();
  await new Promise(resolve => setImmediate(resolve));
  sessions.delegationResult(child.id, { consume: true, parentId: parent.id });
  // A collected reply counts as delivered even if no push completed.
  delete sessions.get(child.id).delegation.notifiedSeq;
  sessions.get(child.id).delegation.notifiedTurns = [];
  kid.push('status', { status: 'working' });
  kid.push('turn.start', { turnId: 'wake-update', text: '', wake: true });
  kid.push('item.start', { id: 'wake-reply', kind: 'text', turnId: 'wake-update' });
  kid.push('item.delta', { id: 'wake-reply', text: 'New verification.' });
  kid.push('turn.done', { turnId: 'wake-update', status: 'ok' });
  kid.push('status', { status: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  const tickets = sessions.history(parent.id).events.filter(e => e.type === 'turn.start' && String(e.turnId).startsWith(`local-result-${child.id}-`));
  assert.ok(tickets.every(e => !/New verification/.test(e.text)), 'the parent already has the result');
  assert.equal(drivers.get(parent.id).sent, 'Work');
  // Whoever reads the task still finds what it added.
  assert.match(sessions.delegationResult(child.id).output, /New verification/);
});

test('a child that wakes itself after reporting sends nothing more to its parent', async (context) => {
  const { sessions, drivers } = setup(context);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  const kid = drivers.get(child.id);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const tickets = () => sessions.history(parent.id).events.filter((event) => event.type === 'turn.start' && String(event.turnId).startsWith('local-result-'));
  kid.finish();
  await tick();
  assert.equal(tickets().length, 1);
  drivers.get(parent.id).finish();
  await tick();

  // The same turn closed again (older drivers did this on every wake-up).
  kid.push('turn.done', { turnId: kid.engineSessionId, status: 'ok' });
  await tick();
  assert.equal(tickets().length, 1, 'one report per turn');

  // A wake-up that says nothing new is not worth a message.
  kid.push('turn.start', { turnId: 'wake-quiet', text: '', wake: true });
  kid.push('turn.done', { turnId: 'wake-quiet', status: 'ok' });
  await tick();
  assert.equal(tickets().length, 1);

  // Nor is one that says something: stale watchers timing out were the
  // usual text. Real news goes by `helm say`, which waits for the parent.
  kid.push('turn.start', { turnId: 'wake-news', text: '', wake: true });
  kid.push('item.start', { id: 'news', kind: 'text', turnId: 'wake-news' });
  kid.push('item.delta', { id: 'news', text: 'Type check is clean; committed.' });
  kid.push('item.done', { id: 'news', status: 'ok' });
  kid.push('turn.done', { turnId: 'wake-news', status: 'ok' });
  await tick();
  assert.equal(tickets().length, 1, 'no turn for the parent after its result');
  assert.doesNotMatch(drivers.get(parent.id).sent, /Type check is clean/);

  // Whoever reads the task's result still gets the report and the update.
  const result = sessions.delegationResult(child.id);
  assert.match(result.output, /Opus reviewed the task\.[\s\S]*Type check is clean/);
});

test('a driver that closes one turn again sends one notice, counts it once, and a wake-up leaves the task as it was', async (context) => {
  const { sessions, drivers } = setup(context);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  const kid = drivers.get(child.id);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const tickets = () => sessions.history(parent.id).events.filter((event) => event.type === 'turn.start' && String(event.turnId).startsWith('local-result-'));
  kid.finish();
  await tick();
  drivers.get(parent.id).finish();
  await tick();
  const turns = () => sessions.get(child.id).turns;
  const before = { tickets: tickets().length, turns: turns(), cost: sessions.get(child.id).costUsd };
  assert.equal(before.tickets, 1);

  // The same turn closed again, by its id and with none at all.
  kid.push('turn.done', { turnId: kid.engineSessionId, status: 'ok', costUsd: 0.5 });
  kid.push('turn.done', { status: 'ok' });
  await tick();
  assert.equal(tickets().length, 1, 'one notice');
  assert.equal(turns(), before.turns, 'one more reply is not counted');
  assert.equal(sessions.get(child.id).costUsd, before.cost, 'the repeat costs nothing');

  // A turn the agent began itself under the CLI's own id: flagged, not named, as a wake-up.
  kid.push('status', { status: 'working' });
  kid.push('turn.start', { turnId: 'cli-turn-9', text: '', wake: true });
  assert.equal(sessions.get(child.id).delegation.status, 'working', 'it is working while it works');
  kid.push('turn.done', { turnId: 'cli-turn-9', status: 'error', error: 'background job failed' });
  kid.push('status', { status: 'idle' });
  await tick();
  const after = sessions.get(child.id);
  assert.equal(after.delegation.status, 'done', 'the task keeps the outcome it reported');
  assert.equal(after.turns, before.turns, 'a wake-up is not a reply');
  assert.equal(tickets().length, 1, 'nothing new to say, nothing sent');
  assert.equal(sessions.delegationResult(child.id).status, 'done');
});

test('legacy child results do not wake old threads on completion or daemon restart', async (context) => {
  const { sessions, drivers } = setup(context);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Old review' });
  delete sessions.get(child.id).delegation.notifyParent;
  drivers.get(child.id).finish('interrupted');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drivers.get(parent.id).sent, undefined);
  const restarted = new Sessions(new EventEmitter(), { makeDriver: () => assert.fail('historical results must not launch a CLI') });
  context.after(() => restarted.stop());
  await restarted.resume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.get(child.id).delegation.status, 'interrupted');
  assert.equal(restarted.history(parent.id).events.some((event) => String(event.turnId).startsWith('local-result-')), false);
});

test('an inherited parent cannot attach an unrelated Codex background thread', async (t) => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  await assert.rejects(() => sessions.delegate({ id: parent.id, callerThreadId: 'unrelated-memory-thread',
    profileId: 'claude-main', task: 'Inspect memories' }), /does not match.*parent/);
  assert.equal(drivers.size, 1, 'reject before starting a child');
  assert.equal(parent.delegations, undefined);
  const { session: child } = await sessions.delegate({ id: parent.id, callerThreadId: parent.engineSessionId,
    profileId: 'claude-main', task: 'Review this project' });
  assert.equal(child.delegation.parentId, parent.id);
});

test('archived tasks disappear from their parent list and badge without losing history', async (t) => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const other = await sessions.start({ cwd: parent.cwd, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  drivers.get(child.id).finish();
  const updates = [];
  sessions.on('session', (s) => updates.push(s));
  sessions.archive(child.id);
  assert.deepEqual(await sessions.list({ parentId: parent.id }), []);
  assert.deepEqual(await sessions.list({ parentId: other.id }), []);
  assert.deepEqual((await sessions.list()).find((s) => s.id === parent.id).delegations, []);
  assert.deepEqual(updates.findLast((s) => s.id === parent.id).delegations, []);
  assert.equal(sessions.delegationResult(child.id).output, 'Opus reviewed the task.');
  const restarted = new Sessions(new EventEmitter());
  t.after(() => restarted.stop());
  restarted.runtime.listLive = async () => new Map();
  assert.deepEqual(await restarted.list({ parentId: parent.id }), []);
  sessions.archive(child.id, false);
  assert.deepEqual((await sessions.list({ parentId: parent.id })).map((s) => s.id), [child.id]);
  assert.deepEqual(updates.findLast((s) => s.id === parent.id).delegations, [child.id]);
});

test('a long streamed reply survives event trimming and a daemon restart', async (t) => {
  const { sessions, drivers } = setup(t);
  const { session } = await sessions.delegate({ cwd: process.env.HELM_DIR, profileId: 'claude-main', task: 'Long review' });
  const d = drivers.get(session.id);
  for (let i = 0; i < 2100; i++) d.push('item.delta', { id: 'reply', text: 'x'.repeat(20) });
  d.finish();
  const restarted = new Sessions(new EventEmitter());
  t.after(() => restarted.stop());
  const result = restarted.delegationResult(session.id);
  assert.equal(result.complete, true);
  assert.equal(result.status, 'done');
  assert.equal(result.output, 'x'.repeat(32000));
  assert.equal(result.truncated, true);
  assert.equal('delegationReply' in result.session, false);
});

test('a refused model or permission mode fails before the task is sent', async (t) => {
  const { sessions, drivers } = setup(t, (opts) => {
    const d = new FakeDriver(opts);
    if (opts.cmd === process.execPath && opts.env.HELM_ENGINE === 'claude') {
      d.start = async () => d.push('settings', { mode: 'default', model: 'sonnet' });
    }
    return d;
  });
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  await assert.rejects(() => sessions.delegate({ id: parent.id, profileId: 'claude-main', model: 'opus', task: 'Inspect' }), /refused.*no task was sent/);
  assert.equal(parent.delegations, undefined);
  assert.equal([...drivers.values()].some((d) => d.sent), false);
});

test('a read-only parent stays read only across CLIs and cannot request a bypass', async (t) => {
  const { saveSubagentPrefs } = await import('../packages/connect/src/settings.js');
  saveSubagentPrefs(profiles[0], { mode: 'full' });
  t.after(() => saveSubagentPrefs(profiles[0], { mode: null }));
  const { sessions } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main', mode: 'readonly' });
  const { session } = await sessions.delegate({ id: parent.id, profileId: 'codex-main', task: 'Inspect' });
  assert.equal(session.mode, 'readonly');
  await assert.rejects(() => sessions.delegate({ id: parent.id, profileId: 'codex-main', mode: 'full', task: 'Write' }), /read-only/);
  await assert.rejects(() => sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Inspect' }), /no verified read-only/);
  assert.equal(delegationMode('codex', 'ask', 'full'), 'full');
  assert.throws(() => delegationMode('claude', 'full', 'plan'), /plan mode is not supported/);
  assert.throws(() => delegationMode('pi', 'readonly'), /no verified read-only/);
});

test('there is no machine-wide cap on running children', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { sessions } = setup(t, (opts) => {
    const d = new FakeDriver(opts); d.start = () => gate; return d;
  });
  const starts = Array.from({ length: 6 }, () => sessions.delegate({ cwd: process.env.HELM_DIR, profileId: 'claude-main', task: 'Inspect' }));
  release();
  const children = await Promise.all(starts);
  assert.equal(new Set(children.map((c) => c.session.id)).size, 6);
});

test('task messages remain scoped to their orchestrator and resume a completed child', async (t) => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const other = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Implement' });
  await assert.rejects(() => sessions.messageDelegation(other.id, child.id, 'Redirect'), /belong/);
  await assert.rejects(() => sessions.messageDelegation(parent.id, child.id, '  '), /message/);
  await sessions.messageDelegation(parent.id, child.id, 'Check edge cases');
  assert.equal(drivers.get(child.id).sent, 'Implement', 'a busy non-steerable engine queues rather than interrupts');
  drivers.get(child.id).finish();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(drivers.get(child.id).sent, 'Check edge cases');
  drivers.get(child.id).finish();
  await sessions.messageDelegation(parent.id, child.id, 'Now verify');
  assert.equal(drivers.get(child.id).sent, 'Now verify');
  assert.equal(child.delegation.parentId, parent.id);
});

test('configured restrictions and explicit choices survive default YOLO, without plan mode', async () => {
  assert.equal(delegationMode('claude', 'full', null, null, 'codex'), 'bypassPermissions');
  assert.equal(delegationMode('claude', 'ask', null, null, 'codex'), 'default');
  assert.equal(delegationMode('claude', 'full', null, 'acceptEdits', 'codex'), 'acceptEdits');
  assert.equal(delegationMode('claude', 'full', 'default', null, 'codex'), 'default');
});

test('helpers nest as deep as the task needs, and empty tasks fail before starting a CLI', async (t) => {
  const { sessions } = setup(t);
  await assert.rejects(() => sessions.delegate({ task: '' }), /task/);
  let parent = (await sessions.delegate({ cwd: process.env.HELM_DIR, profileId: 'claude-main', task: 'One' })).session;
  for (const task of ['Two', 'Three', 'Four', 'Five']) {
    parent = (await sessions.delegate({ id: parent.id, profileId: 'claude-main', task })).session;
  }
  assert.equal(parent.delegation.depth, 5);
});

test('helm delegate same runs the helper on the account this chat runs as', async () => {
  const calls = [];
  const rpc = async (_self, method, params) => {
    calls.push({ method, params });
    if (method === M.AGENT_LIST) return { agents: [{ id: 'codex-main', engine: 'codex', available: true }, { id: 'claude-main', engine: 'claude', available: true }] };
    if (method === M.SESSION_DELEGATE) return { session: { id: 'child', engine: 'claude', status: 'working' } };
    throw new Error(method);
  };
  await runAgentCommand('delegate', ['same', '--json', '--', 'Look around'], { rpc, self: 'me', parentId: 'parent', ownAccount: 'claude-main', write: () => {} });
  assert.equal(calls.find((c) => c.method === M.SESSION_DELEGATE).params.profileId, 'claude-main');
  await assert.rejects(() => runAgentCommand('delegate', ['same', '--', 'x'], { rpc, self: 'me', parentId: null, ownAccount: '', write: () => {} }), /works inside a Helm chat/);
});

test('delegation instructions keep only rules; the details live in helm delegate --help', async () => {
  const { commandHelp } = await import('../packages/connect/src/help.js');
  const note = delegationNote();
  assert.ok(note.length < 700, 'it rides along in every session');
  assert.equal(delegationNote(profiles), note);
  assert.equal(delegationNote([]), note);
  assert.match(note, /Do the work yourself by default/);
  assert.match(note, /never your CLI's own subagent tool/);
  assert.match(note, /open, message and stop it/);
  assert.match(note, /never unset HELM_SESSION_ID/);
  assert.match(note, /--model cheap/);
  assert.match(note, /Keep your helpers/);
  assert.match(note, /only test chats that are not helpers/);
  assert.doesNotMatch(note, /--heavy|slot|--worktree|--cwd/, 'flags are looked up, not carried');
  const help = commandHelp('delegate', '  helm delegate <account> -- "<task>"\n');
  for (const want of [/Use same for this chat's account/, /--cwd <folder>/, /--worktree/, /context for an hour/, /Keep finished helpers/]) assert.match(help, want);
});

test('no account by that name lists the accounts that do exist', () => {
  assert.throws(() => chooseAgent([{ id: 'claudes', engine: 'claude' }, { id: 'a1', engine: 'agy' }], 'pc'), /no CLI account "pc" here; accounts: claudes, a1/);
});

test('a child works in the folder the caller names, else where its parent does', async (t) => {
  const { sessions } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const elsewhere = `${process.env.HELM_DIR}/worktree`;
  const { session: child } = await sessions.delegate({ id: parent.id, cwd: elsewhere, profileId: 'claude-main', task: 'Review there' });
  assert.equal(child.cwd, elsewhere);
  const { session: here } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review here' });
  assert.equal(here.cwd, parent.cwd);
});

test('--worktree gives the child its own checkout on a helm/ branch, named after the task', async (t) => {
  const { sessions } = setup(t);
  const { execFileSync } = await import('node:child_process');
  const repo = join(process.env.HELM_DIR, 'repo');
  mkdirSync(repo, { recursive: true });
  const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  run('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'a.txt'), 'a'); run('add', 'a.txt'); run('commit', '-q', '-m', 'one');
  const parent = await sessions.start({ cwd: repo, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Fix the login bug\nin detail', worktree: true });
  assert.equal(child.delegation.worktree.branch, 'helm/fix-the-login-bug');
  assert.equal(child.delegation.worktree.base, 'main');
  assert.equal(child.cwd, child.delegation.worktree.path);
  assert.notEqual(child.cwd, repo);
  assert.ok(existsSync(join(child.cwd, 'a.txt')), 'the checkout has the files');
  await assert.rejects(() => sessions.delegate({ cwd: process.env.HELM_DIR, profileId: 'claude-main', task: 'Nope', worktree: true }), /not a git repository/);
  await assert.rejects(() => sessions.delegate({ id: parent.id, profileId: 'claude-main', mode: 'full', task: 'Refused task', worktree: true }), /invalid subagent mode/);
  assert.ok(!existsSync(`${repo}-refused-task`), 'a refused request leaves no checkout behind');
  assert.doesNotMatch(run('branch', '--list', 'helm/refused-task').toString(), /refused-task/);
});

test('helm delegate needs a parent chat; the parent folder wins unless --cwd names one', async () => {
  const calls = [];
  const rpc = async (_self, method, params) => {
    calls.push({ method, params });
    if (method === M.AGENT_LIST) return { agents: [{ id: 'claude-main', engine: 'claude', available: true }] };
    return { session: { id: 'child', engine: 'claude' } };
  };
  const run = (args, extra) => runAgentCommand('delegate', [...args, '--json', '--', 'Look'],
    { rpc, self: 'self', write: () => {}, sleep: async () => {}, ...extra });
  await run(['claude-main'], { parentId: 'parent' });
  assert.equal(calls.at(-1).params.cwd, undefined, 'inside a chat the parent folder wins');
  await run(['claude-main', '--cwd', '/worktree'], { parentId: 'parent' });
  assert.equal(calls.at(-1).params.cwd, '/worktree');
  assert.equal(calls.at(-1).params.worktree, undefined);
  await run(['claude-main', '--worktree'], { parentId: 'parent' });
  assert.equal(calls.at(-1).params.worktree, true);
  // From a plain shell or through helm exec, a helper had no chat to show it
  // or read its result, and its project copy broke once it was removed.
  const asked = calls.length;
  await assert.rejects(() => run(['claude-main', '--worktree'], { parentId: null }), /works inside a Helm chat only.*helm spawn/);
  assert.equal(calls.length, asked, 'nothing reaches Helm');
  await run(['claude-main', '--parent', 'chosen'], { parentId: null });
  assert.equal(calls.at(-1).params.id, 'chosen');
});

test('agents get the tool instructions as standing instructions, not in the owner\'s message', async (t) => {
  const { sessions, drivers } = setup(t);
  sessions.delegationBrief = (s) => `[helm delegation: use helm agents and helm delegate]${s?.delegation ? ` helper of ${s.delegation.parentId}` : ''}`;
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  // The brief once rode on the first message and showed in the owner's
  // bubble as if they had typed it. Codex and Claude take it out of band.
  assert.equal(drivers.get(parent.id).instructions, '[helm delegation: use helm agents and helm delegate]');
  await sessions.input(parent.id, '/status');
  assert.equal(drivers.get(parent.id).sent, '/status');
  drivers.get(parent.id).finish();
  // Only the short writing reminder rides on each message.
  await sessions.input(parent.id, 'Work');
  assert.equal(drivers.get(parent.id).sent, `Work\n\n${WRITING_REMINDER}`);
  drivers.get(parent.id).finish();
  await sessions.input(parent.id, 'Continue');
  assert.equal(drivers.get(parent.id).sent, `Continue\n\n${WRITING_REMINDER}`);
  const child = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  assert.equal(drivers.get(child.session.id).instructions, `${drivers.get(parent.id).instructions} helper of ${parent.id}`);
});

test('output distinguishes approval, interruption and provider failure', () => {
  assert.equal(delegationOutput({ status: 'blocked' }, []).status, 'blocked');
  for (const status of ['interrupted', 'error']) {
    const result = delegationOutput({}, [{ type: 'turn.start', turnId: 't' }, { type: 'turn.done', turnId: 't', status, error: 'failed' }]);
    assert.equal(result.status, status); assert.equal(result.error, 'failed'); assert.equal(result.complete, true);
  }
});

test('a completed task stays complete after a message was consumed during its turn', () => {
  const events = [
    { type:'turn.start', turnId:'provider-turn', text:'Review' },
    { type:'turn.start', turnId:'local-steering', text:'Check mobile too', queued:true },
    { type:'turn.accept', turnId:'local-steering' },
    { type:'item.start', id:'answer', kind:'text' },
    { type:'item.delta', id:'answer', text:'Review complete.' },
    { type:'turn.done', turnId:'provider-turn', status:'ok' },
    { type:'status', status:'idle' },
  ];
  const result = delegationOutput({ status:'idle', delegation:{status:'done'} }, events);
  assert.equal(result.status,'done');
  assert.equal(result.complete,true);
  assert.equal(result.output,'Review complete.');
  assert.equal(delegationOutput({status:'working',delegation:{status:'working'}},events).complete,false);
});

test('a restart closing a mid-task message does not make a working helper look finished', () => {
  // As logged on the laptop: the task, then a message sent mid-task, then a
  // restart that closed both tickets while the CLI's own turn ran on.
  const events = [
    { type:'turn.start', turnId:'local-task', text:'Measure startup' },
    { type:'turn.start', turnId:'provider-turn', text:'Measure startup' },
    { type:'item.start', id:'note', kind:'text' },
    { type:'item.delta', id:'note', text:'Reading the startup code now.' },
    { type:'turn.start', turnId:'local-note', text:'Avoid activeTurn' },
    { type:'turn.deliver', turnId:'local-note' },
    { type:'turn.accept', turnId:'local-note' },
    { type:'turn.done', turnId:'local-task', status:'ok' },
    { type:'turn.done', turnId:'local-note', status:'ok' },
  ];
  const result = delegationOutput({ status:'working', delegation:{status:'working'} }, events);
  assert.equal(result.complete, false);
  assert.equal(result.status, 'working');
  // Once the CLI's turn ends, it is finished as usual.
  const done = delegationOutput({ status:'idle', delegation:{status:'done'} },
    [...events, { type:'turn.done', turnId:'provider-turn', status:'ok' }]);
  assert.equal(done.complete, true);
});

test('a saved "done" does not end a helper whose own turn is still running', async t => {
  // Seen 2026-10-15: after a restart, `helm delegate-result --wait` said
  // done twice while the helper was still writing files. Its record said
  // done, but the CLI's own turn was open and the chat was working.
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  await sessions.input(parent.id, 'Work');
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Write the map' });
  const kid = drivers.get(child.id);
  sessions.get(child.id).delegation.status = 'done';
  const running = sessions.delegationResult(child.id);
  assert.equal(sessions.get(child.id).status, 'working');
  assert.equal(running.complete, false);
  assert.equal(running.status, 'working');
  kid.finish();
  const done = sessions.delegationResult(child.id);
  assert.equal(done.complete, true);
  assert.equal(done.status, 'done');
});

test('CLI flags do not leak into the task; literal task flags survive --', () => {
  const parsed = parseAgentArgs(['claude-main', '--model', 'opus', '--wait', '--', 'review', '--dangerously-skip-permissions'], { values: ['model'], switches: ['wait'] });
  assert.deepEqual(parsed.options, { model: 'opus', wait: true });
  assert.deepEqual(parsed.words, ['claude-main', 'review', '--dangerously-skip-permissions']);
  assert.throws(() => parseAgentArgs(['--model'], { values: ['model'] }), /needs a value/);
  assert.throws(() => parseAgentArgs(['--mystery']), /unknown option/);
  assert.throws(() => chooseAgent([{ id: 'claude-a', engine: 'claude' }, { id: 'claude-b', engine: 'claude' }], 'claude'), /ambiguous/);
});

test('--model cheap resolves to the account\'s small model, and fails plainly without one', async () => {
  const { cheapModel } = await import('../packages/connect/src/delegation.js');
  assert.equal(cheapModel('claude', ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-haiku-4-5']), 'claude-haiku-5-5');
  assert.equal(cheapModel('gemini', ['gemini-3.8-pro', 'gemini-3.8-flash']), 'gemini-3.8-flash');
  assert.equal(cheapModel('codex', ['gpt-6.1-sol', 'gpt-6-astra']), null);
  const calls = [];
  const rpc = async (_self, method, params) => {
    calls.push({ method, params });
    if (method === M.AGENT_LIST) return { agents: [
      { id: 'claude-main', engine: 'claude', available: true, cheapModel: 'claude-haiku-5-5', models: ['claude-haiku-5-5'] },
      { id: 'codex-main', engine: 'codex', available: true, cheapModel: null, models: ['gpt-6.1-sol'] },
    ] };
    if (method === M.SESSION_DELEGATE) return { session: { id: 'child', engine: 'claude', model: params.model } };
    return { status: 'done', complete: true, output: 'ok' };
  };
  const written = [];
  assert.equal(await runAgentCommand('delegate', ['claude-main', '--model', 'cheap', '--json', '--', 'Grep'], {
    rpc, self: 'self', write: (s) => written.push(s), sleep: async () => {},
  }), 0);
  assert.equal(calls[0].params.models, true);
  assert.equal(calls[1].params.model, 'claude-haiku-5-5');
  await assert.rejects(() => runAgentCommand('delegate', ['codex-main', '--model', 'cheap', '--', 'Grep'], {
    rpc, self: 'self', write: () => {}, sleep: async () => {},
  }), /no small model; choose one from: gpt-6.1-sol/);
});

test('CLI waits for the actual reply and reports pending approvals immediately', async () => {
  const calls = [], written = [];
  let reads = 0;
  const rpc = async (_self, method, params) => {
    calls.push({ method, params });
    if (method === M.AGENT_LIST) return { agents: [{ id: 'claude-main', engine: 'claude', available: true }] };
    if (method === M.SESSION_DELEGATE) return { session: { id: 'child', engine: 'claude', model: 'opus' } };
    return { session: { id: 'child' }, status: ++reads === 1 ? 'working' : 'done', complete: reads > 1, output: reads > 1 ? 'Reviewed.' : '' };
  };
  assert.equal(await runAgentCommand('delegate', ['claude-main', '--model', 'opus', '--wait', '--json', '--', 'Review'], {
    rpc, self: 'self', parentId: 'parent', callerThreadId: 'real-codex-thread', write: (s) => written.push(s), sleep: async () => {},
  }), 0);
  assert.equal(calls[1].params.id, 'parent');
  assert.equal(calls[1].params.callerThreadId, 'real-codex-thread');
  assert.equal(calls[1].params.model, 'opus');
  assert.equal(calls[1].params.task, 'Review');
  assert.deepEqual(calls.filter(c => c.method === M.SESSION_DELEGATION_RESULT).map(c => c.params), [
    { id: 'child', consume: true, parentId: 'parent', callerThreadId: 'real-codex-thread' },
    { id: 'child', consume: true, parentId: 'parent', callerThreadId: 'real-codex-thread' },
  ]);
  assert.equal(JSON.parse(written[0]).output, 'Reviewed.');
  assert.equal(await runAgentCommand('delegate-result', ['child', '--wait', '--json'], {
    rpc: async () => ({ status: 'blocked', complete: false, pending: { title: 'Allow read' } }), self: 'self', write: () => {},
    sleep: () => assert.fail('must not wait on approvals'),
  }), 2);
});

test('CLI --wait waits past five minutes and marks a timed-out reply as unfinished', async (t) => {
  let clock = Date.now(), reads = 0;
  const now = Date.now;
  Date.now = () => clock;
  t.after(() => { Date.now = now; });
  const rpc = async () => (++reads < 700
    ? { status: 'working', complete: false, output: 'Type check passes. Next I am adding tests.' }
    : { status: 'done', complete: true, output: 'All done.' });
  const written = [];
  assert.equal(await runAgentCommand('delegate-result', ['child', '--wait', '--json'], {
    rpc, self: 'self', parentId: 'parent', write: (s) => written.push(s), sleep: async (ms) => { clock += ms; },
  }), 0);
  assert.equal(reads, 700, 'no default limit: about twelve minutes of polling');
  assert.equal(JSON.parse(written[0]).output, 'All done.');
  reads = 0; written.length = 0;
  assert.equal(await runAgentCommand('delegate-result', ['child', '--wait', '--json', '--timeout', '5000'], {
    rpc, self: 'self', parentId: 'parent', write: (s) => written.push(s), sleep: async (ms) => { clock += ms; },
  }), 3);
  const late = JSON.parse(written[0]);
  assert.equal(late.timedOut, true);
  assert.equal(late.progress, 'Type check passes. Next I am adding tests.');
  assert.match(late.output, /^Not finished: child is still working/);
});

test('the real CLI discovers accounts and delegates through an authenticated relay', async (t) => {
  process.env.HELM_DB = join(process.env.HELM_DIR, 'relay.sqlite');
  const { startRelay } = await import('../apps/relay/src/server.js');
  const N = await import('@helm/protocol/network');
  const { Daemon } = await import('../packages/connect/src/agent.js');
  const { T } = await import('@helm/protocol');
  const { primeModels } = await import('../packages/connect/src/models.js');
  primeModels('codex', '~/.codex', null, { default: 'gpt-test', models: ['gpt-test'] });
  const largeCatalog = Array.from({ length: 6000 }, (_, i) => `catalog-model-${i}`);
  primeModels('claude', '~/.claude-test', null, { default: 'opus', models: ['opus', 'sonnet', ...largeCatalog],
    labels: { opus: 'Opus', [largeCatalog.at(-1)]: 'Last model', 'unlisted-model': 'Omit from this account' } });
  const hub = await startRelay({ port: 0, host: '127.0.0.1', openLogin: false });
  const port = hub.server.address().port;
  const net = N.createNetwork({ name: 'test-box', port });
  const { sessions } = setup(t, (opts) => {
    const d = new FakeDriver(opts);
    d.send = async (text) => { await FakeDriver.prototype.send.call(d, text); d.finish(); };
    return d;
  });
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const daemon = new Daemon({ name: 'test-box', port });
  daemon.sessions = sessions;
  const { InputDelivery } = await import('../packages/connect/src/input-delivery.js');
  const { AgentMessages } = await import('../packages/connect/src/agent-messages.js');
  daemon.inputDelivery = new InputDelivery(sessions);
  daemon.agentMessages = new AgentMessages({ sessions, delivery: daemon.inputDelivery, self: net.self, rpc: () => assert.fail('local messages only') });
  await daemon.dispatch(M.PROFILE_DEFAULTS, { profileId: 'claude-main', scope: 'subagent', model: 'sonnet', effort: 'high' });
  const helperOptions = await daemon.dispatch(M.MODEL_LIST, { profileId: 'claude-main' });
  assert.deepEqual(helperOptions.subagentDefaults, { model: 'sonnet', effort: 'high' });
  assert.equal(helperOptions.default, 'opus', 'helper defaults leave the normal picker unchanged');
  const lightweight = await daemon.dispatch(M.AGENT_LIST, { models: false });
  assert.deepEqual(lightweight.agents.find(a => a.id === 'claude-main').subagentDefaults, { model: 'sonnet', effort: 'high' });
  assert.equal(lightweight.agents.some(a => a.models), false, 'account lookup does not enumerate model catalogs');
  await daemon.dispatch(M.PROFILE_DEFAULTS, { profileId: 'claude-main', scope: 'subagent', model: null, effort: null });
  const env = new WebSocket(`ws://127.0.0.1:${port}/ws?role=self`, { headers: { authorization: `Bearer ${N.machineToken(net)}` } });
  env.on('message', async (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t !== T.RPC) return;
    try { env.send(JSON.stringify({ t: T.RPC_RESULT, id: msg.id, ok: true, result: await daemon.dispatch(msg.method, msg.params) })); }
    catch (error) { env.send(JSON.stringify({ t: T.RPC_RESULT, id: msg.id, ok: false, error: { message: error.message } })); }
  });
  try {
    await once(env, 'message');
    const bin = fileURLToPath(new URL('../packages/connect/bin/helm.js', import.meta.url));
    const invoke = (args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, HELM_SESSION_ID: parent.id, CODEX_THREAD_ID: parent.engineSessionId }, cwd: process.env.HELM_DIR });
      let out = '', err = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timed out')); }, 15_000);
      child.stdout.on('data', (text) => { out += text; });
      child.stderr.on('data', (text) => { err += text; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
    const discovered = await invoke(['agents', '--json']);
    assert.equal(discovered.code, 0, discovered.err);
    assert.ok(discovered.out.length > 100_000, 'a large JSON catalog must drain completely through stdout');
    const account = JSON.parse(discovered.out).agents.find((a) => a.id === 'claude-main');
    assert.ok(account);
    assert.equal(account.models.length, 6002);
    assert.equal(account.models.at(-1), largeCatalog.at(-1));
    assert.deepEqual(account.labels, { opus: 'Opus', [largeCatalog.at(-1)]: 'Last model' });
    assert.equal(discovered.out.includes('never-advertise-me'), false);
    const run = await invoke(['delegate', 'claude-main', '--model', 'opus', '--wait', '--json', '--', 'Review the changes']);
    assert.equal(run.code, 0, run.err);
    const result = JSON.parse(run.out);
    assert.equal(result.output, 'Opus reviewed the task.');
    assert.equal(result.session.delegation.parentId, parent.id);
    assert.equal(result.session.model, 'opus');
  } finally { env.terminate(); hub.stop(); }
});

test('agents are told which machine they are on and how to reach the others', async () => {
  const { helmBrief } = await import('../packages/connect/src/delegation.js');
  const net = { self: 'a', machines: {
    a: { id: 'a', name: 'Laptop' }, b: { id: 'b', name: 'VM', kind: 'vm' },
    c: { id: 'c', name: 'twin' }, d: { id: 'd', name: 'twin' },
  } };
  const brief = helmBrief(net);
  assert.match(brief, /running on Laptop/);
  assert.match(brief, /The others: VM \(vm\), twin\./, 'each name once; ssh can only reach one of them');
  assert.match(brief, /through helm \(helm exec, helm copy, helm spawn\), not SSH/);
  assert.match(brief, /helm <command> --help explains one/);
  assert.match(brief, /Never rerun a helm exec that may have started/);
  assert.match(brief, /--keep only when the owner asks/);
  assert.ok(brief.includes(delegationNote()));
  const alone = helmBrief({ self: 'a', machines: { a: net.machines.a } });
  assert.ok(alone.startsWith(delegationNote()), 'alone: nothing to reach');
  assert.match(alone, /\[Helm pickup: .*run helm pickup\.\]/, 'every agent learns where its handover goes');
  assert.match(alone, /helm render/, 'visual replies work even with one machine');
});

test('only a helper is told to report once and to use helm say afterwards', async () => {
  const { helmBrief, helperNote } = await import('../packages/connect/src/delegation.js');
  assert.doesNotMatch(helmBrief({}), /\[Helm helper:/);
  const brief = helmBrief({}, { parentId: 'abc123def456' });
  assert.ok(brief.startsWith(helperNote('abc123def456')));
  assert.match(brief, /Report once\./);
  assert.match(brief, /stale background watcher/);
  assert.match(brief, /helm say abc123def456 -- "text"/);
});

test('the browser note rides along only where a browser can start', async () => {
  const { helmBrief } = await import('../packages/connect/src/delegation.js');
  const { browserReady, browserNote } = await import('../packages/connect/src/browser.js');
  assert.equal(helmBrief({}).includes('[Helm browser:'), browserReady());
  assert.doesNotMatch(browserNote({ bowser: false }), /bowser/i, 'no pointer to a tool this machine lacks');
  assert.match(browserNote({ bowser: true }), /--engine bowser/);
});

// Every chat pays for these notes before it does any work, and every message
// carries the reminder. Lower the numbers when the text shrinks; raise them
// only when the owner wants the new text.
test('the notes every agent gets match the committed size', async () => {
  const { helmBrief } = await import('../packages/connect/src/delegation.js');
  const { browserNote } = await import('../packages/connect/src/browser.js');
  const { worktreeNote } = await import('../packages/connect/src/chat-worktree.js');
  const { readFileSync } = await import('node:fs');
  const budget = JSON.parse(readFileSync(new URL('./agent-context-budget.json', import.meta.url), 'utf8'));
  const net = { self: 'a', machines: { a: { id: 'a', name: 'Laptop' }, b: { id: 'b', name: 'VM', kind: 'vm' }, c: { id: 'c', name: 'HomePC', kind: 'pc' } } };
  // The browser note depends on this machine; count the version without Bowser.
  const brief = helmBrief(net, { parentId: 'abc123def456' }).split('\n').filter((l) => !l.startsWith('[Helm browser:')).join('\n');
  const notes = [brief, browserNote({ bowser: false }), worktreeNote({ chatWorktree: { base: 'main', repo: '/home/me/project' } })].join('\n');
  assert.deepEqual(
    { notesBytes: Buffer.byteLength(notes), reminderBytes: Buffer.byteLength(WRITING_REMINDER) },
    { notesBytes: budget.notesBytes, reminderBytes: budget.reminderBytes },
  );
});

test('a helper with no thread to sit under lists on its own, and its team nests under it', async (t) => {
  const { sessions, drivers } = setup(t);
  // `helm delegate` from a plain shell: no parent. Its own children have it as parent.
  const { session: lead } = await sessions.delegate({ cwd: process.env.HELM_DIR, profileId: 'codex-main', task: 'Lead the night' });
  const { session: helper } = await sessions.delegate({ id: lead.id, profileId: 'codex-main', task: 'Fix the mountains' });
  const top = await sessions.list();
  assert.equal(top.find((s) => s.id === lead.id)?.unhomed, true, 'a standalone lead must be listed');
  assert.equal(top.some((s) => s.id === helper.id), false, 'its helper sits under it, not beside it');
  assert.deepEqual((await sessions.list({ parentId: lead.id })).map((s) => s.id), [helper.id]);

  const { sessions: digest } = await sessions.digest();
  const line = digest.find((s) => s.id === lead.id);
  assert.ok(line, 'the digest shows the lead');
  assert.deepEqual(line.helpers.map((h) => [h.id, h.depth]), [[helper.id, 1]]);
  assert.equal(digest.some((s) => s.id === helper.id), false);

  // Archiving the lead orphans the helper, which then lists on its own.
  sessions.archive(lead.id);
  assert.equal((await sessions.list()).find((s) => s.id === helper.id)?.unhomed, true);

  // A finished orphan from more than a day ago drops out; `helm thread` still reaches it.
  drivers.get(helper.id).finish();
  await new Promise((r) => setImmediate(r));
  const record = sessions.get(helper.id);
  record.delegation.status = 'done';
  record.delegation.finishedAt = Date.now() - 25 * 60 * 60_000;
  assert.equal((await sessions.list()).some((s) => s.id === helper.id), false);
  assert.equal((await sessions.list({ includeDelegations: true })).some((s) => s.id === helper.id), true);
});


test('dismissed native failures stay in history and only a new failure alerts again', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  await sessions.input(parent.id, 'Review with helpers');
  const driver = drivers.get(parent.id);
  driver.push('subagent.status', { id: 'failed-helper', status: 'error' });
  driver.push('subagent.status', { id: 'busy-helper', status: 'working' });
  driver.push('permission.request', { requestId: 'approval', parentId: 'blocked-helper', kind: 'command', title: 'Run check?' });
  const history = sessions.events.tail(parent.id, 100);
  const updates = [];
  sessions.on('session', session => { if (session.id === parent.id) updates.push(structuredClone(session.team)); });
  const { session } = sessions.dismissChildFailures(parent.id);
  assert.deepEqual(session.team, { working: 1, blocked: 1, failed: 0 });
  assert.equal(session.dismissedNativeFailures, undefined, 'internal acknowledgement is not exposed on the wire');
  assert.equal(parent.nativeAgents['failed-helper'], 'error');
  assert.deepEqual(sessions.events.tail(parent.id, 100), history);
  assert.equal(sessions.events.pending(parent.id).length, 1);
  assert.deepEqual(updates.at(-1), session.team, 'every connected device gets the cleared count');
  driver.push('subagent.status', { id: 'failed-helper', status: 'error' });
  assert.equal(parent.team.failed, 0, 'a duplicate failure cannot revive the alert');
  driver.push('subagent.status', { id: 'failed-helper', status: 'working' });
  driver.push('subagent.status', { id: 'failed-helper', status: 'error' });
  assert.equal(parent.team.failed, 1, 'the same helper can raise a new failure');
});

test('dismissing nested delegated failures preserves results and a retry can fail again', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  const { session: grandchild } = await sessions.delegate({ id: child.id, profileId: 'claude-main', task: 'Nested review' });
  drivers.get(grandchild.id).finish('error');
  drivers.get(child.id).push('subagent.status', { id: 'native-error', status: 'error' });
  assert.equal(parent.team.failed, 2);
  const { session: before, ...result } = sessions.delegationResult(grandchild.id);
  sessions.dismissChildFailures(parent.id);
  assert.equal(parent.team.failed, 0);
  assert.equal(sessions.get(child.id).team.failed, 0);
  const { session: after, ...retained } = sessions.delegationResult(grandchild.id);
  assert.deepEqual(retained, result);
  assert.equal(after.delegation.status, before.delegation.status);
  assert.equal(sessions.get(grandchild.id).archived, undefined);
  const retry = drivers.get(grandchild.id);
  retry.engineSessionId = randomUUID();
  await sessions.messageDelegation(child.id, grandchild.id, 'Try again');
  retry.finish('error');
  assert.equal(parent.team.failed, 1, 'a later failed turn reaches every ancestor');
});


test('an orphaned background-command completion cannot become a failed native helper', async t => {
  let receive;
  const pipe = { onData: cb => { receive = cb; }, onExit: () => {}, detach: () => {} };
  const { ClaudeDriver } = await import('../packages/connect/src/drivers/claude.js');
  const driver = new ClaudeDriver({ cmd: 'unused', cwd: process.env.HELM_DIR,
    procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe }, openTurn: () => null, resumeEvents: () => [] });
  const events = [];
  driver.on('event', event => events.push(event));
  await driver.start();
  t.after(() => driver.suspend());
  receive(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'old-bash', tool_use_id: 'old-tool',
    status: 'failed', summary: 'Background command "npm run dev" failed with exit code 1' }) + '\n');
  assert.equal(events.filter(e => e.type === 'subagent.status').length, 0);
  assert.equal(events.find(e => e.type === 'item.update' && e.id === 'old-tool').agent.type, 'local_bash');
  assert.equal(events.find(e => e.type === 'item.done' && e.id === 'old-tool').status, 'error');
});

test('a direct agent exchange does not also wake the parent with a duplicate result', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  // Finish the original task normally, then the parent reads that result.
  drivers.get(child.id).finish();
  await new Promise(resolve => setImmediate(resolve));
  const before = sessions.history(parent.id).events.filter(e => e.type === 'turn.start').length;
  const d = drivers.get(child.id);
  d.engineSessionId = randomUUID(); // this fake uses the session ID as its next turn ID
  await sessions.input(child.id, 'A peer asks whether tests passed', { source: 'agent', delivery: 'queue' });
  d.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessions.history(parent.id).events.filter(e => e.type === 'turn.start').length, before);
  assert.ok(sessions.history(child.id).events.some(e => e.type === 'turn.start' && e.source === 'agent' && e.inputId));
});

test('reading five helper replies removes their real parent queue tickets without requeuing on retry',async t=>{
  const {AgentMessages}=await import('../packages/connect/src/agent-messages.js');
  const {InputDelivery}=await import('../packages/connect/src/input-delivery.js');
  const {sessions,drivers}=setup(t);
  const parent=await sessions.start({cwd:process.env.HELM_DIR,profileId:'codex-main'});
  await sessions.input(parent.id,'Keep working');
  const {session:child}=await sessions.delegate({id:parent.id,profileId:'claude-main',task:'Review'});
  const delivery=new InputDelivery(sessions,{dir:join(process.env.HELM_DIR,`receipts-${parent.id}`)});
  const messages=new AgentMessages({sessions,delivery,self:'local',dir:join(process.env.HELM_DIR,`messages-${parent.id}`),rpc:()=>assert.fail('local only')});
  const ids=Array.from({length:5},(_,i)=>(i+1).toString(16).padStart(32,'0'));
  for(const [n,messageId]of ids.entries())await messages.send({id:child.id,to:{env:'local',id:parent.id},text:`Update ${n}`,messageId});
  const tickets=sessions.events.tail(parent.id,0).filter(e=>e.type==='turn.start'&&e.source==='agent');
  assert.equal(tickets.length,5);assert.ok(tickets.every(e=>e.queued));
  drivers.get(child.id).finish();
  const read=await messages.collectResult({id:child.id,parentId:parent.id,consume:true});
  assert.equal(read.length,5);
  assert.ok(tickets.every(e=>sessions.turnState(parent.id,e.turnId)==='removed'));
  await messages.send({id:child.id,to:{env:'local',id:parent.id},text:'Update 0',messageId:ids[0]});
  assert.equal(sessions.events.tail(parent.id,0).filter(e=>e.type==='turn.start'&&e.source==='agent').length,5);
  assert.deepEqual(await messages.collectResult({id:child.id,parentId:parent.id,consume:true}),[]);
});

test('tour helpers stay visible and do not send their JSON to the parent', async t => {
  const { sessions, drivers } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const { session: child } = await sessions.delegate({ id: parent.id, profileId: 'codex-main', mode: 'readonly',
    task: 'Write a Git review tour.\n' + 'data '.repeat(7000), tour: true });
  assert.equal(sessions.get(child.id).delegation.notifyParent, false);
  assert.equal(sessions.get(child.id).delegation.codexFork, undefined);
  assert.equal(sessions.get(child.id).delegation.hidden, undefined);
  drivers.get(child.id).finish();
  assert.equal(sessions.delegationResult(child.id).status, 'done');
  assert.equal(drivers.get(parent.id).sent, undefined);
  assert.ok((await sessions.list({ parentId: parent.id })).some(s => s.id === child.id));
});
