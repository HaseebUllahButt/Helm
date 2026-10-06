import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeCli, collect } from './helpers.mjs';
import { DevinDriver, DEVIN_COMMANDS, normalizeDevinModel } from '../packages/connect/src/drivers/devin.js';
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

const FUSION_ALIAS = 'fusion-gpt-6-1-sol-medium-sidekick-swe-2-high';
const FUSION_CANONICAL = 'fusion-gpt-6-1-sol-high-sidekick-swe-2-high';

const fusionOptions = (effort = 'high') => [
  { id: 'mode', currentValue: 'accept-edits', options: [{ value: 'accept-edits', name: 'Code' }] },
  { id: 'model', currentValue: FUSION_CANONICAL, options: [{ value: FUSION_CANONICAL, name: 'Fusion Sol High' }] },
  { id: 'thought_level', currentValue: effort, options: [
    { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' },
  ] },
];

const adoptPipe = ({ response, buffered = [] } = {}) => {
  let onData;
  let onExit;
  let closed = false;
  const writes = [];
  const emit = (message) => onData?.(`${JSON.stringify(message)}\n`);
  const finish = () => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => onExit?.({ code: 0 }));
  };
  return {
    writes,
    write(data) {
      const message = JSON.parse(data);
      writes.push(message);
      if (message.method === 'session/set_config_option') {
        queueMicrotask(() => emit({ jsonrpc: '2.0', id: message.id, ...response(message) }));
      }
    },
    end: finish,
    kill: finish,
    onData(callback) {
      onData = callback;
      for (const message of buffered) queueMicrotask(() => emit(message));
    },
    onExit(callback) { onExit = callback; },
    detach() {},
  };
};

const hosted = (pipe, id = 'adopted') => ({
  openCalls: 0,
  hasProc: (candidate) => candidate === id,
  procPipe: (candidate) => candidate === id ? pipe : null,
  async openProc() { this.openCalls++; },
});

const pendingPermission = {
  requestId: 'permission-1', acpId: 42,
  acpOptions: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }],
};

test('devin: hosted adoption hydrates the catalog with a same-value effort setter', async (t) => {
  const fake = fakeCli('devin', 'plain');
  const pipe = adoptPipe({ response: () => ({ result: { configOptions: fusionOptions('high') } }) });
  const procHost = hosted(pipe);
  const messages = [];
  const driver = new DevinDriver({
    cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'edit',
    model: FUSION_CANONICAL, effort: 'high', engineSessionId: 'e910dc39002c',
    procHost, procId: 'adopted', openTurn: () => 'turn-live',
    pendingEvents: () => [pendingPermission], log: (message) => messages.push(message),
  });
  const events = collect(driver);
  t.after(() => driver.kill());

  await driver.start();
  assert.deepEqual(driver.info, { model: FUSION_CANONICAL, effort: 'high' });
  assert.deepEqual(driver.catalog().models, [FUSION_CANONICAL]);
  assert.equal(driver.catalog().effort, 'high');
  assert.equal(driver.pending.has('permission-1'), true);
  assert.equal(procHost.openCalls, 0);
  assert.deepEqual(pipe.writes.map((m) => m.method), ['session/set_config_option']);
  assert.deepEqual(pipe.writes[0].params, {
    sessionId: 'e910dc39002c', configId: 'thought_level', value: 'high',
  });
  assert.deepEqual(events.of('error'), []);
  assert.deepEqual(messages, []);

  await driver.answer('permission-1', { option: 'allow' });
  assert.equal(pipe.writes.at(-1).id, 42, 'the restored pending permission remains answerable');
});

test('devin: hosted adoption falls back to the stored model when effort is absent', async (t) => {
  const fake = fakeCli('devin', 'plain');
  const pipe = adoptPipe({ response: () => ({ result: { configOptions: fusionOptions('high') } }) });
  const procHost = hosted(pipe);
  const driver = new DevinDriver({
    cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'edit',
    model: FUSION_CANONICAL, engineSessionId: 'e910dc39002c',
    procHost, procId: 'adopted',
  });
  t.after(() => driver.kill());

  await driver.start();
  assert.deepEqual(pipe.writes.map((m) => [m.method, m.params.configId, m.params.value]), [
    ['session/set_config_option', 'model', FUSION_CANONICAL],
  ]);
  assert.deepEqual(driver.info, { model: FUSION_CANONICAL, effort: 'high' });
});

