import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCli, collect } from './helpers.mjs';
import { OpencodeDriver } from '../packages/connect/src/drivers/opencode.js';
import { DevinDriver } from '../packages/connect/src/drivers/devin.js';

// Both ACP engines run the same turn against the same vocabulary; the only
// difference is argv and which session modes exist. The devin fixtures are
// recorded from a real `devin acp`; the opencode ones are written by hand
// from its handshake - its providers were down when this was recorded.
const CASES = { devin: DevinDriver, opencode: OpencodeDriver };

const make = (engine, name, opts = {}) => {
  const fake = fakeCli(engine, name);
  const driver = new CASES[engine]({
    cmd: fake.cmd, env: {}, args: [],
    cwd: fake.dir, mode: engine === 'devin' ? 'edit' : 'ask', ...opts,
  });
  return { fake, driver, log: collect(driver) };
};

for (const engine of ['devin', 'opencode']) {
  test(`${engine}: initialize, session/new, set mode, prompt; text streams as deltas`, async () => {
    const { driver, log, fake } = make(engine, 'plain');
    await driver.send('Reply with exactly the words: hello from helm');
    const done = await log.until((e) => e.type === 'turn.done');
    assert.equal(done.status, 'ok');
    assert.ok(driver.engineSessionId, 'the ACP session id is remembered for resume');
    const text = log.of('item.start').find((e) => e.kind === 'text');
    assert.equal(
      log.of('item.delta').filter((e) => e.id === text.id).map((e) => e.text).join('').replace(/\s+$/, ''),
      'hello from helm'
    );
    assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);

    const sent = fake.stdinLines();
    assert.equal(sent[0].method, 'initialize');
    assert.equal(sent[1].method, 'session/new');
    assert.deepEqual(sent[1].params, { cwd: fake.dir, mcpServers: [] });
    const modeCall = sent.find((l) => l.method === 'session/set_config_option' && l.params.configId === 'mode');
    assert.equal(modeCall.params.value, engine === 'devin' ? 'accept-edits' : 'build');
    const prompt = sent.find((l) => l.method === 'session/prompt');
    assert.equal(prompt.params.sessionId, driver.engineSessionId);
    assert.deepEqual(prompt.params.prompt, [{ type: 'text', text: 'Reply with exactly the words: hello from helm' }]);
    await driver.kill();
  });

  test(`${engine}: a command item asks; allow_once runs it and the output lands`, async () => {
    const { driver, log, fake } = make(engine, 'command');
    await driver.send('run it');
    const ask = await log.until((e) => e.type === 'permission.request');
    assert.equal(ask.kind, 'command');
    assert.deepEqual(ask.options.map((o) => o.role), ['allow', 'allow-always', 'deny']);
    assert.equal(driver.status, 'blocked');
    const cmd = log.of('item.start').find((e) => e.kind === 'command');
    assert.ok(cmd, 'the command item started before the ask');
    assert.equal(ask.itemId, cmd.id);
    assert.match(String(ask.detail), /echo helm-test|curl/);

    await driver.answer(ask.requestId, { option: 'allow' });
    const done = await log.until((e) => e.type === 'turn.done');
    assert.equal(done.status, 'ok');
    const cmdDone = log.of('item.done').find((e) => e.id === cmd.id);
    assert.equal(cmdDone.status, 'ok');
    const reply = fake.stdinLines().find((l) => l.id !== undefined && l.result?.outcome);
    const allowId = engine === 'devin' ? 'allow_once' : 'once';
    assert.deepEqual(reply.result, { outcome: { outcome: 'selected', optionId: allowId } });
    await driver.kill();
  });

  test(`${engine}: interrupt sends session/cancel and the turn ends interrupted`, async () => {
    const { driver, log, fake } = make(engine, 'interrupt');
    await driver.send('count');
    await log.until((e) => e.type === 'item.delta');
    await driver.interrupt();
    const done = await log.until((e) => e.type === 'turn.done');
    assert.equal(done.status, 'interrupted');
    // The cancel rides stdin; give the fake a beat to log it.
    let cancel;
    for (let i = 0; i < 50 && !cancel; i++) {
      await new Promise((r) => setTimeout(r, 20));
      cancel = fake.stdinLines().find((l) => l.method === 'session/cancel');
    }
    assert.equal(cancel?.params.sessionId, driver.engineSessionId);
    await driver.kill();
  });
}

