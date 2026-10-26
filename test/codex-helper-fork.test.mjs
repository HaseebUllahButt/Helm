import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect } from './helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'helm-helper-fork-'));
process.env.HELM_DIR = root;
test.after(() => rmSync(root, { recursive: true, force: true }));
const { CodexDriver } = await import('../packages/connect/src/drivers/codex.js');

async function setup(t, { rejectFork = false, holdTurn = false } = {}) {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const socket = join(root, `daemon-${Math.random().toString(36).slice(2)}.sock`);
  const requests = [], threads = new Map();
  let next = 0, turn = 0;
  const completions = [];
  ws.on('connection', client => {
    const owned = new Set();
    client.on('close', () => { for (const id of owned) if (threads.get(id)?.ephemeral) threads.delete(id); });
    client.on('message', raw => {
    const request = JSON.parse(String(raw));
    requests.push(request);
    if (request.id == null) return;
    const { method, params = {} } = request;
    let result = {}, error;
    if (method === 'thread/fork' || method === 'thread/start') {
      if (method === 'thread/fork' && rejectFork) error = { message: 'Cannot fork this chat.' };
      else {
        const thread = { id: `child-${++next}`, ephemeral: method === 'thread/fork', status: { type: 'idle' }, turns: [] };
        threads.set(thread.id, thread);
        owned.add(thread.id);
        result = { thread, model: params.model ?? 'default-model', approvalPolicy: params.approvalPolicy, sandbox: params.sandbox };
      }
    } else if (method === 'thread/read' || method === 'thread/resume') {
      const thread = threads.get(params.threadId);
      if (!thread) error = { message: 'no rollout found for thread id ' + params.threadId };
      else if (method === 'thread/read' && params.includeTurns && thread.ephemeral) error = { message: 'ephemeral threads do not support includeTurns' };
      else result = { thread, model: 'helper-model' };
    } else if (method === 'config/read') result = { config: { model: 'default-model' } };
    else if (method === 'turn/start') {
      if (!threads.has(params.threadId)) error = { message: 'thread not found' };
      else {
        result = { turn: { id: `turn-${++turn}`, status: 'inProgress' } };
        threads.get(params.threadId).status = { type: 'active', activeFlags: [] };
        threads.get(params.threadId).turns = [{ ...result.turn, items: [] }];
      }
    }
    client.send(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }));
    if (method === 'turn/start' && !error) {
      const threadId = params.threadId, turnId = result.turn.id;
      const emit = (method, extra) => client.send(JSON.stringify({ method, params: { threadId, turnId, ...extra } }));
      const complete = () => {
        if (client.readyState !== 1) return;
        emit('item/started', { item: { type: 'userMessage', id: 'user-' + turnId, content: params.input } });
        emit('item/started', { item: { type: 'agentMessage', id: 'reply-' + turnId } });
        emit('item/agentMessage/delta', { itemId: 'reply-' + turnId, delta: 'Own reply.' });
        emit('item/completed', { item: { type: 'agentMessage', id: 'reply-' + turnId, text: 'Own reply.' } });
        emit('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 200000 }, last: { inputTokens: 11000, cachedInputTokens: threads.get(threadId).ephemeral ? 10000 : 0, outputTokens: 5 } } });
        threads.get(threadId).status = { type: 'idle' };
        threads.get(threadId).turns = [{ id: turnId, status: 'completed', items: [] }];
        emit('turn/completed', { turn: { id: turnId, status: 'completed' } });
      };
      if (holdTurn) completions.push(complete); else setImmediate(complete);
    }
    });
  });
  await new Promise(resolve => http.listen(socket, resolve));
  const drivers = [];
  let held = null, receive = null, exited = null;
  const buffered = [], starts = [];
  const host = {
    hasProc: () => held && held.exitCode === null && !held.killed,
    async openProc(id, spec) {
      starts.push(spec);
      held = spawn(spec.cmd, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      held.stdout.on('data', data => { if (receive) receive(String(data)); else buffered.push(String(data)); });
      held.once('exit', code => exited?.({ code }));
      await once(held, 'spawn');
    },
    procPipe: () => ({
      onData(callback) { receive = callback; while (buffered.length) receive(buffered.shift()); },
      onExit(callback) { exited = callback; },
      write(data) { held.stdin.write(data); },
      detach() { receive = null; },
      end() { held.stdin.end(); },
      kill() { held.kill(); },
    }),
    async lose() {
      const child = held;
      if (child && child.exitCode === null) {
        const ended = once(child, 'exit');
        child.kill();
        await ended;
      }
      for (const [id, thread] of threads) if (thread.ephemeral) threads.delete(id);
    },
  };
  t.after(async () => {
    for (const driver of drivers) await driver.kill();
    await host.lose();
    for (const client of ws.clients) client.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => http.close(resolve));
  });
  const make = (extra = {}) => {
    const driver = new CodexDriver({ cmd: 'unused', env: { CODEX_HOME: root }, cwd: root,
      model: 'helper-model', mode: 'readonly', instructions: 'New helper instructions', procHost: host,
      helperFork: { threadId: 'parent', nativeSocket: socket, note: 'You are a helper.' }, ...extra });
    drivers.push(driver);
    return { driver, log: collect(driver) };
  };
  return { make, requests, threads, host, starts, release: () => completions.splice(0).forEach(complete => complete()) };
}