test('devin: failed adoption refresh preserves the open turn and saved settings', async (t) => {
  const fake = fakeCli('devin', 'plain');
  const pipe = adoptPipe({ response: () => ({ error: { code: -32001, message: 'catalog unavailable' } }) });
  const procHost = hosted(pipe);
  const messages = [];
  const driver = new DevinDriver({
    cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'edit',
    model: FUSION_CANONICAL, effort: 'high', engineSessionId: 'e910dc39002c',
    procHost, procId: 'adopted', openTurn: () => 'turn-live',
    pendingEvents: () => [pendingPermission], log: (message) => messages.push(message),
  });
  const events = collect(driver);
  t.after(() => driver.kill());

  await driver.start();
  assert.equal(driver.model, FUSION_CANONICAL);
  assert.equal(driver.effort, 'high');
  assert.deepEqual(events.of('error'), []);
  assert.equal(driver.pending.has('permission-1'), true);
  assert.ok(messages.some((message) => /adoption config refresh unavailable/.test(message)));
  assert.deepEqual(pipe.writes.map((m) => m.method), ['session/set_config_option']);
});

test('devin: buffered config options avoid an adoption refresh RPC', async (t) => {
  const fake = fakeCli('devin', 'plain');
  const pipe = adoptPipe({
    response: () => { throw new Error('refresh should be skipped'); },
    buffered: [{
      jsonrpc: '2.0', method: 'session/update',
      params: { update: { sessionUpdate: 'config_option_update', configOptions: fusionOptions('high') } },
    }],
  });
  const procHost = hosted(pipe);
  const driver = new DevinDriver({
    cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'edit',
    model: FUSION_CANONICAL, effort: 'high', engineSessionId: 'e910dc39002c',
    procHost, procId: 'adopted',
  });
  t.after(() => driver.kill());

  await driver.start();
  assert.equal(pipe.writes.length, 0);
  assert.deepEqual(driver.info, { model: FUSION_CANONICAL, effort: 'high' });
  assert.equal(driver.catalog().current, FUSION_CANONICAL);
});

test('opencode: hosted adoption without a callback stays zero-RPC', async (t) => {
  const fake = fakeCli('opencode', 'plain');
  const pipe = adoptPipe({ response: () => { throw new Error('adoption should not write'); } });
  const procHost = hosted(pipe, 'opencode-adopted');
  const driver = new OpencodeDriver({
    cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'ask',
    engineSessionId: 'opencode-session', procHost, procId: 'opencode-adopted',
  });
  t.after(() => driver.kill());

  await driver.start();
  assert.deepEqual(pipe.writes, []);
});

test('devin: an unadvertised Fusion effort maps to the advertised model and thought level', async (t) => {
  const { driver, log, fake } = make('fusion-initial', { model: FUSION_ALIAS });
  t.after(() => driver.kill());
  let init;
  driver.on('init', (info) => { init = info; });
  await driver.start();
  assert.equal(driver.model, FUSION_CANONICAL);
  assert.equal(driver.effort, 'medium');
  assert.equal(driver.catalog().current, FUSION_CANONICAL);
  assert.equal(driver.catalog().effort, 'medium');
  assert.deepEqual(driver.info, { model: FUSION_CANONICAL, effort: 'medium' });
  assert.deepEqual(init, { model: FUSION_CANONICAL, effort: 'medium' });
  assert.deepEqual(log.of('error'), []);
  assert.ok(log.of('settings').some((e) => e.model === FUSION_CANONICAL));
  assert.ok(log.of('settings').some((e) => e.effort === 'medium'));
  assert.deepEqual(
    fake.stdinLines().filter((l) => l.method === 'session/set_config_option').map((l) => [l.params.configId, l.params.value]),
    [['model', FUSION_CANONICAL], ['thought_level', 'medium'], ['mode', 'accept-edits']],
  );
});

test('devin: a Fusion alias still applies thought level when its canonical model is current', async (t) => {
  const { driver, log, fake } = make('fusion-mid', { model: FUSION_CANONICAL, effort: 'high' });
  t.after(() => driver.kill());
  await driver.start();
  const settingsBefore = log.of('settings').length;
  await driver.setModel(FUSION_ALIAS);
  assert.equal(driver.model, FUSION_CANONICAL);
  assert.equal(driver.effort, 'medium');
  assert.equal(driver.catalog().current, FUSION_CANONICAL);
  assert.equal(driver.catalog().effort, 'medium');
  assert.ok(log.of('settings').slice(settingsBefore).some((e) => e.model === FUSION_CANONICAL));
  assert.ok(log.of('settings').slice(settingsBefore).some((e) => e.effort === 'medium'));
  const calls = fake.stdinLines().filter((l) => l.method === 'session/set_config_option');
  assert.deepEqual(calls.slice(-2).map((l) => [l.params.configId, l.params.value]), [
    ['model', FUSION_CANONICAL], ['thought_level', 'medium'],
  ]);
  assert.deepEqual(log.of('error'), []);
});

