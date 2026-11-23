import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeCli, collect } from './helpers.mjs';
import { PiDriver, OmpDriver } from '../packages/connect/src/drivers/pi.js';
import { ManagedChat } from '../packages/connect/src/chat-cli.js';

// The pi-family fixtures are written by hand from a recorded `omp --mode
// rpc` session: commands answer as `{type:"response", command:<type>}` and
// everything else is an event. `await` records pause the replay until the
// driver writes the named stdin frame.
const make = (name, opts = {}, cls = PiDriver) => {
  const fake = fakeCli('pi', name);
  const driver = new cls({
    cmd: fake.cmd, env: {}, args: [],
    cwd: fake.dir, ...opts,
  });
  return { fake, driver, log: collect(driver) };
};

test('pi-family releases read timers after immediate replies', async t => {
  const timers = new Set();
  t.mock.method(globalThis, 'setTimeout', () => {
    const timer = { unref() {} }; timers.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => timers.delete(timer));
  let receive, exited;
  const pipe = { onData(fn) { receive = fn; }, onExit(fn) { exited = fn; },
    write(raw) {
      const { id, type } = JSON.parse(raw);
      receive(JSON.stringify({ id, type: 'response', command: type, success: true,
        data: { sessionId: 'kept', isStreaming: false } }) + '\n');
    },
    end() { exited({ code: 0 }); }, kill() { exited({ code: 0 }); },
  };
  const driver = new OmpDriver({ cmd: 'unused', cwd: '/tmp', procId: 'kept',
    procHost: { hasProc: () => true, procPipe: () => pipe } });
  try {
    await driver.start();
    assert.equal(timers.size, 0);
    await driver.setModel('new-model');
    assert.equal(timers.size, 0);
  } finally { exited?.({ code: 0 }); }
});

test('pi: get_state seeds model/effort/title, prompt streams text exactly once', async () => {
  const { driver, log, fake } = make('plain', { model: 'opencode/spark-1' });
  await driver.send('say helm-ok');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.deepEqual(done.usage, { input: 120, output: 6, cacheRead: 10 });
  assert.equal(done.costUsd, 0.0042);

  // init carries the provider-qualified selector, not the bare id.
  assert.equal(driver.engineSessionId, 'sess-plain');
  assert.equal(driver.info.model, 'opencode/spark-1');
  assert.equal(driver.info.effort, 'high');
  assert.equal(log.of('title').at(-1).title, 'fixture run');

  // message_start carries partial content; the block still streams once.
  const texts = log.of('item.start').filter((e) => e.kind === 'text');
  assert.equal(texts.length, 1);
  const deltas = log.of('item.delta').filter((e) => e.id === texts[0].id);
  assert.equal(deltas.map((e) => e.text).join(''), 'helm-ok');
  assert.equal(log.of('item.done').filter((e) => e.id === texts[0].id).length, 1);
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);

  // Commands answered by the live session, plus the wire was the pi shape.
  const names = (await driver.availableCommands()).map((c) => c.name);
  assert.deepEqual(names, ['review', 'handoff']);
  const sent = fake.stdinLines();
  assert.ok(sent.some((l) => l.type === 'get_state'));
  assert.ok(sent.some((l) => l.type === 'prompt' && l.message === 'say helm-ok'));
  // The effort ladder the live agent answered becomes the catalog.
  assert.deepEqual(driver.catalog()?.efforts, ['off', 'low', 'high', 'xhigh']);
  await driver.kill();
});

test('pi: a non-streaming model still lands its text and thinking from the end snapshot', async () => {
  const { driver, log } = make('nostream');
  await driver.send('one shot please');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(done.costUsd, 0.002);

  const thinking = log.of('item.start').filter((e) => e.kind === 'thinking');
  const text = log.of('item.start').filter((e) => e.kind === 'text');
  assert.equal(thinking.length, 1);
  assert.equal(text.length, 1);
  assert.equal(log.of('item.delta').find((e) => e.id === thinking[0].id)?.text, 'let me think');
  assert.equal(log.of('item.delta').find((e) => e.id === text[0].id)?.text, 'final only');
  // agent_end repeats the same final message - it must not re-emit.
  assert.equal(log.of('item.delta').length, 2);
  await driver.kill();
});

