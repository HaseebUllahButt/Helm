import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeCli, collect } from './helpers.mjs';
import { AgyDriver } from '../packages/connect/src/drivers/agy.js';

// The agy fixtures mirror the documented stream-json shape: init at stream
// start, step_update rows per step transition, one result per turn. A
// {"event":"user"} fixture record waits for the driver's stdin user message;
// {"event":"await","on":"interrupt"} waits for that stdin frame.
const make = (name, opts = {}) => {
  const fake = fakeCli('agy', name);
  const driver = new AgyDriver({
    cmd: fake.cmd, env: {}, args: [],
    cwd: fake.dir, ...opts,
  });
  return { fake, driver, log: collect(driver) };
};

test('agy: init binds the conversation, text streams once, usage lands on turn.done', async () => {
  const { driver, log, fake } = make('plain');
  await driver.send('say helm-agy-ok');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.deepEqual(done.usage, { input: 100, output: 10, cacheRead: 40 });
  assert.equal(driver.engineSessionId, 'conv-agy-1');

  // One text item, streamed in fragments; the result's response field is a
  // fallback and must not re-emit what already streamed.
  const texts = log.of('item.start').filter((e) => e.kind === 'text');
  assert.equal(texts.length, 1);
  const deltas = log.of('item.delta').filter((e) => e.id === texts[0].id);
  assert.equal(deltas.map((e) => e.text).join(''), 'helm-agy-ok');
  assert.equal(log.of('item.done').filter((e) => e.id === texts[0].id).length, 1);
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);

  // The wire is the documented stdin shape.
  const sent = fake.stdinLines();
  assert.deepEqual(sent, [{ event: 'user', message: { content: 'say helm-agy-ok' } }]);
  await driver.kill();
});

test('agy: a model that does not stream still lands its response', async () => {
  const { driver, log } = make('nostream');
  await driver.send('one shot please');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  const texts = log.of('item.start').filter((e) => e.kind === 'text');
  assert.equal(texts.length, 1);
  assert.equal(log.of('item.delta').find((e) => e.id === texts[0].id)?.text, 'one shot answer\n');
  await driver.kill();
});

test('agy: queued turns run in order and usage is per-turn, not cumulative', async () => {
  const { driver, log, fake } = make('queued');
  await driver.send('first prompt');
  await driver.send('second prompt');
  const dones = [];
  dones.push(await log.until((e) => e.type === 'turn.done'));
  dones.push(await log.until((e) => e.type === 'turn.done' && e !== dones[0]));
  assert.equal(dones[0].status, 'ok');
  assert.deepEqual(dones[0].usage, { input: 100, output: 10, cacheRead: 40 });
  // The result reports conversation-cumulative counters; the turn's share is
  // the delta from the previous result.
  assert.equal(dones[1].status, 'ok');
  assert.deepEqual(dones[1].usage, { input: 60, output: 20, cacheRead: 20 });

  const users = fake.stdinLines().filter((l) => l.event === 'user');
  assert.deepEqual(users.map((u) => u.message.content), ['first prompt', 'second prompt']);
  await driver.kill();
});

test('agy: a tool step becomes a tool item with its output', async () => {
  const { driver, log } = make('tool');
  await driver.send('list files');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  const tools = log.of('item.start').filter((e) => e.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'run_command');
  assert.deepEqual(tools[0].input, { command: 'ls' });
  const finished = log.of('item.done').find((e) => e.id === tools[0].id);
  assert.equal(finished.status, 'ok');
  assert.equal(finished.output, 'file.txt\n');
  await driver.kill();
});

test('agy: interrupt writes the interrupt event and the turn ends interrupted', async () => {
  const { driver, log, fake } = make('interrupt');
  await driver.send('long running thing');
  await log.until((e) => e.type === 'status' && e.status === 'working');
  await driver.interrupt();
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'interrupted');
  assert.ok(fake.stdinLines().some((l) => l.event === 'interrupt'));
  await driver.kill();
});