test('devin: the session names itself and the title reaches helm', async () => {
  const { driver, log } = make('devin', 'plain');
  await driver.send('Reply with exactly the words: hello from helm');
  await log.until((e) => e.type === 'turn.done');
  const titled = log.of('title');
  assert.equal(titled.length, 1);
  assert.equal(titled[0].title, 'Reply with exactly the words: hello from helm');
  await driver.kill();
});

test('devin: the permission sheet carries the editable command', async () => {
  const { driver, log } = make('devin', 'command');
  await driver.send('run curl');
  const ask = await log.until((e) => e.type === 'permission.request');
  assert.match(String(ask.detail), /curl/);
  await driver.answer(ask.requestId, { option: 'deny' });
  await driver.kill();
});

test('devin: decline answers reject_once and the tool ends declined', async () => {
  const { driver, log, fake } = make('devin', 'decline');
  await driver.send('run curl');
  const ask = await log.until((e) => e.type === 'permission.request');
  await driver.answer(ask.requestId, { option: 'deny' });
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  const reply = fake.stdinLines().find((l) => l.id !== undefined && l.result?.outcome);
  assert.equal(reply.result.outcome.optionId, 'reject_once');
  await driver.kill();
});

test('opencode: edit mode auto-allows edits but still asks for commands', async () => {
  const { driver, log } = make('opencode', 'command', { mode: 'edit' });
  await driver.send('run it');
  // The recorded ask is for a command, so it still reaches the phone.
  const ask = await log.until((e) => e.type === 'permission.request');
  assert.equal(ask.kind, 'command');
  await driver.answer(ask.requestId, { option: 'allow' });
  await log.until((e) => e.type === 'turn.done');
  await driver.kill();
});

test('opencode: a task tool call is a subagent card', async () => {
  const { driver, log } = make('opencode', 'subagent');
  await driver.send('spawn a subagent');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  const card = log.of('item.start').find((e) => e.kind === 'subagent');
  assert.ok(card, 'the task tool_call became a subagent item');
  assert.equal(card.id, 'call_task1');
  assert.equal(card.name, 'task');
  assert.equal(card.agent.status, 'running');
  const cardDone = log.of('item.done').find((e) => e.id === card.id);
  assert.equal(cardDone.status, 'ok');
  assert.match(cardDone.output, /5 files/);
  await driver.kill();
});

test('devin: run_subagent is a card; the child\'s own tools nest under it', async () => {
  const { driver, log } = make('devin', 'subagent');
  await driver.send('delegate');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  const card = log.of('item.start').find((e) => e.kind === 'subagent');
  assert.ok(card, 'run_subagent became a subagent item');
  assert.equal(card.name, 'run_subagent');
  assert.equal(card.agent.status, 'running');
  // The child's find_file_by_name carries subagent_context: it nests, it is
  // not a card itself.
  const child = log.of('item.start').find((e) => e.name === 'find_file_by_name');
  assert.equal(child.kind, 'tool');
  assert.equal(child.parentId, card.id);
  const cardDone = log.of('item.done').find((e) => e.id === card.id);
  assert.match(cardDone.output, /4 files/);
  await driver.kill();
});

test('opencode: auto mode answers a permission request without asking the phone', async () => {
  const { driver, log } = make('opencode', 'command', { mode: 'auto' });
  await driver.send('run it');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(log.of('permission.request').length, 0);
  await driver.kill();
});
