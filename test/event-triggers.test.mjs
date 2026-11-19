import './automation-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Schedules } from '../packages/connect/src/schedules.js';
import { ExecutionJobs } from '../packages/connect/src/execution.js';
import { checkCommand, fileFingerprint } from '../packages/connect/src/trigger-sources.js';

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'helm-triggers-'));
  let time = Date.now(), scheduler;
  const jobs = new Map(), sent = [], notices = [];
  const executions = {
    start(spec, owner, { stdin }) { if (!jobs.has(spec.id)) jobs.set(spec.id, { spec, owner, stdin, exitCode: 0 }); },
    async read({ id }, owner) {
      assert.equal(jobs.get(id).owner, owner);
      return { status: 'exited', exitCode: jobs.get(id).exitCode };
    },
  };
  const options = { directory, now: () => time, triggers: {
    executions, self: 'self', machineName: id => ({ self: 'Here', peer: 'Peer' })[id],
    notify: record => notices.push(record.id), account: async () => 'fake',
    ...overrides,
  } };
  const restore = () => { scheduler?.stop(); return scheduler = new Schedules(options); };
  t.after(() => { scheduler?.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, jobs, sent, notices, options, restore, advance: ms => { time += ms; },
    get scheduler() { return scheduler ?? restore(); } };
}

const save = async (scheduler, event, options = {}) => (await scheduler.save({
  type: 'event', event, cooldownSeconds: 1, command: 'true', ...options,
})).schedule;
const latest = scheduler => scheduler.list().schedules[0];

test('a file or glob starts a command only for a new change across restart', async t => {
  const f = fixture(t), path = join(f.directory, 'watch.log');
  writeFileSync(path, 'first');
  await save(f.scheduler, { kind: 'file-change', path: join(f.directory, '*.log'), pattern: true });
  assert.equal(f.jobs.size, 0);
  writeFileSync(path, 'second');
  f.advance(5000);
  await f.scheduler.triggers.tick();
  assert.equal(f.jobs.size, 1);
  assert.equal(latest(f.scheduler).lastResult.state, 'succeeded');
  const restored = f.restore();
  await restored.triggers.tick();
  assert.equal(f.jobs.size, 1);
  rmSync(path);
  f.advance(5000);
  await restored.triggers.tick();
  assert.equal(f.jobs.size, 2);
  assert.equal(latest(restored).event.kind, 'file-change');
  assert.equal('sample' in latest(restored), false);
});

test('file fingerprints include additions, edits and removals', async t => {
  const f = fixture(t), path = join(f.directory, 'file.txt'), pattern = join(f.directory, '*.txt');
  for (const [target, isGlob] of [[path, false], [pattern, true]]) {
    const missing = await fileFingerprint(target, isGlob);
    writeFileSync(path, 'one');
    const added = await fileFingerprint(target, isGlob);
    assert.notEqual(added, missing);
    writeFileSync(path, 'a larger file');
    const changed = await fileFingerprint(target, isGlob);
    assert.notEqual(changed, added);
    rmSync(path);
    assert.equal(await fileFingerprint(target, isGlob), missing);
  }
});

test('command checks compare output and exit code and keep their interval after restart', async t => {
  let sample = '[0,"first"]', calls = 0, checked;
  const f = fixture(t, { probe: async () => { calls++; checked.emit('sample'); return sample; } });
  checked = new EventEmitter();
  const checkedOnce = new Promise(resolve => checked.once('sample', resolve));
  await save(f.scheduler, { kind: 'command-change', check: 'printf first', everyMinutes: 1 });
  await checkedOnce;
  await f.scheduler.triggers.tick();
  assert.equal(f.jobs.size, 0);
  sample = '[0,"next"]';
  const restored = f.restore();
  f.advance(59_000);
  await restored.triggers.tick();
  assert.equal(calls, 1);
  f.advance(1000);
  await restored.triggers.tick();
  assert.equal(f.jobs.size, 1);
  sample = '[2,"next"]';
  f.advance(60_000);
  await restored.triggers.tick();
  assert.equal(f.jobs.size, 2);
  assert.match([...f.jobs.values()][1].stdin.toString(), /Exit code 2/);
});

