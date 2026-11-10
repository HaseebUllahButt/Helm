import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// A helper on another machine (`helm delegate --machine`): it runs there,
// with that machine's accounts, and its card and result come back to the
// chat that asked. One Sessions plays both machines here; `remoteRpc`
// stands in for the network between them.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-remote-helpers-'));
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_PROCS_SOCKET = join(process.env.HELM_DIR, 'procs.sock');
process.env.HELM_TERMINALS_SOCKET = join(process.env.HELM_DIR, 'terminals.sock');
process.env.HELM_NATIVE_SOCKET = join(process.env.HELM_DIR, 'native.sock');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'codex-main', label: 'Codex', engine: 'codex', cmd: process.execPath, env: { CODEX_HOME: join(process.env.HELM_DIR, 'codex-home') }, source: 'custom' },
  { id: 'claude-opus', label: 'Claude', engine: 'claude', cmd: process.execPath, env: { CLAUDE_CONFIG_DIR: join(process.env.HELM_DIR, 'claude-home') }, source: 'custom' },
] }));
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { remoteHelperFolder } = await import('../packages/connect/src/session-delegation.js');
const { runAgentCommand } = await import('../packages/connect/src/agent-cli.js');
const { M } = await import('@helm/protocol');

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = randomUUID(); this.status = 'idle'; }
  async start() {}
  push(type, extra = {}) { if (type === 'status') this.status = extra.status; this.emit('event', { type, ...extra }); }
  async send(text) {
    this.sent = text;
    this.push('status', { status: 'working' });
    this.push('turn.start', { turnId: this.engineSessionId, text });
    this.push('item.start', { id: 'reply', kind: 'text', turnId: this.engineSessionId });
    this.push('item.delta', { id: 'reply', text: 'Opus on the laptop reviewed it.' });
  }
  finish(status = 'ok') {
    this.push('item.done', { id: 'reply', status });
    this.push('turn.done', { turnId: this.engineSessionId, status });
    this.push('status', { status: 'idle' });
  }
  async kill() { this.push('status', { status: 'exited' }); }
  async interrupt() { this.finish('interrupted'); }
}

function setup(t) {
  const drivers = new Map();
  const runtime = new EventEmitter();
  runtime.listLive = async () => new Map();
  const sessions = new Sessions(runtime, { makeDriver: (_engine, opts) => {
    const d = new FakeDriver(opts); drivers.set(opts.env.HELM_SESSION_ID, d); return d;
  } });
  // The VM holds the chat, the laptop the helper. Calls from the laptop
  // arrive at the VM as from 'laptop', and the other way round.
  const calls = [];
  sessions.selfId = 'laptop';
  sessions.remoteRpc = async (machine, method, params) => {
    calls.push({ machine, method, params });
    if (method === 'session.helper-state') return sessions.remoteHelperState('laptop', params);
    if (method === 'session.helper-result') return sessions.remoteHelperResult('laptop', params);
    if (method === 'session.interrupt') return sessions.interrupt(params.id);
    throw new Error(`unknown method: ${method}`);
  };
  t.after(async () => {
    for (const id of drivers.keys()) await sessions.kill(id).catch(() => {});
    await sessions.stop();
  });
  return { sessions, drivers, calls };
}

/** What `helm delegate --machine laptop` does on both machines. */
async function delegateAway(sessions, parent, task = 'Review on the laptop') {
  const { session } = await sessions.delegate({ profileId: 'claude-opus', task,
    remoteParent: { machine: 'vm', id: parent.id, engine: parent.engine, cwd: '/nowhere/project', home: '/nowhere', generation: parent.stopGeneration ?? 0 } });
  sessions.addRemoteHelper(parent.id, { machine: 'laptop', id: session.id, title: session.title, status: session.delegation.status });
  return session;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a helper on another machine counts under its chat and is no chat of its own there', async (t) => {
  const { sessions } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const child = await delegateAway(sessions, parent);
  assert.equal(sessions.get(child.id).delegation.parentMachine, 'vm');
  assert.equal(sessions.get(child.id).delegation.parentId, parent.id);
  assert.equal(sessions.get(child.id).cwd, homedir(), 'no such folder there: it works in that home');
  const listed = await sessions.list();
  assert.equal(listed.some((s) => s.id === child.id), false, 'its chat is on the other machine, so it is no sidebar row');
  const helpers = await sessions.list({ parentId: parent.id });
  assert.deepEqual(helpers.map((s) => s.id), [child.id], 'the panel of its chat still finds it there');
  sessions.remoteHelperState('laptop', { parentId: parent.id, helper: { id: child.id, title: child.title, status: 'working' } });
  assert.deepEqual(sessions.get(parent.id).team, { working: 1, blocked: 0, failed: 0 });
  assert.equal(sessions.hasActiveDelegations(parent.id), true);
  assert.throws(() => sessions.remoteHelperState('desktop', { parentId: parent.id, helper: { id: child.id, status: 'done' } }),
    /not a helper of that chat/, 'only the machine that runs it reports for it');
});

