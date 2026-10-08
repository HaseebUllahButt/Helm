import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeCli, collect } from './helpers.mjs';
import { OpencodeDriver, Opencode2Driver } from '../packages/connect/src/drivers/opencode.js';
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
    if (engine === 'devin') {
      const commands = await driver.availableCommands();
      assert.ok(commands.some((command) => command.name === 'status'));
      assert.ok(commands.some((command) => command.name === 'compact'));
    }
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

test('opencode2: the separate v2 driver starts an ACP session and exposes commands', async () => {
  const fake = fakeCli('opencode', 'plain');
  const driver = new Opencode2Driver({
    cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'ask',
  });
  const log = collect(driver);
  assert.deepEqual(driver.args, ['acp'], 'v2 has no --cwd flag');
  await driver.send('Reply with exactly the words: hello from helm');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(driver.engine, 'opencode2');
  const modeCall = fake.stdinLines().find(
    (l) => l.method === 'session/set_config_option' && l.params.configId === 'mode',
  );
  assert.equal(modeCall.params.value, 'build');
  await driver.kill();
});

test('a missing folder is named, not reported as a missing CLI', async () => {
  // Node says `spawn devin ENOENT` for a cwd that is not there, which read as
  // "devin is not installed" while devin sat on PATH.
  const { DevinDriver } = await import('../packages/connect/src/drivers/devin.js');
  const d = new DevinDriver({ cmd: 'devin', env: {}, args: [], cwd: '/no/such/folder/for/helm', mode: 'edit' });
  const seen = [];
  d.on('event', (e) => seen.push(e));
  await assert.rejects(d.start(), /folder \/no\/such\/folder\/for\/helm does not exist/);
  assert.equal(seen[0]?.type, 'error');
});

// ------------------------------------------------- lifecycle status (live)
//
// A small live ACP agent rather than a recording: these cases are about
// timing - two questions at once, a cancel that has to be answered, a slow
// handshake - which a replay cannot pace. FAKE_SCENARIO picks the prompt's
// behaviour; everything else answers at once.
const LIVE_AGENT = `
if (process.argv.includes('--version')) { console.log('devin 3000.10.21'); process.exit(0); }
const { appendFileSync } = await import('node:fs');
if (process.env.FAKE_SPAWNS) appendFileSync(process.env.FAKE_SPAWNS, 'spawn\\n');
const scenario = process.env.FAKE_SCENARIO ?? 'plain';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const replies = new Map();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    if (process.env.FAKE_STDIN) appendFileSync(process.env.FAKE_STDIN, line + '\\n');
    onMessage(JSON.parse(line));
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 20));
const ask = (sid, id) => {
  const answered = new Promise((resolve) => replies.set(id, resolve));
  out({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId: sid,
    toolCall: { toolCallId: 'call-' + id, title: 'Run ' + id, rawInput: { command: 'echo ' + id } },
    options: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
    ],
  } });
  return answered;
};
const cancelled = (r) => r?.result?.outcome?.outcome === 'cancelled';
async function onMessage(m) {
  if (m.id !== undefined && !m.method) { replies.get(m.id)?.(m); return; }
  const reply = (result) => out({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      await sleep(Number(process.env.FAKE_INIT_MS ?? 0));
      return reply({ protocolVersion: 1, agentCapabilities: {} });
    case 'session/new': return reply({ sessionId: 'live-1' });
    case 'session/load': return reply({});
    case 'session/set_config_option': return reply({});
    case 'session/cancel': return; // a spec agent waits for its open asks to be answered
    case 'session/prompt': {
      const sid = m.params.sessionId;
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } } });
      if (scenario === 'two-asks') {
        await Promise.all([ask(sid, 'perm-a'), ask(sid, 'perm-b')]);
        return reply({ stopReason: 'end_turn' });
      }
      if (scenario === 'ask-cancel') {
        const r = await ask(sid, 'perm-c');
        return reply({ stopReason: cancelled(r) ? 'cancelled' : 'end_turn' });
      }
      if (scenario === 'error') {
        await sleep(Number(process.env.FAKE_TURN_MS ?? 0));
        return out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'model overloaded' } });
      }
      if (scenario === 'ask-abandon') {
        ask(sid, 'perm-d');
        await sleep(50);
        return reply({ stopReason: 'end_turn' });
      }
      await sleep(Number(process.env.FAKE_TURN_MS ?? 0));
      return reply({ stopReason: 'end_turn' });
    }
    default:
      if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no ' + m.method } });
  }
}
`;