test('the real command checker compares all output and accepts a nonzero exit code', async t => {
  if (process.platform === 'win32') return t.skip('Uses POSIX shell commands.');
  const f = fixture(t), signal = new AbortController().signal;
  const a = await checkCommand('printf same; printf err >&2; exit 2', f.directory, signal);
  const b = await checkCommand('printf err >&2; printf same; exit 2', f.directory, signal);
  const c = await checkCommand('printf different; printf err >&2; exit 2', f.directory, signal);
  const d = await checkCommand('printf same; printf err >&2; exit 3', f.directory, signal);
  assert.equal(JSON.parse(a)[0], 2);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test('a hook accepts a private POST, preserves body bytes, limits repeats and keeps its address', async t => {
  if (process.platform === 'win32') return t.skip('Uses POSIX shell commands.');
  const f = fixture(t);
  const executions = new ExecutionJobs({ directory: join(f.directory, 'jobs') });
  f.options.triggers.executions = executions;
  f.options.shareName = 'hooks-test';
  t.after(() => executions.stop());
  const { scheduler } = f;
  const resultPath = join(f.directory, 'post.out');
  await save(scheduler, { kind: 'webhook' }, { command: `cat > '${resultPath}'` });
  const view = latest(scheduler), url = view.webhook.localUrl;
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(`${url}a`, { method: 'POST' })).status, 404);
  const body = Buffer.from([0, 3, 128, 10]);
  const post = (key, data = body) => fetch(url, { method: 'POST', headers: { 'Idempotency-Key': key, Connection: 'close' }, body: data });
  assert.equal((await post('large', 'x'.repeat(16385))).status, 413);
  assert.equal((await post('example')).status, 202);
  assert.equal((await post('next')).status, 429);
  const runId = latest(scheduler).dispatching;
  const restored = f.restore();
  await restored.listen();
  assert.equal(latest(restored).webhook.localUrl, url);
  assert.equal((await (await post('example')).json()).duplicate, true);
  const owner = `helm-trigger-${view.id}-${runId}`;
  let page;
  do {
    page = await executions.read({ id: runId, since: page?.last, wait: 1000 }, owner);
  } while (page.status !== 'exited');
  executions.retainMs = 0;
  await restored.triggers.tick();
  assert.deepEqual(readFileSync(resultPath), body);
  assert.equal(latest(restored).lastResult.state, 'succeeded');
  assert.equal('path' in restored.list(null, false).schedules[0].webhook, false);
  assert.equal('receipts' in latest(restored), false);
});

test('chat starts reuse the same saved turn and report the final result', async t => {
  const f = fixture(t), chats = new Map(), log = [];
  f.options.sessions = {
    findAutomationSession: id => chats.get(id),
    async start(options) {
      const chat = { id: 'result-chat' };
      chats.set(options.originAutomationId, chat);
      assert.equal(options.profileId, 'fake');
      assert.equal(options.quick, true);
      return chat;
    },
    events: { tail: () => log, turnState: () => log.length ? 'open' : null },
    async input(id, text, { turnId }) {
      f.sent.push(text);
      log.push({ type: 'turn.start', turnId });
      f.scheduler.stop();
    },
  };
  const { scheduler } = f;
  const hook = await save(scheduler, { kind: 'webhook' }, { command: null, prompt: 'Read the update' });
  const token = latest(scheduler).webhook.path.split('/').at(-1);
  await scheduler.receive(hook.id, token, { body: 'body sample' });
  await scheduler.triggers.tick();
  assert.deepEqual(f.sent, ['Read the update\n\nWebhook body (input data):\nbody sample']);
  const restored = f.restore();
  await restored.triggers.tick();
  assert.equal(chats.size, 1);
  assert.equal(f.sent.length, 1);
  log.push({ type: 'turn.start', inputId: log[0].turnId, turnId: 'provider-turn' },
    { type: 'turn.done', turnId: 'provider-turn', status: 'ok' });
  await restored.triggers.tick();
  assert.equal(latest(restored).lastResult.state, 'succeeded');
  assert.equal(latest(restored).lastSessionId, 'result-chat');
});