test('its result starts one parent turn, and a parent that read it first is not told again', async (t) => {
  const { sessions, drivers, calls } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const child = await delegateAway(sessions, parent);
  drivers.get(child.id).finish();
  await settle();
  assert.match(drivers.get(parent.id).sent ?? '', /Opus on the laptop reviewed it/);
  assert.match(drivers.get(parent.id).sent, /Machine: laptop\nStatus: done\nResult:\nOpus on the laptop reviewed it\.\nFull output: helm delegate-result /);
  const result = calls.find((call) => call.method === 'session.helper-result');
  assert.equal(result.machine, 'vm');
  const helper = sessions.get(parent.id).remoteHelpers[0];
  assert.equal(helper.status, 'done');
  assert.deepEqual(await sessions.remoteHelperResult('laptop', result.params), { ok: true, skipped: true }, 'a repeat is not a second turn');
  const tickets = sessions.history(parent.id).events.filter((e) => e.type === 'turn.start' && String(e.turnId).startsWith(`local-result-${child.id}-`));
  assert.equal(tickets.length, 1);

  // A second helper whose parent reads its result there (delegate-result --wait).
  const second = await delegateAway(sessions, parent, 'Second look');
  const ask = { consume: true, parentId: parent.id, parentMachine: 'vm' };
  assert.equal(sessions.delegationResult(second.id, ask).complete, false, 'the parent waits while it works');
  drivers.get(second.id).finish();
  await new Promise((resolve) => setImmediate(resolve));
  const read = sessions.delegationResult(second.id, { consume: true, parentId: parent.id, parentMachine: 'vm' });
  assert.equal(read.complete, true);
  assert.ok(read.consumedSeq > 0, 'the chat\'s machine learns what was read');
  sessions.remoteConsumed(sessions.get(parent.id), second.id, read.consumedSeq);
  await settle();
  assert.equal(sessions.history(parent.id).events.some((e) => String(e.turnId).startsWith(`local-result-${second.id}-`)), false);
  assert.equal(sessions.delegationResult(second.id, { consume: true, parentId: parent.id, parentMachine: 'desktop' }).consumedSeq, undefined,
    'another machine cannot take the result');
});

test('stopping the chat stops its helper on the other machine, and a failure there asks for the owner', async (t) => {
  const { sessions, calls } = setup(t);
  const parent = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'codex-main' });
  const child = await delegateAway(sessions, parent);
  sessions.remoteHelperState('laptop', { parentId: parent.id, helper: { id: child.id, status: 'working' } });
  await sessions.interrupt(parent.id);
  assert.ok(calls.some((call) => call.method === 'session.interrupt' && call.machine === 'laptop' && call.params.id === child.id));
  assert.equal(sessions.get(child.id).delegation.status, 'interrupted');
  assert.equal(sessions.get(parent.id).recovery.message, 'You stopped this chat. Helm also stopped its helper.');

  const failing = await delegateAway(sessions, parent, 'Will fail');
  sessions.remoteHelperState('laptop', { parentId: parent.id, helper: { id: failing.id, status: 'error', finishedAt: 5 } });
  assert.equal(sessions.get(parent.id).team.failed, 1);
  sessions.dismissChildFailures(parent.id);
  assert.equal(sessions.get(parent.id).team.failed, 0, 'seen once: it stops asking');
});

test('a helper from another machine works in the same project folder there, else in home', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-remote-folder-'));
  try {
    mkdirSync(join(root, 'Pictures', 'Helm'), { recursive: true });
    assert.equal(remoteHelperFolder({ cwd: '/home/vm/Pictures/Helm', home: '/home/vm' }, root), join(root, 'Pictures', 'Helm'));
    assert.equal(remoteHelperFolder({ cwd: '/home/vm/Other', home: '/home/vm' }, root), root);
    assert.equal(remoteHelperFolder({}, root), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('helm delegate --machine reads that machine\'s accounts and asks this chat\'s machine to start it', async () => {
  const calls = [];
  const rpc = async (env, method, params) => {
    calls.push({ env, method, params });
    if (method === M.AGENT_LIST) return { agents: [{ id: 'claude-opus', engine: 'claude', available: true }] };
    return { session: { id: 'child', engine: 'claude', machine: 'laptop-id' } };
  };
  const lines = [];
  const machine = (name) => ({ laptop: 'laptop-id', vm: 'self' })[name.toLowerCase()];
  const run = (args) => runAgentCommand('delegate', [...args, '--', 'Look'],
    { rpc, self: 'self', machine, parentId: 'parent', write: (line) => lines.push(line), sleep: async () => {} });
  await run(['claude-opus', '--machine', 'Laptop']);
  assert.deepEqual(calls.map((call) => [call.env, call.method]), [['laptop-id', M.AGENT_LIST], ['self', M.SESSION_DELEGATE]]);
  assert.equal(calls.at(-1).params.machine, 'laptop-id');
  assert.equal(calls.at(-1).params.id, 'parent');
  assert.match(lines.at(-1), /on Laptop/);
  await run(['claude-opus', '--machine', 'vm']);
  assert.equal(calls.at(-1).params.machine, undefined, 'this machine is a plain helper');
  await assert.rejects(() => run(['same', '--machine', 'Laptop']), /helm agents --machine Laptop/);
  calls.length = 0;
  await runAgentCommand('agents', ['--machine', 'laptop', '--json'], { rpc, self: 'self', machine, write: () => {} });
  assert.equal(calls[0].env, 'laptop-id');
});
