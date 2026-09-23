import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

test('devin: /usage answers locally - the quota card, not an ACP prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-devin-usage-'));
  const account = join(root, 'devin');
  mkdirSync(join(account, 'cli'), { recursive: true });
  writeFileSync(join(account, 'credentials.toml'),
    'windsurf_api_key = "devin-session-token$test"\napi_server_url = "https://server.codeium.com"\n');
  const { driver, log, fake } = make('plain', {
    env: { XDG_DATA_HOME: root },
    fetchStatus: async () => ({
      planStatus: {
        planInfo: { planName: 'Pro', billingStrategy: 'BILLING_STRATEGY_QUOTA' },
        dailyQuotaRemainingPercent: 95,
        weeklyQuotaRemainingPercent: 79,
        dailyQuotaResetAtUnix: String(Math.floor(Date.now() / 1000) + 20 * 3600),
        weeklyQuotaResetAtUnix: String(Math.floor(Date.now() / 1000) + 5 * 86400),
      },
    }),
  });
  assert.equal(driver.canRunWhileBusy('/usage'), true, 'a read does not wait on a live turn');
  await driver.send('/usage');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(log.of('turn.start')[0].text, '/usage', 'the bubble keeps the spelling that was typed');
  assert.equal(log.of('turn.start')[0].local, true, 'the turn says helm answered it itself - it lands inside a live turn');
  const body = log.of('item.delta').map((e) => e.text).join('');
  assert.match(body, /### Usage/);
  assert.match(body, /\*\*Daily\*\* `█░{19}` 5% used · resets in \d+h \d+m/);
  assert.match(body, /\*\*Weekly\*\* `████░{16}` 21% used · resets \w{3} \d+, \d+:\d{2} [AP]M \(UTC[+-][\d:]+\)/);
  assert.match(body, /\*No quota consumed yet in this session\.\*/);
  // The whole point: ACP never hears about it - not even the process spawn.
  assert.equal(fake.stdinLines().length, 0);
  await driver.kill();
});

test('devin: a refused model says so, and the record lands on what is running', async () => {
  const fake = fakeCli('devin', 'refuse-model');
  const driver = new DevinDriver({
    cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'edit', model: 'swe-2-max',
  });
  const log = collect(driver);
  await driver.start();
  // `devin models list` still prints swe-2-max; the session picker does not
  // take it. Until now that refusal only ever reached the daemon's own log.
  const err = log.of('error').find((e) => /swe-2-max/.test(e.message));
  assert.ok(err, 'the refusal is an event the app can show');
  const corrected = log.of('settings').find((e) => 'model' in e);
  assert.equal(corrected.model, 'swe-2-high', 'the record names the model actually running');
  assert.equal(driver.model, 'swe-2-high');
  assert.equal(driver.info.model, 'swe-2-high');
  const modeCall = fake.stdinLines().find((l) => l.method === 'session/set_config_option' && l.params.configId === 'model');
  assert.equal(modeCall.params.value, 'swe-2-max');

  // The advertised picker is also what catalog() reports - thinking included.
  assert.deepEqual(driver.catalog().models, ['swe-2-high', 'gpt-6-luna-medium', 'gpt-6-sol-medium']);
  assert.deepEqual(driver.catalog().efforts, ['medium', 'high', 'max']);
  assert.equal(driver.catalog().current, 'swe-2-high');

  // Mid-session is the same story: refused, corrected, told.
  await driver.setModel('swe-2-max');
  assert.equal(driver.model, 'swe-2-high');
  assert.equal(log.of('error').filter((e) => /swe-2-max/.test(e.message)).length, 2);
  await driver.setModel('gpt-6-luna-medium');
  assert.equal(driver.model, 'gpt-6-luna-medium');
  await driver.setEffort('high');
  assert.equal(driver.effort, 'high');
  await driver.setEffort('bogus');
  assert.equal(driver.effort, 'high', 'a refused effort snaps back to the agent\'s level');
  assert.equal(log.of('error').filter((e) => /bogus/.test(e.message)).length, 1);
  await driver.kill();
});

test('opencode: no fallback list means an unadvertised palette is empty', async () => {
  const fake = fakeCli('opencode', 'plain');
  const driver = new OpencodeDriver({ cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'ask' });
  assert.deepEqual(await driver.availableCommands(), []);
  await driver.kill();
});
