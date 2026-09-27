import { test } from 'node:test';
import assert from 'node:assert/strict';
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