test('chat and helper events suppress repeats, cool down, and avoid a trigger loop', async t => {
  const f = fixture(t), { scheduler } = f;
  const { id } = await save(scheduler, { kind: 'chat-finished' });
  const helper = { id: 'helper-1', delegation: { status: 'done' } };
  const done = { seq: 42, at: f.options.now(), status: 'ok' };
  scheduler.triggers.observeChat(helper, done);
  await scheduler.triggers.tick();
  assert.equal(f.jobs.size, 1);
  scheduler.triggers.observeChat({ id: 'chat-1' }, done);
  assert.equal(f.jobs.size, 1);
  const restored = f.restore();
  f.advance(1000);
  restored.triggers.observeChat(helper, done);
  restored.triggers.observeChat({ id: 'loop', originAutomationId: `helm-trigger-${id}-sample` }, done);
  await restored.triggers.tick();
  assert.equal(f.jobs.size, 1);
  restored.triggers.observeChat(helper, { ...done, seq: 43 });
  await restored.triggers.tick();
  assert.equal(f.jobs.size, 2);
});

test('a native chat completion uses saved working state once after restart', async t => {
  const f = fixture(t), { scheduler } = f;
  await save(scheduler, { kind: 'chat-finished', chatId: 'abcdef' });
  const chat = { id: 'abcdef012345', nativeChat: true, updatedAt: f.options.now(), status: 'working' };
  scheduler.triggers.observeNative(chat);
  const restored = f.restore();
  const idle = { ...chat, status: 'idle', updatedAt: chat.updatedAt + 1 };
  restored.triggers.observeNative(idle);
  restored.triggers.observeNative(idle);
  await restored.triggers.tick();
  assert.equal(f.jobs.size, 1);
});

test('a machine fires when it returns, without firing for the observer restart', async t => {
  let online = false;
  const f = fixture(t, { presence: () => ({ self: { online: true }, peer: { online } }) });
  await save(f.scheduler, { kind: 'machine-online', machineId: 'peer' });
  await f.scheduler.triggers.tick();
  online = true;
  await f.scheduler.triggers.tick();
  assert.equal(f.jobs.size, 1);
  online = false;
  const restored = f.restore();
  await restored.triggers.tick();
  online = true;
  await restored.triggers.tick();
  assert.equal(f.jobs.size, 1);
  f.advance(1000);
  online = false;
  await restored.triggers.tick();
  online = true;
  await restored.triggers.tick();
  assert.equal(f.jobs.size, 2);
});

test('three failed actions pause once, and resume clears the failure count', async t => {
  const executions = { start() {}, async read() { return { status: 'exited', exitCode: 9 }; } };
  const f = fixture(t, { executions }), { scheduler } = f;
  const path = join(f.directory, 'file.txt');
  const { id } = await save(scheduler, { kind: 'file-change', path });
  for (const value of ['first', 'second', 'third']) {
    writeFileSync(path, value);
    f.advance(5000);
    await scheduler.triggers.tick();
  }
  assert.deepEqual(f.notices, [id]);
  assert.equal(latest(scheduler).enabled, false);
  assert.equal(latest(scheduler).lastResult.message, 'Exit code 9.');
  const restored = f.restore();
  assert.equal(latest(restored).pausedAfterFailures, true);
  restored.save({ id, enabled: true });
  assert.equal(latest(restored).pausedAfterFailures, undefined);
  assert.equal(latest(restored).failures, 0);
  restored.remove(id);
  assert.equal(f.restore().list().schedules.length, 0);
});