const live = (t, scenario, env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-acp-live-'));
  const script = join(dir, 'agent.mjs');
  writeFileSync(script, LIVE_AGENT);
  const cmd = join(dir, 'devin');
  writeFileSync(cmd, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(cmd, 0o755);
  const stdin = join(dir, 'stdin.ndjson');
  const driver = new DevinDriver({
    cmd, args: [], cwd: dir, mode: 'ask',
    env: { FAKE_SCENARIO: scenario, FAKE_STDIN: stdin, ...env },
  });
  const sent = () => (existsSync(stdin) ? readFileSync(stdin, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  t.after(() => driver.kill());
  return { driver, log: collect(driver), sent, cmd, dir, env: driver.env };
};

test('acp: answering one of two open questions keeps the session on "needs you"', async (t) => {
  const { driver, log } = live(t, 'two-asks');
  await driver.send('two things');
  await log.until(() => log.of('permission.request').length === 2);
  assert.equal(driver.status, 'blocked');
  const [a, b] = log.of('permission.request');

  await driver.answer(a.requestId, { option: 'allow' });
  assert.equal(driver.status, 'blocked', 'the second question is still waiting on the owner');
  await driver.answer(b.requestId, { option: 'allow' });
  assert.equal(driver.status, 'working');

  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(driver.status, 'idle');
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'blocked', 'working', 'idle']);
  await driver.kill();
});

test('acp: stop while a question waits answers it cancelled and the turn really ends', async (t) => {
  const { driver, log, sent } = live(t, 'ask-cancel');
  await driver.send('risky');
  const ask = await log.until((e) => e.type === 'permission.request');
  assert.equal(driver.status, 'blocked');

  await driver.interrupt();
  // The card is gone and the session is still winding down, not idle.
  assert.ok(log.of('permission.resolved').some((e) => e.requestId === ask.requestId && e.decision === 'cancelled'));
  assert.equal(driver.pending.size, 0);
  assert.equal(driver.status, 'working');

  // Without the cancelled answer the agent never returns from the prompt.
  const done = await log.until((e) => e.type === 'turn.done', 3000);
  assert.equal(done.status, 'interrupted');
  assert.equal(driver.status, 'idle');
  const answer = sent().find((l) => l.id === 'perm-c' && l.result);
  assert.deepEqual(answer.result, { outcome: { outcome: 'cancelled' } });
  await driver.kill();
});

test('acp: a prompt that ends with a question still open closes the card and goes idle', async (t) => {
  const { driver, log } = live(t, 'ask-abandon');
  await driver.send('quick');
  const ask = await log.until((e) => e.type === 'permission.request');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.ok(log.of('permission.resolved').some((e) => e.requestId === ask.requestId && e.decision === 'cancelled'));
  assert.equal(driver.pending.size, 0);
  assert.equal(driver.status, 'idle');
  await driver.kill();
});

test('acp: a cold start reads as working before the prompt goes out', async (t) => {
  const { driver, log } = live(t, 'plain', { FAKE_INIT_MS: '300' });
  const sending = driver.send('hello');
  await log.until((e) => e.type === 'status');
  assert.equal(driver.status, 'working', 'starting the agent is part of answering');
  assert.equal(log.of('turn.start').length, 0, 'still in the handshake');
  await sending;
  await log.until((e) => e.type === 'turn.done');
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
  await driver.kill();
});

test('acp: a start that fails settles back to idle', async () => {
  const d = new DevinDriver({ cmd: 'devin', env: {}, args: [], cwd: '/no/such/folder/for/helm', mode: 'edit' });
  const log = collect(d);
  await assert.rejects(d.send('hello'), /does not exist/);
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
});

test('acp: a palette read during a cold start shares it instead of racing the prompt', async (t) => {
  const spawns = join(mkdtempSync(join(tmpdir(), 'helm-acp-spawns-')), 'n');
  const { driver, log } = live(t, 'plain', { FAKE_INIT_MS: '200', FAKE_SPAWNS: spawns });
  const commands = driver.availableCommands();
  await driver.send('hello');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(log.of('error').length, 0, 'no "never finished starting" error');
  assert.ok((await commands).length);
  assert.equal(readFileSync(spawns, 'utf8').trim().split('\n').length, 1, 'one agent process, not two');
  await driver.kill();
});

// A restart finds the agent process still running on the proc host. These
// stand in a held child for the host, and play the previous daemon by hand.
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

const survivor = (t, scenario, env = {}) => {
  const { cmd, dir, env: base } = live(t, scenario, env);
  const child = spawn(cmd, ['acp'], { cwd: dir, env: { ...process.env, ...base }, stdio: ['pipe', 'pipe', 'pipe'] });
  const drivers = [];
  t.after(async () => {
    for (const driver of drivers) await driver.kill();
    child.kill();
  });
  const write = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  const adopt = (opts) => {
    const driver = new DevinDriver({ cmd, args: [], cwd: dir, env: base, mode: 'ask', procHost: heldBy(child), procId: 's', ...opts });
    drivers.push(driver);
    return { driver, log: collect(driver) };
  };
  return { child, write, adopt };
};

test('acp adopt: a prompt that failed while helm restarted ends its turn as an error', async (t) => {
  const { write, adopt } = survivor(t, 'error', { FAKE_TURN_MS: '200' });
  // The previous daemon: handshake, then a prompt whose answer it never saw.
  write({ jsonrpc: '2.0', id: 'helm-old-1', method: 'initialize', params: {} });
  write({ jsonrpc: '2.0', id: 'helm-old-2', method: 'session/new', params: {} });
  write({ jsonrpc: '2.0', id: 'helm-old-3', method: 'session/prompt', params: { sessionId: 'live-1', prompt: [] } });
  const { driver, log } = adopt({
    engineSessionId: 'live-1',
    openTurn: () => 'turn-a', pendingEvents: () => [],
    resumeEvents: () => [{ type: 'turn.start', turnId: 'turn-a', text: 'hi', acpPromptId: 'helm-old-3' }],
  });
  driver.status = 'working';
  await driver.start();
  assert.equal(driver.status, 'working', 'the turn is still running on the agent');
  const done = await log.until((e) => e.type === 'turn.done', 3000);
  assert.equal(done.turnId, 'turn-a');
  assert.equal(done.status, 'error');
  assert.match(done.error, /overloaded/);
  assert.equal(driver.status, 'idle');
});

test('acp adopt: a saved busy status with nothing open is corrected to idle', async (t) => {
  const { adopt } = survivor(t, 'plain');
  const { driver } = adopt({ openTurn: () => null, pendingEvents: () => [] });
  driver.status = 'working';
  await driver.start();
  assert.equal(driver.status, 'idle');
});

test('acp adopt: a question still open is "needs you", not working', async (t) => {
  const { adopt } = survivor(t, 'plain');
  const ask = { type: 'permission.request', requestId: 'perm-x', acpId: 'perm-x', acpOptions: [], options: [] };
  const { driver } = adopt({ openTurn: () => 'turn-b', pendingEvents: () => [ask] });
  driver.status = 'working';
  await driver.start();
  assert.equal(driver.status, 'blocked');
});

test('acp adopt: an unsent ticket is closed as undelivered, not left running', async (t) => {
  const { adopt } = survivor(t, 'plain');
  const { driver, log } = adopt({ openTurn: () => 'local-abc', pendingEvents: () => [] });
  driver.status = 'working';
  await driver.start();
  assert.deepEqual(log.of('turn.done').map((e) => [e.turnId, e.status]), [['local-abc', 'interrupted']]);
  assert.equal(driver.status, 'idle');
});

test('devin: words the agent says outside a prompt close no turn, however long it stays quiet', async () => {
  // ACP only ends work with a prompt's answer. Nothing says when work the agent
  // does on its own is over, so the driver does not guess: it opens no turn
  // for it and never claims a finish (or idleness) from a quiet stream.
  const { driver, log } = make('devin', 'background');
  await driver.send('Reply with exactly the words: hello from helm');
  await log.until((e) => e.type === 'turn.done');
  await log.until((e) => e.type === 'item.delta' && e.text.includes('all clean'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(log.of('turn.done').length, 1, 'only the prompt ends a turn');
  assert.equal(log.of('turn.start').length, 1);
  assert.ok(!log.of('turn.start').some((e) => e.wake));
  assert.equal(driver.status, 'idle');
  await driver.kill();
});