const history = [
  { type: 'turn.start', turnId: 'old-turn', text: 'Inspect only the helper task.' },
  { type: 'item.start', turnId: 'old-turn', id: 'tool', kind: 'command', name: 'exec', input: { command: 'echo saved' } },
  { type: 'item.done', id: 'tool', output: 'saved result', status: 'ok' },
  { type: 'item.start', turnId: 'old-turn', id: 'reply', kind: 'text' },
  { type: 'item.delta', id: 'reply', text: 'Saved helper reply.' },
  { type: 'turn.done', turnId: 'old-turn', status: 'ok' },
];

test('a helper forks on the shared daemon and reconnects to the same live chat after Helm restarts', async t => {
  const { make, requests, threads, starts } = await setup(t);
  const first = make();
  await first.driver.send('Inspect.');
  const done = await first.log.until(e => e.type === 'turn.done');
  const id = first.driver.engineSessionId;
  assert.equal(done.usage.cacheRead, 10000);
  const fork = requests.find(r => r.method === 'thread/fork').params;
  assert.equal(fork.threadId, 'parent');
  assert.equal(fork.ephemeral, true);
  assert.equal(fork.excludeTurns, true);
  assert.equal(fork.developerInstructions, undefined);
  assert.equal(fork.model, 'helper-model');
  assert.equal(fork.sandbox, 'read-only');
  assert.match(starts[0].args[0], /helm-codex-proxy\.js$/);
  assert.equal(starts[0].args[1], first.driver.nativeSocket);
  const input = requests.find(r => r.method === 'turn/start').params.input;
  assert.deepEqual(input.map(i => i.text), ['You are a helper.', 'Inspect.']);
  assert.deepEqual(first.log.of('turn.start').map(e => e.text), ['Inspect.']);
  threads.get(id).turns = [{ id: 'copied-parent-turn', items: [
    { type: 'collabAgentToolCall', id: 'parent-agent', tool: 'spawn_agent', agentsStates: { 'parent-child': { status: 'running' } } },
  ] }];
  await first.driver.suspend();
  const second = make({ engineSessionId: id, resumeEvents: () => first.log.events });
  await second.driver.send('Continue.');
  await second.log.until(e => e.type === 'turn.done');
  assert.equal(second.driver.engineSessionId, id);
  assert.equal(starts.length, 1, 'the same native connection survived the Helm restart');
  assert.equal(requests.filter(r => r.method === 'thread/fork').length, 1);
  assert.equal(requests.filter(r => r.method === 'thread/start').length, 0);
  assert.equal(second.log.of('subagent.status').length, 0);
  assert.deepEqual(requests.filter(r => r.method === 'turn/start').at(-1).params.input.map(i => i.text), ['Continue.']);
});

test('a failed fork uses a new saved chat and sends the helper task once', async t => {
  const { make, requests } = await setup(t, { rejectFork: true });
  const { driver, log } = make();
  await driver.send('Inspect.');
  await log.until(e => e.type === 'turn.done');
  assert.deepEqual(requests.filter(r => ['thread/fork', 'thread/start'].includes(r.method)).map(r => r.method), ['thread/fork', 'thread/start']);
  assert.equal(requests.find(r => r.method === 'thread/start').params.ephemeral, undefined);
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
});