test('pi: an extension confirm becomes a permission card and answers on stdin', async () => {
  const { driver, log, fake } = make('dialog');
  await driver.send('clean the build dir');
  const req = await log.until((e) => e.type === 'permission.request');
  assert.equal(req.kind, 'tool');
  assert.equal(req.title, 'Run shell command?');
  assert.equal(req.detail, 'rm -rf ./build');

  await driver.answer(req.requestId, { option: 'allow' });
  await log.until((e) => e.type === 'turn.done');
  const answer = fake.stdinLines().find((l) => l.type === 'extension_ui_response');
  assert.deepEqual(answer, { type: 'extension_ui_response', id: 'req-9', confirmed: true });
  assert.ok(log.of('permission.resolved').some((e) => e.requestId === 'req-9'));
  await driver.kill();
});

test('pi: interrupt writes abort and the turn ends interrupted', async () => {
  const { driver, log, fake } = make('abort');
  await driver.send('long running thing');
  await log.until((e) => e.type === 'status' && e.status === 'working');
  await driver.interrupt();
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'interrupted');
  assert.ok(fake.stdinLines().some((l) => l.type === 'abort'));
  await driver.kill();
});

test('omp shares the pi driver', () => {
  const { driver } = make('plain', {}, OmpDriver);
  assert.equal(driver.engine, 'omp');
});