test('agy: a start-up ERROR result is an init error; a later turn fails on exit', async () => {
  const { driver, log } = make('error');
  await driver.start();
  // With no turn behind it, the eligibility failure is an init error.
  const err = await log.until((e) => e.type === 'error');
  assert.equal(err.kind, 'init');
  assert.match(err.message, /Eligibility/);
  // A prompt written into the dead stream settles when the process goes.
  await driver.send('hi');
  await driver.kill();
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'error');
});

test('agy: model/effort/mode/session land on argv; a settings change respawns on the same conversation', async () => {
  const { driver, log, fake } = make('queued', {
    model: 'gemini-3.8-flash-high', effort: 'high', mode: 'edit', engineSessionId: 'conv-resume',
  });
  const args = driver.args;
  assert.deepEqual(
    args.slice(0, 6),
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--model'],
  );
  for (const pair of [['--model', 'gemini-3.8-flash-high'], ['--effort', 'high'], ['--mode', 'accept-edits'], ['--conversation', 'conv-resume']]) {
    const at = args.indexOf(pair[0]);
    assert.ok(at >= 0 && args[at + 1] === pair[1], `${pair[0]} ${pair[1]}`);
  }
  assert.ok(!args.includes('-p') && !args.includes('--print'));

  await driver.send('first prompt');
  const first = await log.until((e) => e.type === 'turn.done');
  assert.equal(first.status, 'ok');
  // init wins over the constructor's session id.
  assert.equal(driver.engineSessionId, 'conv-agy-3');

  await driver.setModel('gemini-3.1-pro-high');
  await driver.setEffort('max');
  await driver.setMode('yolo');
  const args2 = driver.args;
  for (const pair of [['--model', 'gemini-3.1-pro-high'], ['--effort', 'max'], ['--dangerously-skip-permissions'], ['--conversation', 'conv-agy-3']]) {
    const at = args2.indexOf(pair[0]);
    if (pair.length === 1) assert.ok(at >= 0, pair[0]);
    else assert.ok(at >= 0 && args2[at + 1] === pair[1], `${pair[0]} ${pair[1]}`);
  }

  // The respawned process takes the next turn on the same conversation; the
  // fixture replays from the top, so this turn gets the first recorded
  // result - what matters is that it completed and never read as an exit.
  await driver.send('second prompt');
  const second = await log.until((e) => e.type === 'turn.done' && e !== first);
  assert.equal(second.status, 'ok');
  assert.ok(!log.of('status').some((e) => e.status === 'exited'));
  const users = fake.stdinLines().filter((l) => l.event === 'user');
  assert.deepEqual(users.map((u) => u.message.content), ['first prompt', 'second prompt']);
  await driver.kill();
});

// ------------------------------------------------- lifecycle status (live)
//
// A small live agy: says hello after FAKE_INIT_MS, answers each user line
// with one step and a result. Enough to pace a start and to be the process
// a restart finds still running.
const LIVE_AGY = `
if (process.argv.includes('--version')) { console.log('agy 1.2.12'); process.exit(0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.event !== 'user') continue;
    out({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'ok' } });
    out({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-live' } });
    if (process.env.FAKE_WAKE === '1') (async () => {
      // Then work of its own - a background task finished - with a long quiet
      // gap in the middle, and its result said twice.
      await sleep(60);
      out({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'background started' } });
      await sleep(500);
      out({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'background finished' } });
      out({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-live' } });
      out({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-live' } });
    })();
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 20));
if (process.env.FAKE_HELLO !== '0') {
  await sleep(Number(process.env.FAKE_INIT_MS ?? 0));
  out({ event: 'init', conversation_id: 'conv-live', init: { cwd: process.cwd() } });
}
`;

