import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeCli, collect } from './helpers.mjs';
import { PiDriver, OmpDriver } from '../packages/connect/src/drivers/pi.js';

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
    case 'abort': return ok(m);
    case 'compact':
      await compaction('', 'manual', false);
      return ok(m, { summary: 's' });
    case 'prompt': break;
    default: return out({ id: m.id, type: 'response', command: m.type, success: false, error: 'unknown' });
  }
  if (scenario === 'ext-command') return ok(m);
  if (scenario === 'omp-ext') { ok(m); return out({ type: 'prompt_result', id: m.id, agentInvoked: false }); }
  ok(m);
  state.streaming = true;
  out({ type: 'agent_start' });
  if (scenario === 'dialogs') {
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
  const retried = log.of('item.start').find((e) => e.kind === 'text');
  assert.equal(retried.turnId, done.turnId, 'the retried answer belongs to the turn');
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
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
