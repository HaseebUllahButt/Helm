import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCli, collect } from './helpers.mjs';
import { DevinDriver, DEVIN_COMMANDS } from '../packages/connect/src/drivers/devin.js';
import { OpencodeDriver } from '../packages/connect/src/drivers/opencode.js';

// The mode-switch stream is a `devin acp` session whose agent reports the
// state it loaded up front (mode accept-edits, model swe-2-max) and then,
// after a prompt, reports switching itself: a current_mode_update 'ask' and
// a config_option_update carrying mode 'ask' plus model swe-2-fast - what
// typing /ask and /fast into the CLI itself produces.
const make = (fixture, opts = {}) => {
  const fake = fakeCli('devin', fixture);
  const driver = new DevinDriver({
    cmd: fake.cmd, env: {}, args: [],
    cwd: fake.dir, mode: 'edit', ...opts,
  });
  return { fake, driver, log: collect(driver) };
};

test('devin: the agent switching its own mode lands as a settings event', async () => {
  const { driver, log } = make('mode-switch');
  await driver.send('/ask');
  await log.until((e) => e.type === 'turn.done');
  const mode = await log.until((e) => e.type === 'settings' && e.mode);
  assert.equal(mode.mode, 'read', 'acp "ask" maps back to helm\'s read mode');
  assert.equal(driver.mode, 'read');
  const model = await log.until((e) => e.type === 'settings' && e.model);
  assert.equal(model.model, 'swe-2-fast', 'a moved model picker value is a settings event');
  assert.equal(driver.model, 'swe-2-fast');
  // The config_option_update echoing the same mode switch must not fire a
  // second mode event: one change, one event.
  assert.equal(log.of('settings').filter((e) => e.mode).length, 1);
  await driver.kill();
});

test('devin: the state the agent loaded cannot pass for a change it made', async () => {
  const { driver, log, fake } = make('mode-switch', { mode: 'read' });
  await driver.send('/ask');
  await log.until((e) => e.type === 'settings');
  const sent = fake.stdinLines();
  const modeCall = sent.find((l) => l.method === 'session/set_config_option' && l.params.configId === 'mode');
  assert.equal(modeCall.params.value, 'ask', 'helm\'s stored mode is applied, not the mode the agent reported');
  assert.equal(driver.mode, 'read');
  // The agent's 'ask' agrees with helm's 'read', and nothing else moved but
  // the model - so the whole run is exactly one settings event.
  assert.deepEqual(log.of('settings'), [{ type: 'settings', model: 'swe-2-fast' }]);
  await driver.kill();
});

test('devin: a session that never advertises commands still has devin\'s palette', async () => {
  const { driver } = make('mode-switch');
  const commands = await driver.availableCommands();
  assert.equal(commands, DEVIN_COMMANDS);
  for (const name of ['status', 'fast', 'mcp', 'rename', 'help']) {
    assert.ok(commands.some((c) => c.name === name), `/${name} is offered`);
  }
  assert.equal(commands.filter((c) => c.name === 'usage').length, 1, '/usage is offered exactly once');
  await driver.kill();
});

test('devin: advertised commands win over the static fallback', async () => {
  const { driver, log } = make('plain');
  await driver.send('Reply with exactly the words: hello from helm');
  await log.until((e) => e.type === 'turn.done');
  const commands = await driver.availableCommands();
  // 'handoff' is a skill devin advertised in the recording; it is not in the
  // static list, so its presence proves the advertised list won.
  assert.ok(commands.some((c) => c.name === 'handoff'));
  assert.ok(commands.some((c) => c.name === 'status'));
  // The alias is not advertised either - devin only knows /session-stats -
  // so it is appended to the winning list rather than lost with the fallback.
  assert.equal(commands.filter((c) => c.name === 'usage').length, 1, '/usage joins the advertised list exactly once');
  await driver.kill();
});

test('devin: /usage is what the owner typed, /session-stats is what the wire gets', async () => {
  const { driver, log, fake } = make('plain');
  await driver.send('/usage');
  await log.until((e) => e.type === 'turn.done');
  assert.equal(log.of('turn.start')[0].text, '/usage', 'the bubble keeps the spelling that was typed');
  const prompt = fake.stdinLines().find((l) => l.method === 'session/prompt');
  assert.deepEqual(prompt.params.prompt, [{ type: 'text', text: '/session-stats' }]);
  await driver.kill();
});

test('opencode: no fallback list means an unadvertised palette is empty', async () => {
  const fake = fakeCli('opencode', 'plain');
  const driver = new OpencodeDriver({ cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'ask' });
  assert.deepEqual(await driver.availableCommands(), []);
  await driver.kill();
});