test('devin: model normalization only translates an unadvertised, unambiguous Fusion variant', () => {
  const requested = 'fusion-gpt-6-2-sol-medium-sidekick-swe-2-high';
  const candidate = 'fusion-gpt-6-2-sol-high-sidekick-swe-2-high';
  const catalog = { models: [candidate], efforts: ['medium', 'high'] };
  assert.deepEqual(normalizeDevinModel(requested, catalog), { model: candidate, effort: 'medium' });
  assert.equal(normalizeDevinModel(candidate, catalog), null);
  assert.equal(normalizeDevinModel('gpt-6-2-sol-medium', { models: [candidate], efforts: ['medium', 'high'] }), null);
  assert.equal(normalizeDevinModel(requested, null), null);
  assert.equal(normalizeDevinModel(requested, { models: [candidate], efforts: ['high'] }), null);
  assert.equal(normalizeDevinModel(requested, { models: ['fusion-gpt-6-2-sol-high-sidekick-swe-2-low'], efforts: ['medium', 'high'] }), null);
  assert.equal(normalizeDevinModel(requested, { models: [candidate, 'fusion-gpt-6-2-sol-xhigh-sidekick-swe-2-high'], efforts: ['medium', 'high'] }), null);
  assert.equal(normalizeDevinModel(requested, { models: ['fusion-gpt-6-2-sol-high-sidekick-other-high'], efforts: ['medium', 'high'] }), null);
});

test('devin: a mapped model refusal does not send its thought level', async (t) => {
  const { driver, log, fake } = make('fusion-model-refused', { model: FUSION_ALIAS });
  t.after(() => driver.kill());
  await driver.start();
  assert.equal(driver.model, FUSION_CANONICAL);
  assert.equal(driver.info.effort, 'high');
  assert.equal(log.of('error').filter((e) => e.kind === 'settings').length, 1);
  assert.equal(fake.stdinLines().some((l) => l.method === 'session/set_config_option' && l.params.configId === 'thought_level'), false);
});

test('devin: a refused mapped thought level keeps the accepted model and actual effort', async (t) => {
  const { driver, log } = make('fusion-effort-refused', { model: FUSION_ALIAS });
  t.after(() => driver.kill());
  await driver.start();
  assert.equal(driver.model, FUSION_CANONICAL);
  assert.equal(driver.effort, 'high');
  assert.equal(driver.info.effort, 'high');
  assert.ok(log.of('error').some((e) => e.kind === 'settings' && /medium/.test(e.message)));
  assert.equal(log.of('error').some((e) => e.kind === 'settings' && /model.*refused|model.*offer/i.test(e.message)), false);
});

test('devin: explicit startup effort wins over a normalized Fusion effort', async (t) => {
  const { driver } = make('fusion-initial', { model: FUSION_ALIAS, effort: 'high' });
  t.after(() => driver.kill());
  await driver.start();
  assert.equal(driver.model, FUSION_CANONICAL);
  assert.equal(driver.effort, 'high');
  assert.equal(driver.catalog().effort, 'high');
  assert.deepEqual(driver.info, { model: FUSION_CANONICAL, effort: 'high' });
});

test('devin: empty setting acknowledgments preserve accepted model and effort', async (t) => {
  const { driver, log } = make('empty-ack', { model: 'gpt-6-sol-medium', effort: 'medium' });
  t.after(() => driver.kill());
  await driver.start();
  assert.equal(driver.model, 'gpt-6-sol-medium');
  assert.equal(driver.effort, 'medium');
  assert.equal(driver.catalog().current, 'gpt-6-sol-medium');
  assert.equal(driver.catalog().effort, 'medium');
  assert.deepEqual(driver.info, { model: 'gpt-6-sol-medium', effort: 'medium' });
  assert.deepEqual(log.of('error'), []);
});

test('opencode: no fallback list means an unadvertised palette is empty', async () => {
  const fake = fakeCli('opencode', 'plain');
  const driver = new OpencodeDriver({ cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'ask' });
  assert.deepEqual(await driver.availableCommands(), []);
  await driver.kill();
});

test('opencode: model changes replace effort options and clear models without effort', async (t) => {
  const fake = fakeCli('opencode', 'model-efforts');
  const driver = new OpencodeDriver({ cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'ask' });
  t.after(() => driver.kill());
  const log = collect(driver);
  await driver.start();
  assert.deepEqual(driver.catalog().efforts, ['low', 'high', 'max']);
  await driver.setModel('provider/light');
  assert.deepEqual(driver.catalog().efforts, ['low', 'medium']);
  assert.equal(driver.catalog().effort, 'low');
  assert.equal(driver.effort, 'low');
  assert.ok(log.of('settings').some((e) => e.effort === 'low'));
  await driver.setModel('provider/plain');
  assert.deepEqual(driver.catalog().efforts, []);
  assert.equal(driver.effort, null);
  assert.ok(log.of('settings').some((e) => Object.hasOwn(e, 'effort') && e.effort === null));
  await driver.setModel('provider/heavy');
  assert.deepEqual(driver.catalog().efforts, ['low', 'high', 'max']);
  assert.equal(driver.catalog().effort, 'high');
  assert.equal(driver.effort, 'high');
});
