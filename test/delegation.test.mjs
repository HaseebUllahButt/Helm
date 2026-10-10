import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-delegation-'));
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const profiles = [
  { id: 'codex-main', label: 'Codex personal', engine: 'codex', cmd: process.execPath, source: 'custom' },
  { id: 'claude-main', label: 'Claude personal', engine: 'claude', cmd: process.execPath,
    env: { CLAUDE_CONFIG_DIR: '~/.claude-test', PRIVATE_TOKEN: 'never-advertise-me' }, args: ['--secret', 'never-advertise-me'], source: 'custom' },
];
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles }));
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { agentCatalog, parseAgentArgs, chooseAgent, delegationMode, delegationOutput, delegationNote } = await import('../packages/connect/src/delegation.js');
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
  t.after(async () => { for (const id of drivers.keys()) await sessions.kill(id).catch(() => {}); });
  return { sessions, drivers };
}

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
  assert.equal(restarted.get(child.id).delegation.parentId, parent.id);
  assert.equal(restarted.delegationResult(child.id).complete, true);
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
  assert.deepEqual(parent.team, { working: 0, blocked: 0, failed: 0 });
  await sessions.input(parent.id, 'A new user request');
  drivers.get(child.id).finish();
  drivers.get(grandchild.id).finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drivers.get(parent.id).sent, 'A new user request');
  assert.equal(sessions.history(parent.id).events.some((event) => String(event.turnId).startsWith('local-result-')), false);
  assert.equal(sessions.get(child.id).delegation.status, 'interrupted');
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

test('a wake-up after a collected result sends only its new update', async t => {
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
  const ticket = sessions.history(parent.id).events.findLast(e => e.type === 'turn.start' && String(e.turnId).startsWith(`local-result-${child.id}-`));
  assert.match(ticket.text, /added an update[\s\S]*New verification/);
  assert.doesNotMatch(ticket.text, /Opus reviewed the task/);
});

test('a child that wakes itself after reporting sends only what is new, never the report again', async (context) => {
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

  // One that does is sent alone, without the report it already sent.
  kid.push('turn.start', { turnId: 'wake-news', text: '', wake: true });
  kid.push('item.start', { id: 'news', kind: 'text', turnId: 'wake-news' });
  kid.push('item.delta', { id: 'news', text: 'Type check is clean; committed.' });
  kid.push('item.done', { id: 'news', status: 'ok' });
  kid.push('turn.done', { turnId: 'wake-news', status: 'ok' });
  await tick();
  assert.equal(tickets().length, 2);
  const update = drivers.get(parent.id).sent;
  assert.match(update, /added an update/);
  assert.match(update, /Type check is clean; committed\./);
  assert.doesNotMatch(update, /Opus reviewed the task/);

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

test('nesting is bounded and empty tasks fail before starting a CLI', async (t) => {
  const { sessions } = setup(t);
  await assert.rejects(() => sessions.delegate({ task: '' }), /task/);
  let parent = (await sessions.delegate({ cwd: process.env.HELM_DIR, profileId: 'claude-main', task: 'One' })).session;
  parent = (await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Two' })).session;
  parent = (await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Three' })).session;
  await assert.rejects(() => sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Four' }), /three levels/);
});

test('delegation instructions stay compact and independent of the account roster', () => {
  const note = delegationNote();
  assert.ok(note.length < 1000);
  assert.equal(delegationNote(profiles), note);
  assert.equal(delegationNote([]), note);
  assert.match(note, /Do the work yourself by default/);
  assert.match(note, /own subagents/);
  assert.match(note, /only when the owner asks for it or the work needs another CLI or account/);
  assert.match(note, /--model cheap/);
  assert.match(note, /helm agents --json only when needed/);
  assert.match(note, /helm delegate <account> --model <model> --wait --json/);
  assert.match(note, /helm run --heavy/);
  assert.match(note, /Inspect package scripts/);
});

test('agents get the tool instructions as standing instructions, not in the owner\'s message', async (t) => {
  const { sessions, drivers } = setup(t);
  sessions.delegationBrief = () => '[helm delegation: use helm agents and helm delegate]';
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  // The brief once rode on the first message and showed in the owner's
  // bubble as if they had typed it. Codex and Claude take it out of band.
  assert.equal(drivers.get(parent.id).instructions, '[helm delegation: use helm agents and helm delegate]');
  await sessions.input(parent.id, '/status');
  assert.equal(drivers.get(parent.id).sent, '/status');
  drivers.get(parent.id).finish();
  await sessions.input(parent.id, 'Work');
  assert.equal(drivers.get(parent.id).sent, 'Work');
  drivers.get(parent.id).finish();
  await sessions.input(parent.id, 'Continue');
  assert.equal(drivers.get(parent.id).sent, 'Continue');
  const child = await sessions.delegate({ id: parent.id, profileId: 'claude-main', task: 'Review' });
  assert.equal(drivers.get(child.session.id).instructions, drivers.get(parent.id).instructions);
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
  assert.match(brief, /helm exec <machine>/);
  assert.match(brief, /managed connection; prefer it to SSH/);
  assert.ok(brief.endsWith(delegationNote()));
  assert.equal(helmBrief({ self: 'a', machines: { a: net.machines.a } }), delegationNote(), 'alone: nothing to reach');
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