// ------------------------------------------------- lifecycle status (live)
//
// A small live pi/omp rather than a recording: these cases are about what
// happens around and after a turn - compaction after agent_end, a prompt
// an extension answers without the model, a restart - which need the
// agent's answers to depend on what it is doing. FAKE_SCENARIO picks the
// prompt's behaviour; FAKE_VERSION / FAKE_VERSION_MS answer --version.
const LIVE_PI = `
import { appendFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopped = null;
if (process.argv.includes('--version')) {
  await sleep(Number(process.env.FAKE_VERSION_MS ?? 0));
  console.log(process.env.FAKE_VERSION ?? '0.82.1');
  process.exit(0);
}
if (process.env.FAKE_SPAWNS) appendFileSync(process.env.FAKE_SPAWNS, 'spawn\\n');
const scenario = process.env.FAKE_SCENARIO ?? 'plain';
const COMPACT_MS = Number(process.env.FAKE_COMPACT_MS ?? 150);
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const state = { streaming: process.env.FAKE_STREAMING === '1', compacting: false };
const answers = new Map();
// Steered messages not read yet, and the wake-up for a reply waiting on one.
const steers = [];
let steered = null;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) onMessage(JSON.parse(line));
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 20));
const ok = (m, data) => out({ id: m.id, type: 'response', command: m.type, success: true, ...(data ? { data } : {}) });
const text = (t) => [
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: t } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0 } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: t }] } },
].forEach(out);
const compaction = async (prefix, reason, willRetry) => {
  state.compacting = true;
  out({ type: prefix + 'compaction_start', reason });
  await sleep(COMPACT_MS);
  state.compacting = false;
  out({ type: prefix + 'compaction_end', reason, result: { summary: 's' }, aborted: false, willRetry });
};
const confirm = (id) => {
  const answered = new Promise((r) => answers.set(id, r));
  out({ type: 'extension_ui_request', id, method: 'confirm', title: 'Allow ' + id + '?', message: id });
  return answered;
};
async function onMessage(m) {
  if (m.type === 'extension_ui_response') { answers.get(m.id)?.(m); return; }
  switch (m.type) {
    case 'get_state': return ok(m, { sessionId: 'live', isStreaming: state.streaming, isCompacting: state.compacting });
    case 'get_commands': return ok(m, { commands: [] });
    case 'get_available_thinking_levels': return ok(m, { levels: ['low', 'high'] });
    case 'set_thinking_level':
      if (scenario === 'failed-follow-up') {
        out({ type: 'agent_start' });
        text('follow-up answer');
        out({ type: 'agent_end', messages: [] });
        out({ type: 'agent_settled' });
      }
      return ok(m);
    case 'abort':
      ok(m);
      if (scenario === 'steer-stop') stopped?.();
      return;
    case 'clear_queue': return ok(m, { steering: steers.splice(0), followUp: [] });
    case 'compact':
      await compaction('', 'manual', false);
      return ok(m, { summary: 's' });
    case 'prompt': break;
    default: return out({ id: m.id, type: 'response', command: m.type, success: false, error: 'unknown' });
  }
  if (m.streamingBehavior === 'steer') {
    if (scenario === 'steer-refuse') return out({ id: m.id, type: 'response', command: 'prompt', success: false, error: 'not now' });
    ok(m, { disposition: 'queued' });
    if (scenario === 'steer-exit') process.exit(1);
    if (scenario === 'omp-steer-error') { out({ id: m.id, type: 'response', command: 'prompt', success: false, error: 'image too big' }); return steered?.(); }
    steers.push(m.message);
    return steered?.();
  }
  if (scenario === 'ext-command') return ok(m);
  if (scenario === 'omp-ext') { ok(m); return out({ type: 'prompt_result', id: m.id, agentInvoked: false }); }
  if (scenario === 'failed-follow-up') {
    if (m.streamingBehavior === 'followUp') return ok(m);
    state.streaming = true;
    const frames = [
      { id: m.id, type: 'response', command: m.type, success: true },
      { type: 'agent_start' },
      { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', content: [], errorMessage: 'Too many requests' }] },
      { type: 'auto_retry_end', success: false, finalError: 'Too many requests' },
    ];
    process.stdout.write(frames.map(frame => JSON.stringify(frame) + '\\n').join(''));
    return;
  }
  if (scenario === 'retry-exhausted' || scenario === 'omp-provider-error' || scenario === 'failed-replay') {
    const messages = [{ role: 'assistant', stopReason: 'error', content: [],
      ...(scenario === 'omp-provider-error' ? { errorMessage: 'The model is at capacity.' } : {}) }];
    const frames = [
      { id: m.id, type: 'response', command: m.type, success: true },
      { type: 'agent_start' },
      { type: 'agent_end', messages, willRetry: false },
    ];
    if (scenario !== 'omp-provider-error') frames.push(
      { type: 'auto_retry_end', success: false, finalError: 'Too many requests' },
      { type: 'agent_settled' },
    );
    if (scenario === 'failed-replay') frames.push({ type: 'agent_start' });
    process.stdout.write(frames.map(frame => JSON.stringify(frame) + '\\n').join(''));
    return;
  }
  ok(m);
  state.streaming = true;
  out({ type: 'agent_start' });
  if (scenario.startsWith('steer') || scenario === 'omp-steer-error') {
    // One step: a tool runs; the steer arrives while it does; the agent
    // reads it once the tool is done, before its next model call.
    out({ type: 'turn_start' });
    out({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'sleep 1' } });
    const stop = new Promise((r) => { stopped = r; });
    const next = await Promise.race([new Promise((r) => { steered = r; }).then(() => 'steer'), stop.then(() => 'stop')]);
    if (next === 'stop' || scenario === 'steer-stop') {
      if (next !== 'stop') await stop;
      out({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [] }, isError: true });
      out({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted', content: [] }], willRetry: false });
      state.streaming = false;
      out({ type: 'agent_settled' });
      return;
    }
    out({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }] }, isError: false });
    out({ type: 'turn_end' });
    if (scenario === 'omp-steer-error') { await sleep(20); text('answer'); out({ type: 'agent_end', messages: [], willRetry: false }); state.streaming = false; return; }
    for (const t of steers.splice(0)) {
      const message = { role: 'user', content: [{ type: 'text', text: t }] };
      out({ type: 'message_start', message });
      out({ type: 'message_end', message });
    }
    text('answer');
    out({ type: 'agent_end', messages: [], willRetry: false });
  } else if (scenario === 'dialogs') {
    await Promise.all([confirm('d1'), confirm('d2')]);
    text('done');
    out({ type: 'agent_end', messages: [], willRetry: false });
  } else if (scenario === 'overflow') {
    out({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', content: [] }], willRetry: false });
    await compaction('', 'overflow', true);
    out({ type: 'agent_start' });
    text('retried');
    out({ type: 'agent_end', messages: [], willRetry: false });
  } else {
    text('answer');
    out({ type: 'agent_end', messages: [], willRetry: false });
    if (scenario === 'post-compact') await compaction('', 'threshold', false);
    if (scenario === 'omp-compact') { state.streaming = false; await compaction('auto_', 'threshold', false); return; }
  }
  state.streaming = false;
  if (!scenario.startsWith('omp')) out({ type: 'agent_settled' });
  if (scenario === 'wake') {
    // Then a cycle of its own - a background task finished - with a long
    // quiet gap in the middle, and its settle said twice.
    await sleep(60);
    out({ type: 'agent_start' });
    text('background started');
    await sleep(500);
    text('background finished');
    out({ type: 'agent_end', messages: [], willRetry: false });
    out({ type: 'agent_settled' });
    out({ type: 'agent_settled' });
  }
}
`;