test('a lost helper context becomes a saved chat seeded only from its own history', async t => {
  const { make, requests } = await setup(t);
  const { driver, log } = make({ engineSessionId: 'lost-helper', resumeEvents: () => history });
  await driver.send('Continue the checks.');
  await log.until(e => e.type === 'turn.done');
  assert.notEqual(driver.engineSessionId, 'lost-helper');
  assert.equal(requests.some(r => r.method === 'thread/fork'), false);
  const input = requests.find(r => r.method === 'turn/start').params.input.map(i => i.text).join('\n');
  assert.match(input, /Continue this helper chat/);
  assert.match(input, /Saved helper reply/);
  assert.match(input, /saved result/);
  assert.match(input, /echo saved/);
  assert.match(input, /Continue the checks/);
  assert.deepEqual(log.of('turn.start').map(e => e.text), ['Continue the checks.']);
});

test('a helper that lost an active turn continues automatically and closes that same Helm turn', async t => {
  const { make, requests } = await setup(t);
  const { driver, log } = make({ engineSessionId: 'lost-helper', resumeEvents: () => history.slice(0, -1), openTurn: () => 'old-turn' });
  await driver.start();
  const done = await log.until(e => e.type === 'turn.done');
  assert.equal(done.turnId, 'old-turn', JSON.stringify(log.events));
  assert.equal(log.of('turn.start').length, 0);
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
});

test('losing the held connection recovers the same helper through a new saved Codex chat', async t => {
  const { make, host, requests, starts } = await setup(t);
  const { driver, log } = make();
  driver.resumeEvents = () => log.events;
  await driver.send('First task.');
  await log.until(e => e.type === 'turn.done');
  const firstId = driver.engineSessionId;
  await host.lose();
  await driver.send('Continue after the host restart.');
  await log.until(e => e.type === 'turn.done' && e.turnId === 'turn-2');
  assert.notEqual(driver.engineSessionId, firstId);
  assert.equal(starts.length, 2);
  const last = requests.filter(r => r.method === 'turn/start').at(-1).params.input.map(i => i.text).join('\n');
  assert.match(last, /First task/);
  assert.match(last, /Own reply/);
  assert.match(last, /Continue after the host restart/);
  assert.equal(requests.filter(r => r.method === 'thread/start').length, 1);
});

test('a helper approval remains answerable through its held connection after Helm restarts', async t => {
  const { make, threads, requests } = await setup(t);
  const first = make();
  await first.driver.start();
  const id = first.driver.engineSessionId;
  first.driver.onServerRequest({ id: 'helper-approval', method: 'item/commandExecution/requestApproval', params: {
    threadId: id, turnId: 'blocked-turn', itemId: 'command', command: 'echo safe', availableDecisions: ['accept', 'cancel'],
  } });
  threads.get(id).status = { type: 'active', activeFlags: ['waitingOnApproval'] };
  await first.driver.suspend();
  const second = make({ engineSessionId: id, resumeEvents: () => first.log.events,
    pendingEvents: () => first.log.of('permission.request') });
  await second.driver.start();
  assert.equal(second.driver.pending.size, 1);
  await second.driver.answer('helper-approval', { option: 'allow' });
  // A read confirms that the reply has crossed the pipe before inspecting it.
  await second.driver.start();
  assert.ok(requests.some(r => r.id === 'helper-approval' && r.result?.decision === 'accept'));
});

test('a restored active helper keeps its visible turn through another Helm restart', async t => {
  const { make, release, requests } = await setup(t, { holdTurn: true });
  const first = make({ engineSessionId: 'lost-helper', resumeEvents: () => history.slice(0, -1), openTurn: () => 'old-turn' });
  await first.driver.start();
  const saved = [...history.slice(0, -1), ...first.log.events];
  assert.ok(saved.some(e => e.type === 'turn.recover' && e.turnId === 'old-turn'));
  await first.driver.suspend();
  const second = make({ engineSessionId: first.driver.engineSessionId, resumeEvents: () => saved, openTurn: () => 'old-turn' });
  await second.driver.start();
  release();
  const done = await second.log.until(e => e.type === 'turn.done');
  assert.equal(done.turnId, 'old-turn');
  assert.equal(second.log.of('turn.start').length, 0);
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1);
});