const liveAgy = (t, env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-agy-live-'));
  const script = join(dir, 'agent.mjs');
  writeFileSync(script, LIVE_AGY);
  const cmd = join(dir, 'agy');
  writeFileSync(cmd, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(cmd, 0o755);
  return { cmd, dir, env };
};

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

test('agy: a second start during the handshake waits for the same start', async (t) => {
  const { cmd, dir, env } = liveAgy(t, { FAKE_INIT_MS: '300' });
  const driver = new AgyDriver({ cmd, args: [], cwd: dir, env });
  t.after(() => driver.kill());
  const log = collect(driver);
  const first = driver.start();
  // The pipe is bound and init emitted before agy has said hello.
  await new Promise((resolve) => driver.once('init', resolve));
  const sending = driver.send('hello');
  await log.until((e) => e.type === 'status');
  assert.equal(driver.status, 'working', 'starting is part of answering');
  await sending;
  assert.equal(driver.engineSessionId, 'conv-live', 'the second caller saw the finished start');
  await first;
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(driver.status, 'idle');
});

for (const [name, open, closed] of [
  ['no open turn', null, null],
  ['only an unsent ticket', 'local-ticket', 'interrupted'],
]) {
  test(`agy adopt: ${name} corrects a saved busy status to idle`, async (t) => {
    const { cmd, dir, env } = liveAgy(t, { FAKE_HELLO: '0' });
    const child = spawn(cmd, [], { cwd: dir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const driver = new AgyDriver({
      cmd, args: [], cwd: dir, env,
      procHost: heldBy(child), procId: 'a1', openTurn: () => open,
    });
    driver.status = 'working'; // what the record remembered
    const log = collect(driver);
    await driver.start();
    assert.equal(driver.status, 'idle');
    assert.deepEqual(log.of('turn.done').map((e) => [e.turnId, e.status]), closed ? [[open, closed]] : []);
    // The adopted process takes the next prompt as its own turn.
    await driver.send('next');
    const done = await log.until((e) => e.type === 'turn.done' && e.turnId !== open);
    assert.equal(done.status, 'ok');
    assert.equal(driver.status, 'idle');
  });
}

test('agy adopt: a turn still open stays working until its result', async (t) => {
  const { cmd, dir, env } = liveAgy(t, { FAKE_HELLO: '0' });
  const child = spawn(cmd, [], { cwd: dir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const driver = new AgyDriver({
    cmd, args: [], cwd: dir, env,
    procHost: heldBy(child), procId: 'a2', openTurn: () => 'turn-live',
  });
  const log = collect(driver);
  await driver.start();
  assert.equal(driver.status, 'working');
  // Its result arrives (here: answered to a nudge) and settles that turn.
  child.stdin.write(JSON.stringify({ event: 'user', message: { content: 'x' } }) + '\n');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.turnId, 'turn-live');
  assert.equal(driver.status, 'idle');
});

test('agy: work it starts by itself is its own turn, open through a quiet gap until its result', async (t) => {
  const { cmd, dir, env } = liveAgy(t, { FAKE_WAKE: '1' });
  const driver = new AgyDriver({ cmd, args: [], cwd: dir, env });
  t.after(() => driver.kill());
  const log = collect(driver);
  await driver.send('go');
  await log.until((e) => e.type === 'turn.done');
  const first = log.of('turn.start')[0];
  const wake = await log.until((e) => e.type === 'turn.start' && e.wake === true);
  assert.equal(wake.text, '');
  assert.match(wake.turnId, /^wake-/);
  await log.until((e) => e.type === 'item.done' && log.of('item.start').some((s) => s.id === e.id && s.turnId === wake.turnId));
  // Quiet: nothing for most of half a second. That is not the end of the work.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(log.of('turn.done').length, 1, 'a quiet gap does not close the wake-up');
  assert.equal(driver.status, 'working');
  const done = await log.until((e) => e.type === 'turn.done' && e.turnId === wake.turnId);
  assert.equal(done.status, 'ok');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(log.of('turn.done').map((e) => e.turnId), [first.turnId, wake.turnId], 'each turn closes once, the repeated result closes nothing');
  assert.equal(driver.status, 'idle');
  const texts = log.of('item.start').filter((e) => e.kind === 'text').map((e) => e.turnId);
  assert.deepEqual(texts, [first.turnId, wake.turnId, wake.turnId]);
});
