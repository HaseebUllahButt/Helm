import { test } from 'node:test';
import assert from 'node:assert/strict';
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