const livePi = (t, scenario, { env = {}, cls = PiDriver, ...opts } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-pi-live-'));
  const script = join(dir, 'agent.mjs');
  writeFileSync(script, LIVE_PI);
  const cmd = join(dir, 'pi');
  writeFileSync(cmd, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(cmd, 0o755);
  const fullEnv = { FAKE_SCENARIO: scenario, ...env };
  const driver = new cls({ cmd, args: [], cwd: dir, env: fullEnv, ...opts });
  t.after(() => driver.kill());
  return { driver, log: collect(driver), cmd, dir, script, env: fullEnv };
};

/** A proc host holding one already-running process, the way a restart finds it. */
const heldBy = (child) => ({
  hasProc: () => true,
  procPipe: () => ({
    write: (d) => child.stdin.write(d),
    end: () => child.stdin.end(),
    kill: (s) => child.kill(s),
    onData: (cb) => child.stdout.on('data', (c) => cb(c.toString('utf8'))),
    onExit: (cb) => child.on('exit', (code) => cb({ code })),
    detach: () => {},
  }),
});

test('pi: compaction after agent_end keeps the turn working until agent_settled', async (t) => {
  // A slow --version and an instant turn: whether agent_end is the end must
  // be settled before the first prompt, not raced against it.
  const { driver, log } = livePi(t, 'post-compact', { env: { FAKE_VERSION_MS: '300' } });
  await driver.send('big context');
  const compact = await log.until((e) => e.type === 'item.start' && e.name === 'compact');
  assert.equal(driver.status, 'working', 'compacting is work');
  assert.equal(log.of('turn.done').length, 0, 'the turn is not over while pi compacts');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  const types = log.events.map((e) => (e.type === 'item.done' && e.id === compact.id ? 'compact.done' : e.type));
  assert.ok(types.indexOf('compact.done') < types.indexOf('turn.done'));
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
});

test('pi: an overflow compaction and its retry stay inside the one turn', async (t) => {
  const { driver, log } = livePi(t, 'overflow');
  await driver.send('too much');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(log.of('turn.done').length, 1);
  assert.equal(log.of('error').length, 0, 'a reply that succeeds after compaction has no error');
  const retried = log.of('item.start').find((e) => e.kind === 'text');
  assert.equal(retried.turnId, done.turnId, 'the retried answer belongs to the turn');
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
});

for (const [scenario, cls, error] of [
  ['retry-exhausted', PiDriver, 'Too many requests'],
  ['omp-provider-error', OmpDriver, 'The model is at capacity.'],
]) test(`${scenario} reports the original cause without changing the turn status`, async t => {
  const { driver, log } = livePi(t, scenario, { cls });
  await driver.send('Answer me');
  const done = await log.until(e => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(done.error, undefined);
  assert.deepEqual(log.of('error').map(({ turnId, message, kind }) => ({ turnId, message, kind })), [
    { turnId: done.turnId, message: error, kind: 'provider-reply' },
  ]);
  assert.equal(log.of('turn.done').length, 1);
});

test('Pi reports the failed reply before the next reply begins in the same read', async t => {
  const { driver, log } = livePi(t, 'failed-replay');
  await driver.send('Answer me');
  await log.until(e => e.type === 'error' && e.kind === 'provider-reply');
  const events = log.events;
  const failure = events.findIndex(e => e.type === 'error' && e.kind === 'provider-reply');
  assert.equal(events[failure].turnId, log.of('turn.start')[0].turnId);
  assert.equal(events[failure].message, 'Too many requests');
  assert.ok(events.slice(failure + 1).filter(e => e.type === 'status').every(e => e.status === 'working'));
  assert.equal(driver.status, 'working');
});

test('a Pi follow-up before settlement keeps the failure on the first reply', async t => {
  const { driver, log } = livePi(t, 'failed-follow-up');
  await driver.send('First message');
  await driver.send('Follow-up message');
  // The fake agent starts its follow-up only after Helm sees it was accepted.
  await driver.setEffort('high');

  const [first, second] = log.of('turn.start');
  assert.deepEqual(log.of('turn.done').map(e => e.turnId), [first.turnId, second.turnId]);
  assert.deepEqual(log.of('error').map(e => [e.turnId, e.message]), [[first.turnId, 'Too many requests']]);
  const events = log.events.map((event, i) => ({ ...event, seq: i + 1 }));
  const connection = new EventEmitter();
  connection.rpc = async () => ({ events, last: events.length, pending: [] });
  let output = '';
  const chat = new ManagedChat(connection, 's', { write: text => { output += text; } });
  t.after(() => chat.close());
  await chat.sync();
  assert.match(output, /\[error\] Too many requests/);
  assert.equal(output.match(/\[ok\]/g)?.length, 1);
});

test('omp: auto compaction after the turn reads as working, then idle', async (t) => {
  const { driver, log } = livePi(t, 'omp-compact', { cls: OmpDriver });
  await driver.send('big context');
  await log.until((e) => e.type === 'turn.done');
  await log.until((e) => e.type === 'item.start' && e.name === 'compact');
  assert.equal(driver.status, 'working');
  await log.until((e) => e.type === 'item.done' && e.id.startsWith('compact-'));
  assert.equal(driver.status, 'idle');
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle', 'working', 'idle']);
});

test('pi: /compact is working until the summary is written', async (t) => {
  const { driver, log } = livePi(t, 'plain', { env: { FAKE_COMPACT_MS: '200' } });
  const compacting = driver.compact();
  await log.until((e) => e.type === 'item.start' && e.name === 'compact');
  assert.equal(driver.status, 'working');
  await compacting;
  assert.equal(driver.status, 'idle');
});

test('pi: a prompt an extension answers without the model still ends', async (t) => {
  const { driver, log } = livePi(t, 'ext-command');
  await driver.send('/hello');
  const done = await log.until((e) => e.type === 'turn.done', 3000);
  assert.equal(done.status, 'ok');
  assert.equal(driver.status, 'idle');
});

test('omp: prompt_result agentInvoked:false ends the turn', async (t) => {
  const { driver, log } = livePi(t, 'omp-ext', { cls: OmpDriver });
  await driver.send('/hello');
  const done = await log.until((e) => e.type === 'turn.done', 3000);
  assert.equal(done.status, 'ok');
  assert.equal(driver.status, 'idle');
});

test('pi: answering one of two dialogs keeps "needs you"', async (t) => {
  const { driver, log } = livePi(t, 'dialogs');
  await driver.send('two asks');
  await log.until(() => log.of('permission.request').length === 2);
  const [a, b] = log.of('permission.request');
  await driver.answer(a.requestId, { option: 'allow' });
  assert.equal(driver.status, 'blocked');
  await driver.answer(b.requestId, { option: 'allow' });
  assert.equal(driver.status, 'working');
  await log.until((e) => e.type === 'turn.done');
  assert.equal(driver.status, 'idle');
});

test('pi: a palette read and a send during a cold start share one finished start', async (t) => {
  // The palette starts the agent first; the send must wait for that whole
  // start - the version check included - not prompt a half-started one
  // that would take agent_end for the end of a compacting turn.
  const spawns = join(mkdtempSync(join(tmpdir(), 'helm-pi-spawns-')), 'n');
  const { driver, log } = livePi(t, 'post-compact', { env: { FAKE_SPAWNS: spawns, FAKE_VERSION_MS: '300' } });
  const commands = driver.availableCommands();
  await driver.send('hello');
  await commands;
  await log.until((e) => e.type === 'turn.done');
  assert.equal(readFileSync(spawns, 'utf8').trim().split('\n').length, 1, 'one pi process');
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
});

test('pi: a start that fails settles back to idle', async () => {
  const d = new PiDriver({ cmd: 'pi', env: {}, args: [], cwd: '/no/such/folder/for/helm' });
  const log = collect(d);
  await assert.rejects(d.send('hello'), /does not exist/);
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
});

for (const [name, open, expect] of [
  ['a turn whose end was lost while helm restarted settles', 'turn-lost', { turnId: 'turn-lost', status: 'ok' }],
  ['an unsent ticket is closed as undelivered', 'local-ticket', { turnId: 'local-ticket', status: 'interrupted' }],
]) {
  test(`pi adopt: ${name}; the saved busy status is corrected`, async (t) => {
    const { cmd, dir, env } = livePi(t, 'plain');
    const child = spawn(cmd, ['--mode', 'rpc'], { cwd: dir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const driver = new PiDriver({
      cmd, args: [], cwd: dir, env,
      procHost: heldBy(child), procId: 'p1',
      openTurn: () => open, pendingEvents: () => [],
      resumeEvents: () => [{ type: 'turn.start', turnId: open, text: 'hi' }],
    });
    driver.status = 'working'; // what the record remembered
    const log = collect(driver);
    await driver.start();
    const done = log.of('turn.done');
    assert.equal(done.length, 1);
    assert.equal(done[0].turnId, expect.turnId);
    assert.equal(done[0].status, expect.status);
    assert.equal(driver.status, 'idle');
  });
}

test('pi adopt: a process still running keeps its turn working', async (t) => {
  const { cmd, dir, env } = livePi(t, 'plain', { env: { FAKE_STREAMING: '1' } });
  const child = spawn(cmd, ['--mode', 'rpc'], { cwd: dir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const driver = new PiDriver({
    cmd, args: [], cwd: dir, env,
    procHost: heldBy(child), procId: 'p2',
    openTurn: () => 'turn-live', pendingEvents: () => [],
  });
  driver.status = 'working';
  const log = collect(driver);
  await driver.start();
  assert.equal(log.of('turn.done').length, 0);
  assert.equal(driver.status, 'working');
});

test('pi: a cycle the agent starts by itself is its own turn, open through a quiet gap until it settles', async (t) => {
  const { driver, log } = livePi(t, 'wake');
  await driver.send('go');
  await log.until((e) => e.type === 'turn.done');
  const first = log.of('turn.start')[0];
  const wake = await log.until((e) => e.type === 'turn.start' && e.wake === true);
  assert.equal(wake.text, '');
  assert.match(wake.turnId, /^wake-/);
  await log.until((e) => e.type === 'item.done' && e.id.startsWith('m') && log.of('item.start').some((s) => s.id === e.id && s.turnId === wake.turnId));
  // Quiet: nothing for most of half a second. That is not the end of the work.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(log.of('turn.done').length, 1, 'a quiet gap does not close the wake-up');
  assert.equal(driver.status, 'working');
  const done = await log.until((e) => e.type === 'turn.done' && e.turnId === wake.turnId);
  assert.equal(done.status, 'ok');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(log.of('turn.done').map((e) => e.turnId), [first.turnId, wake.turnId], 'each turn closes once, the repeated settle closes nothing');
  assert.equal(driver.status, 'idle');
  const texts = log.of('item.start').filter((e) => e.kind === 'text').map((e) => e.turnId);
  assert.deepEqual(texts, [first.turnId, wake.turnId, wake.turnId]);
});

// -------------------------------------------------- steering (live fake)
//
// Pi (1.5.2, core/agent-session.js) and OMP queue a prompt sent with
// streamingBehavior 'steer' and read it after the tool calls of the
// current step, before the next model call, echoing it as a user
// message_start. That echo is the read.

test('pi: a steered message goes in as a steer and is read when the agent echoes it', async (t) => {
  const { driver, log } = livePi(t, 'steer');
  await driver.send('long task');
  await log.until((e) => e.type === 'item.start' && e.id === 't1');
  await driver.steer('also check the docs', [], { inputId: 'local-1' });
  const read = await log.until((e) => e.type === 'input.consumed');
  assert.deepEqual(read, { type: 'input.consumed', text: 'also check the docs', inputId: 'local-1' });
  // Read after the step's tool is done, and before the answer that follows it.
  const order = log.events.map((e) => e.type === 'item.done' && e.id === 't1' ? 'tool.done' : e.type);
  assert.ok(order.indexOf('tool.done') < order.indexOf('input.consumed'));
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(log.of('turn.start').length, 1, 'a steer is not a turn of its own');
  assert.equal(log.of('input.failed').length, 0);
});

test('pi: a steer the agent refuses comes back as not sent', async (t) => {
  const { driver, log } = livePi(t, 'steer-refuse');
  await driver.send('long task');
  await log.until((e) => e.type === 'item.start' && e.id === 't1');
  await assert.rejects(driver.steer('later', [], { inputId: 'local-2' }), (err) => err.deliveryNotSent === true && /not now/.test(err.message));
  assert.equal(log.of('input.consumed').length + log.of('input.failed').length, 0);
});

test('pi: no steer goes to an agent that is not replying', async (t) => {
  const { driver } = livePi(t, 'plain');
  await assert.rejects(driver.steer('hello'), (err) => err.deliveryNotSent === true);
});

test('pi: a steered message fails by name when the agent exits before reading it', async (t) => {
  const { driver, log } = livePi(t, 'steer-exit');
  await driver.send('long task');
  await log.until((e) => e.type === 'item.start' && e.id === 't1');
  await driver.steer('one more thing', [], { inputId: 'local-3' }).catch(() => {});
  const failed = await log.until((e) => e.type === 'input.failed');
  assert.equal(failed.inputId, 'local-3');
  assert.match(failed.error, /Pi exited before reading this message/);
  assert.equal(log.of('input.failed').length, 1);
});

test('pi: a stop takes unread steered messages back from the agent', async (t) => {
  const { driver, log } = livePi(t, 'steer-stop', { env: { FAKE_VERSION: '1.5.2' } });
  await driver.send('long task');
  await log.until((e) => e.type === 'item.start' && e.id === 't1');
  await driver.steer('never mind', [], { inputId: 'local-4' });
  assert.equal(driver.dropsHandedOnInterrupt, true);
  await driver.interrupt();
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'interrupted');
  // Dropped quietly: Helm puts it back in line itself.
  assert.equal(log.of('input.consumed').length + log.of('input.failed').length, 0);
});

test('pi: an older pi without clear_queue keeps handed messages through a stop', async (t) => {
  const { driver } = livePi(t, 'plain', { env: { FAKE_VERSION: '0.82.1' } });
  await driver.start();
  assert.equal(driver.dropsHandedOnInterrupt, false);
});

test('omp: a steer that fails after omp accepted it fails by name', async (t) => {
  const { driver, log } = livePi(t, 'omp-steer-error', { cls: OmpDriver });
  await driver.send('long task');
  await log.until((e) => e.type === 'item.start' && e.id === 't1');
  await driver.steer('see this picture', [], { inputId: 'local-5' });
  const failed = await log.until((e) => e.type === 'input.failed');
  assert.equal(failed.inputId, 'local-5');
  assert.equal(failed.error, 'image too big');
  await log.until((e) => e.type === 'turn.done');
  assert.equal(log.of('input.consumed').length, 0);
  assert.equal(driver.dropsHandedOnInterrupt, false, 'omp has no way to drop a queued message');
});
