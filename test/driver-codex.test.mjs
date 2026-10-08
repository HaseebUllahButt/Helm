import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync, chmodSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fakeCli, collect } from './helpers.mjs';
import { CodexDriver, CODEX_COMMANDS, formatAccountUsage, formatRateLimits } from '../packages/connect/src/drivers/codex.js';

// One app-server is shared per account home; every test gets its own so the
// fake replays the right recording.
const make = (name, opts = {}) => {
  const fake = fakeCli('codex', name);
  const driver = new CodexDriver({
    cmd: fake.cmd, env: { CODEX_HOME: join(fake.dir, 'home') }, args: [],
    cwd: fake.dir, mode: 'ask', effort: 'low', ...opts,
  });
  return { fake, driver, log: collect(driver) };
};

test('codex exposes the commands Helm can execute through app-server', async () => {
  const driver = new CodexDriver({ cmd: 'codex', env: {}, cwd: '/x', mode: 'ask' });
  assert.deepEqual(await driver.availableCommands(), CODEX_COMMANDS);
  assert.ok(CODEX_COMMANDS.length > 10);
});

test('Codex forwards native thread names without adopting another thread title', () => {
  const driver = new CodexDriver({ cmd: 'codex', env: {}, cwd: '/x', mode: 'ask' });
  driver.threadId = 'title-thread';
  const log = collect(driver);
  driver.onNotification('thread/name/updated', { threadId: 'other-thread', threadName: 'Other work' });
  driver.onNotification('thread/name/updated', { threadId: 'title-thread', threadName: null });
  driver.onNotification('thread/name/updated', { threadId: 'title-thread', threadName: '  Repair login  ' });
  assert.deepEqual(log.of('title'), [{ type: 'title', title: 'Repair login' }]);
});

function adoptedCodex(t, { thread, afterRead, error, unsupportedTurns = false } = {}) {
  const fake = fakeCli('codex', 'plain');
  let receive, exited;
  const writes = [];
  const emit = (message) => receive(`${JSON.stringify(message)}\n`);
  const pipe = {
    onData: (callback) => { receive = callback; },
    onExit: (callback) => { exited = callback; },
    write(data) {
      const request = JSON.parse(data); writes.push(request);
      const reply = request.method === 'thread/read'
        ? unsupportedTurns && request.params.includeTurns
          ? { error: { message: 'list_turns is not supported yet' } }
          : error ? { error } : { result: { thread } }
        : { result: {} };
      emit({ id: request.id, ...reply });
      if (request.method === 'thread/read') afterRead?.(emit);
    },
    end: () => exited?.({ code: 0 }),
    kill: () => exited?.({ code: 0 }),
  };
  const host = { hasProc: () => true, procPipe: () => pipe,
    openProc: () => assert.fail('must not start a competing account server') };
  const driver = new CodexDriver({ cmd: fake.cmd, env: { CODEX_HOME: join(fake.dir, 'home') },
    cwd: fake.dir, mode: 'ask', engineSessionId: 'recovered-thread',
    procHost: host, openTurn: () => 'stale-log-turn' });
  t.after(async () => { await driver.kill(); rmSync(fake.dir, { recursive: true, force: true }); });
  return { driver, log: collect(driver), writes };
}

for (const [name, status, turns, expected] of [
  ['completed', { type: 'idle' }, [{ id: 'stale-log-turn', status: 'completed' }], 'idle'],
  ['unloaded with an unfinished rollout', { type: 'notLoaded' }, [{ id: 'stale-log-turn', status: 'inProgress' }], 'idle'],
  ['running', { type: 'active', activeFlags: [] }, [{ id: 'actual-live-turn', status: 'inProgress' }], 'working'],
  ['awaiting approval', { type: 'active', activeFlags: ['waitingOnApproval'] }, [{ id: 'actual-live-turn', status: 'inProgress' }], 'blocked'],
]) test(`adopted Codex reads a ${name} thread rather than trusting saved work`, async (t) => {
  const { driver, writes } = adoptedCodex(t, { thread: { status, turns } });
  driver.status = 'working';
  await driver.start();
  assert.equal(driver.status, expected);
  assert.deepEqual(writes, [{ jsonrpc: '2.0', id: 1, method: 'thread/read',
    params: { threadId: 'recovered-thread', includeTurns: true } }]);
  if (expected === 'working') {
    await driver.steer('Check this too');
    assert.equal(writes.at(-1).params.expectedTurnId, 'actual-live-turn');
  } else if (expected === 'idle') {
    await assert.rejects(driver.steer('Do not revive stale work'), /no active turn/);
  }
});

test('older ephemeral Codex threads fall back to a live status read without replaying work', async (t) => {
  const { driver, writes } = adoptedCodex(t, {
    unsupportedTurns: true, thread: { status: { type: 'idle' } },
  });
  driver.status = 'working';
  await driver.start();
  assert.equal(driver.status, 'idle');
  assert.deepEqual(writes.map((request) => [request.method, request.params.includeTurns]),
    [['thread/read', true], ['thread/read', false]]);
  await assert.rejects(driver.steer('No stale turn'), /no active turn/);
});

test('a completion received during a recovery read wins over its older active snapshot', async (t) => {
  const { driver } = adoptedCodex(t, {
    thread: { status: { type: 'active' }, turns: [{ id: 'finished-now', status: 'inProgress' }] },
    afterRead: (emit) => emit({ method: 'turn/completed', params: {
      threadId: 'recovered-thread', turn: { id: 'finished-now', status: 'completed' },
    } }),
  });
  driver.status = 'working';
  await driver.start();
  assert.equal(driver.status, 'idle');
  await assert.rejects(driver.steer('Do not revive the completed turn'), /no active turn/);
});

test('a turn starting during a recovery read wins over its older idle snapshot', async (t) => {
  const { driver, writes } = adoptedCodex(t, {
    thread: { status: { type: 'idle' }, turns: [] },
    afterRead: (emit) => emit({ method: 'turn/started', params: {
      threadId: 'recovered-thread', turn: { id: 'new-live-turn' },
    } }),
  });
  await driver.start();
  assert.equal(driver.status, 'working');
  await driver.steer('Use the actual turn');
  assert.equal(writes.at(-1).params.expectedTurnId, 'new-live-turn');
});

test('a managed Codex thread accepts live idle notifications without waiting for a turn completion', async (t) => {
  const { driver } = adoptedCodex(t, {
    thread: { status: { type: 'active' }, turns: [{ id: 'live-turn', status: 'inProgress' }] },
  });
  await driver.start();
  driver.onNotification('thread/status/changed', { threadId: 'other-thread', status: { type: 'idle' } });
  assert.equal(driver.status, 'working');
  driver.onNotification('thread/status/changed', { threadId: 'recovered-thread', status: { type: 'idle' } });
  assert.equal(driver.status, 'idle');
  await assert.rejects(driver.steer('The turn ended'), /no active turn/);
});

test('a failed live thread read cannot claim that saved work is still running', async (t) => {
  const { driver, writes } = adoptedCodex(t, { error: { message: 'thread unavailable' } });
  await assert.rejects(driver.start(), /live thread read failed: thread unavailable/);
  assert.equal(driver.status, 'idle');
  assert.equal(writes.length, 1, 'a failed read never resumes or replays the old task');
});

/** An adopted Codex whose replies, and what it says around them, a test scripts. */
function scriptedCodex(t, { openTurn = null, transcript, reply }) {
  const fake = fakeCli('codex', 'plain');
  let receive;
  const writes = [];
  const emit = (message) => receive(`${JSON.stringify(message)}\n`);
  const notify = (method, params) => emit({ method, params: { threadId: 'scripted-thread', ...params } });
  const pipe = {
    onData: (callback) => { receive = callback; },
    onExit: () => {},
    write(data) {
      const request = JSON.parse(data); writes.push(request);
      emit({ id: request.id, ...(reply(request, notify) ?? { result: {} }) });
    },
    end() {}, kill() {},
  };
  const host = { hasProc: () => true, procPipe: () => pipe, openProc: () => assert.fail('no second server') };
  const driver = new CodexDriver({ cmd: fake.cmd, env: { CODEX_HOME: join(fake.dir, 'scripted-home') },
    cwd: fake.dir, mode: 'ask', engineSessionId: 'scripted-thread', transcript,
    procHost: host, openTurn: () => openTurn });
  t.after(async () => { await driver.kill(); rmSync(fake.dir, { recursive: true, force: true }); });
  return { driver, log: collect(driver), writes, notify };
}

test('a late completion of an older turn does not mark the newer turn idle', async (t) => {
  const { driver, log, notify, writes } = scriptedCodex(t, {
    openTurn: 'turn-a',
    reply(request, say) {
      if (request.method === 'thread/read') return { result: { thread: { status: { type: 'active', activeFlags: [] }, turns: [{ id: 'turn-a', status: 'inProgress' }] } } };
      if (request.method === 'turn/start') {
        // Reports about turn A that were in flight while B was being started.
        say('thread/status/changed', { status: { type: 'idle' } });
        say('turn/completed', { turn: { id: 'turn-a', status: 'completed' } });
        return { result: { turn: { id: 'turn-b' } } };
      }
    },
  });
  await driver.start();
  assert.equal(driver.status, 'working');
  await driver.send('Next task');
  assert.deepEqual(log.of('turn.done').map((e) => e.turnId), ['turn-a']);
  assert.equal(driver.status, 'working', 'turn B is running');
  await driver.steer('More for B');
  assert.equal(writes.at(-1).params.expectedTurnId, 'turn-b');

  // C starts on its own (nobody here asked for it); B's completion arrives after it.
  notify('turn/started', { turn: { id: 'turn-c' } });
  notify('turn/completed', { turn: { id: 'turn-b', status: 'completed' } });
  assert.equal(driver.status, 'working', 'turn C is running');
  notify('turn/completed', { turn: { id: 'turn-c', status: 'completed' } });
  assert.equal(driver.status, 'idle');
  assert.deepEqual(log.of('turn.done').map((e) => e.turnId), ['turn-a', 'turn-b', 'wake-turn-c']);
});

test('/review closes the card it opened instead of leaving it running forever', async (t) => {
  const { driver, log, notify } = scriptedCodex(t, {
    reply(request, say) {
      if (request.method === 'thread/read') return { result: { thread: { status: { type: 'idle' }, turns: [] } } };
      if (request.method === 'review/start') {
        say('turn/started', { turn: { id: 'review-turn' } });
        say('item/started', { turnId: 'review-turn', item: { id: 'early-text', type: 'agentMessage' } });
        return { result: { turn: { id: 'review-turn' } } };
      }
    },
  });
  await driver.start();
  await driver.send('/review');
  const card = log.of('turn.start')[0].turnId;
  assert.match(card, /^command-/);
  notify('item/started', { turnId: 'review-turn', item: { id: 'late-text', type: 'agentMessage' } });
  notify('turn/completed', { turn: { id: 'review-turn', status: 'completed' } });
  assert.deepEqual(log.of('item.start').map((e) => e.turnId), [card, card], 'the review output sits on its card');
  assert.deepEqual(log.of('turn.done').map((e) => [e.turnId, e.status]), [[card, 'ok']]);
  assert.equal(driver.status, 'idle');
});

for (const [name, turns, rollout, expected] of [
  ['the thread lists it finished', [{ id: 'away-turn', status: 'failed', error: { message: 'quota' } }], null, ['error', 'quota']],
  ['only the rollout records it', [], ['task_started', 'turn_aborted'], ['interrupted', undefined]],
  ['the rollout says it completed', [], ['task_started', 'task_complete'], ['ok', undefined]],
  ['nothing records it', [], ['task_started'], null],
]) test(`a saved turn that ended while Helm was away closes from Codex's record: ${name}`, async (t) => {
  let transcript;
  if (rollout) {
    transcript = join(mkdtempSync(join(tmpdir(), 'helm-rollout-')), 'rollout.jsonl');
    writeFileSync(transcript, [
      { type: 'session_meta', payload: { id: 'scripted-thread' } },
      ...rollout.map((type) => ({ type: 'event_msg', payload: { type, turn_id: 'away-turn' } })),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'some-other-turn' } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  }
  const { driver, log } = scriptedCodex(t, {
    openTurn: 'away-turn', transcript,
    reply: (request) => request.method === 'thread/read'
      ? { result: { thread: { status: { type: 'idle' }, turns } } } : undefined,
  });
  driver.status = 'working';
  await driver.start();
  assert.equal(driver.status, 'idle');
  const done = log.of('turn.done');
  if (!expected) assert.equal(done.length, 0, 'an unknown ending is not invented');
  else {
    assert.deepEqual(done.map((e) => [e.turnId, e.status, e.error]), [['away-turn', ...expected]]);
    assert.ok(log.events.indexOf(done[0]) < log.events.findIndex((e) => e.type === 'status' && e.status === 'idle'),
      'the card closes before the chat reads idle, so queued work does not wait');
  }
});

test('/usage views format the account activity API as Markdown', () => {
  const activity = {
    summary: { lifetimeTokens: 123456, peakDailyTokens: 4000, currentStreakDays: 3, longestStreakDays: 8 },
    dailyUsageBuckets: [
      { startDate: '2026-09-14', tokens: 100 },
      { startDate: '2026-09-15', tokens: 200 },
      { startDate: '2026-09-20', tokens: 300 },
    ],
  };
  const daily = formatAccountUsage(activity, 'daily');
  assert.match(daily, /### Daily token activity/);
  assert.match(daily, /\| Date \| Tokens \|/);
  assert.match(daily, /\| 2026-09-20 \| 300 \|/);
  const weekly = formatAccountUsage(activity, 'weekly');
  assert.match(weekly, /### Weekly token activity/);
  assert.match(weekly, /\| Week starting \| Tokens \|/);
  assert.match(weekly, /\| 2026-09-14 \| 600 \|/);
  const cumulative = formatAccountUsage(activity, 'cumulative');
  assert.match(cumulative, /### Cumulative usage/);
  assert.match(cumulative, /\*\*Lifetime tokens:\*\* 123,456/);
  const summary = formatAccountUsage(activity);
  assert.match(summary, /### Account usage/);
  assert.match(summary, /\*\*Today:\*\* [\d,]+ tokens/);
  assert.match(summary, /\*\*Last 7 days:\*\* 600 tokens/);
  assert.match(summary, /`\/usage daily`/);
  // The quota card leads /usage, like the TUI's status card: the window is
  // named for its length and the bar fills to the percent used.
  const now = Date.now();
  const limits = formatRateLimits({ rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: now / 1000 + 5 * 3600 },
    secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: now / 1000 + 4 * 86400 },
    credits: { hasCredits: true, unlimited: false, balance: '42.50' },
    planType: 'pro',
  } }, { now });
  assert.match(limits, /### Limits/);
  assert.match(limits, /\*\*5h limit\*\* `█{8}░{12}` 42% used · resets in \d+h \d+m/);
  assert.match(limits, /\*\*Weekly limit\*\* `█{6}░{14}` 30% used · resets \w{3} \d+, \d+:\d{2} [AP]M \(UTC[+-][\d:]+\)/);
  assert.match(limits, /\*\*Credits:\*\* 42\\\.50/);
  assert.match(limits, /\*\*Plan:\*\* Pro/);
  // A provider-supplied label cannot smuggle markup into the report.
  const two = formatRateLimits({ rateLimitsByLimitId: {
    'co*dex': { limitId: 'co*dex', primary: { usedPercent: 1 } },
    'gpt': { limitId: 'gpt', primary: { usedPercent: 2 } },
  } }, { now });
  assert.match(two, /\*co\\\*dex\*/);
  assert.match(two, /\*gpt\*/);
});

test('/pwd is handled locally as a completed command turn', async () => {
  const { driver, log, fake } = make('plain');
  await driver.send('/pwd');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  const body = log.of('item.delta').map((e) => e.text).join('');
  assert.equal(body, `**Current directory:** \`${fake.dir}\``);
  assert.equal(fake.stdinLines().some((line) => line.method === 'turn/start'), false);
  await driver.kill();
});

test('informational slash commands do not clear an active turn status', async () => {
  const { driver, log, fake } = make('plain');
  await driver.send('Reply with exactly the words: hello from helm');
  await log.until((e) => e.type === 'status' && e.status === 'working');
  await driver.send('/status');

  const commandDone = log.of('turn.done').find((e) => String(e.turnId).startsWith('command-'));
  assert.equal(commandDone.status, 'ok');
  assert.equal(fake.stdinLines().filter((line) => line.method === 'turn/start').length, 1);

  // The status card carries the live account reads: the signed-in account
  // and the quota bars the TUI's /status draws.
  const item = log.of('item.start').find((e) => e.kind === 'text' && String(e.turnId).startsWith('command-'));
  const body = log.of('item.delta').filter((e) => e.id === item.id).map((e) => e.text).join('');
  assert.match(body, /### Session status/);
  assert.match(body, /\*\*Account:\*\* dev@example\\\.com \(Pro\)/);
  assert.match(body, /\*\*5h limit\*\* `█+░+` 12% used · resets \w{3} \d+, \d+:\d{2} [AP]M \(UTC[+-][\d:]+\)/);
  assert.match(body, /\*\*Weekly limit\*\* `█+░+` 30% used/);
  assert.match(body, /\*\*Credits:\*\* 42\\\.50/);
  const calls = fake.stdinLines().map((l) => l.method);
  assert.ok(calls.includes('account/read'));
  assert.ok(calls.includes('account/rateLimits/read'));

  await log.until((e) => e.type === 'turn.done' && !String(e.turnId).startsWith('command-'));
  // The command emitted no status of its own: every status on the log is
  // the model turn's, so the Stop control stayed with it.
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
  await driver.kill();
});

test('plain: initialize, thread/start, turn/start; text streams as deltas', async () => {
  const { driver, log, fake } = make('plain');
  await driver.send('Reply with exactly the words: hello from helm');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(done.usage.output, 7);
  assert.equal(driver.threadId, '01a09e7a-960e-79e2-b7c8-8fc714c00f2a');
  assert.equal(driver.engineSessionId, driver.threadId);
  const text = log.of('item.start').find((e) => e.kind === 'text');
  assert.equal(log.of('item.delta').filter((e) => e.id === text.id).map((e) => e.text).join(''), 'hello from helm');
  assert.ok(log.of('limits').some((e) => e.codex?.primary?.usedPercent === 1));
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);

  const sent = fake.stdinLines();
  assert.equal(sent[0].method, 'initialize');
  assert.deepEqual(sent[0].params.clientInfo.name, 'helm');
  assert.equal(sent[1].method, 'initialized');
  assert.equal(sent[2].method, 'thread/start');
  assert.deepEqual(sent[2].params, { cwd: fake.dir, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  assert.equal(sent[3].method, 'turn/start');
  assert.deepEqual(sent[3].params.input, [{ type: 'text', text: 'Reply with exactly the words: hello from helm', text_elements: [] }]);
  assert.equal(sent[3].params.effort, 'low');
  // The sandbox rides every turn, not just thread/start: that is what makes a
  // mode changed mid-session real rather than cosmetic.
  assert.deepEqual(sent[3].params.sandboxPolicy, { type: 'workspaceWrite' });
  assert.equal(sent[3].params.approvalPolicy, 'on-request');
  await driver.kill();
});

test('Helm-managed Codex threads disable native delegation on start and resume', async (t) => {
  for (const engineSessionId of [undefined, '01a09e7a-960e-79e2-b7c8-8fc714c00f2a']) {
    const { driver, fake } = make('plain', { engineSessionId, helmDelegation: true, instructions: 'Use Helm', mode: 'readonly' });
    t.after(() => driver.kill());
    await driver.start();
    const request = fake.stdinLines().find((entry) => entry.method === (engineSessionId ? 'thread/resume' : 'thread/start'));
    assert.equal(request.params.developerInstructions, 'Use Helm');
    assert.equal(request.params.config['features.multi_agent'], false);
    assert.equal(request.params.config['features.multi_agent_v2'], false);
    assert.equal(request.params.sandbox, 'read-only');
    assert.ok(!fake.stdinLines().some((entry) => entry.method === 'turn/start'));
  }
});

test('each thread names its own session; the shared app-server names none', async () => {
  // One app-server serves every thread on an account. Its environment once
  // carried the first thread's HELM_SESSION_ID, so `helm delegate` from any
  // other chat filed its subagents under that first chat.
  const fake = fakeCli('codex', 'plain');
  const envFile = join(fake.dir, 'server-env');
  const wrapper = join(fake.dir, 'codex-wrapped');
  writeFileSync(wrapper, `#!/bin/sh\nenv > ${JSON.stringify(envFile)}\nexec ${JSON.stringify(fake.cmd)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  const ids = { HELM_SESSION_ID: 'sess-a', HELM_PROFILE_ID: 'codex', HELM_ENGINE: 'codex', HELM_CWD: fake.dir };
  const driver = new CodexDriver({ cmd: wrapper, env: { CODEX_HOME: join(fake.dir, 'home'), ...ids }, args: [], cwd: fake.dir, mode: 'ask' });
  const log = collect(driver);
  await driver.send('Reply with exactly the words: hello from helm');
  await log.until((e) => e.type === 'turn.done');
  const start = fake.stdinLines().find((l) => l.method === 'thread/start');
  assert.deepEqual(start.params.config, Object.fromEntries(Object.entries(ids).map(([k, v]) => [`shell_environment_policy.set.${k}`, v])));
  const serverEnv = readFileSync(envFile, 'utf8');
  for (const k of Object.keys(ids)) assert.doesNotMatch(serverEnv, new RegExp(`^${k}=`, 'm'));
  await driver.kill();
});

test('command: a command item with an approval request; accept runs it and the output lands', async () => {
  const { driver, log, fake } = make('command', { mode: 'readonly' });
  await driver.send('run echo');
  const ask = await log.until((e) => e.type === 'permission.request');
  assert.equal(ask.kind, 'command');
  assert.equal(ask.detail, 'echo helm-test');
  assert.deepEqual(ask.options.map((o) => o.role), ['allow', 'allow-always', 'deny']);
  assert.equal(ask.options[1].label, 'Always allow echo');
  assert.equal(driver.status, 'blocked');
  const cmd = log.of('item.start').find((e) => e.kind === 'command');
  assert.equal(cmd.command, 'echo helm-test');
  assert.equal(ask.itemId, cmd.id);

  await driver.answer(ask.requestId, { option: 'allow' });
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  const cmdDone = log.of('item.done').find((e) => e.id === cmd.id);
  assert.equal(cmdDone.status, 'ok');
  assert.equal(cmdDone.output, 'helm-test\n');
  assert.equal(cmdDone.exitCode, 0);
  const reply = fake.stdinLines().find((l) => l.id !== undefined && 'result' in l);
  assert.deepEqual(reply.result, { decision: 'accept' });
  assert.equal(fake.stdinLines()[2].params.approvalPolicy, 'untrusted');
  const turn = fake.stdinLines().find((l) => l.method === 'turn/start');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly' });
  await driver.kill();
});

test('decline: the command item ends declined and the agent says so', async () => {
  const { driver, log, fake } = make('decline', { mode: 'readonly' });
  await driver.send('run echo');
  const ask = await log.until((e) => e.type === 'permission.request');
  await driver.answer(ask.requestId, { option: 'deny' });
  await log.until((e) => e.type === 'turn.done');
  const cmdDone = log.of('item.done').find((e) => e.id === ask.itemId);
  assert.equal(cmdDone.status, 'declined');
  assert.deepEqual(fake.stdinLines().find((l) => 'result' in l).result, { decision: 'decline' });
  const reply = log.of('item.start').filter((e) => e.kind === 'text').pop();
  assert.equal(log.of('item.delta').filter((e) => e.id === reply.id).map((e) => e.text).join(''), 'Declined by user.');
  await driver.kill();
});

test('edit: a file change carries its diff and asks; accept applies it', async () => {
  const { driver, log } = make('edit');
  await driver.send('create a file');
  const ask = await log.until((e) => e.type === 'permission.request');
  assert.equal(ask.kind, 'edit');
  assert.equal(ask.title, 'Change helm-note.txt');
  assert.deepEqual(ask.detail.changes, [{ path: '/tmp/helm-record-wJjiYQ/helm-note.txt', kind: 'add', diff: 'hi\n' }]);
  await driver.answer(ask.requestId, { option: 'allow' });
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  const editDone = log.of('item.done').find((e) => e.id === ask.itemId);
  assert.equal(editDone.status, 'ok');
  // the agent then read the file back with a command that needed no approval
  assert.ok(log.of('item.start').some((e) => e.kind === 'command' && e.command.startsWith('sed')));
  await driver.kill();
});

test('interrupt: turn/interrupt with the live turn id; the turn ends interrupted', async () => {
  const { driver, log, fake } = make('interrupt');
  await driver.send('count');
  await log.until((e) => e.type === 'item.start' && e.kind === 'text');
  await driver.interrupt();
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'interrupted');
  const sent = fake.stdinLines().find((l) => l.method === 'turn/interrupt');
  assert.deepEqual(sent.params, { threadId: driver.threadId, turnId: '01a09e7c-9ab1-7491-b3b0-3b1affd75fad' });
  await driver.kill();
});

test('subagent: spawn_agent is a card; the child thread\'s items nest under it', async () => {
  const { driver, log } = make('subagent');
  await driver.send('spawn a subagent');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');

  const card = log.of('item.start').find((e) => e.kind === 'subagent');
  assert.ok(card, 'the collab call started as a subagent item');
  assert.equal(card.name, 'spawn_agent');
  assert.equal(card.input.prompt, 'Draft a one-line plan for the refactor');
  assert.equal(card.agent.status, 'running');

  // The child thread's items arrive on its own threadId and nest under the card.
  const childCmd = log.of('item.start').find((e) => e.kind === 'command');
  assert.equal(childCmd.parentId, card.id);
  assert.equal(childCmd.command, 'ls src');
  const childText = log.of('item.start').find((e) => e.kind === 'text' && e.parentId === card.id);
  assert.ok(childText, 'the child\'s message nested under the card');
  const childDone = log.of('item.done').find((e) => e.id === childCmd.id);
  assert.equal(childDone.output, 'a.ts\nb.ts\nc.ts\n');

  // spawn_agent carries no receiverThreadIds - the `wait` card names the
  // child, and its children still nest under the spawn card.
  const wait = log.of('item.start').find((e) => e.name === 'wait');
  assert.equal(wait.kind, 'subagent');
  const waitDone = log.of('item.done').find((e) => e.id === wait.id);
  assert.equal(waitDone.status, 'ok');
  assert.match(waitDone.output, /move the parser/);

  // The child's thread never closes our turn or steals the status line.
  assert.equal(log.of('turn.done').length, 1);
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
  await driver.kill();
});

test('resume: an existing thread id resumes instead of starting', () => {
  const d = new CodexDriver({ cmd: 'codex', env: {}, cwd: '/x', mode: 'ask', engineSessionId: 'thread-1' });
  assert.equal(d.threadId, 'thread-1');
});

test('wake: a turn Codex starts by itself is its own turn, and each turn closes once', async () => {
  // After the answer: its completion again, then a turn of Codex's own (a
  // background command finishing) that completes twice.
  const { driver, log } = make('wake');
  await driver.send('Reply with exactly the words: hello from helm');
  await log.until((e) => e.type === 'turn.done' && String(e.turnId).startsWith('wake-'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const starts = log.of('turn.start');
  const dones = log.of('turn.done');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].text, 'Reply with exactly the words: hello from helm');
  assert.ok(!starts[0].wake);
  assert.equal(starts[1].wake, true);
  assert.equal(starts[1].text, '');
  assert.match(starts[1].turnId, /^wake-/);
  assert.deepEqual(dones.map((e) => e.turnId), starts.map((e) => e.turnId), 'every turn closes exactly once');
  const wakeText = log.of('item.start').find((e) => e.kind === 'text' && e.turnId === starts[1].turnId);
  assert.ok(wakeText, "the wake-up's words belong to the wake-up");
  assert.equal(log.of('item.delta').filter((e) => e.id === wakeText.id).map((e) => e.text).join(''), 'background check is clean');
  assert.equal(driver.status, 'idle');
  await driver.kill();
});

test('a wake-up the log already shows is not opened again after a restart', async (t) => {
  const shown = 'wake-w1';
  const { driver, log, notify } = scriptedCodex(t, {
    reply(request) {
      if (request.method === 'thread/read') return { result: { thread: { status: { type: 'idle' }, turns: [] } } };
    },
  });
  driver.resumeEvents = () => [{ type: 'turn.start', turnId: shown, text: '', wake: true }, { type: 'turn.start', turnId: 'mine', text: 'hi' }];
  await driver.start();
  notify('turn/started', { turn: { id: 'w1' } });
  notify('turn/completed', { turn: { id: 'w1', status: 'completed' } });
  notify('turn/completed', { turn: { id: 'w1', status: 'completed' } });
  notify('turn/started', { turn: { id: 'mine' } });
  notify('turn/completed', { turn: { id: 'mine', status: 'completed' } });
  assert.equal(log.of('turn.start').length, 0, 'neither is announced again');
  assert.deepEqual(log.of('turn.done').map((e) => e.turnId), [shown, 'mine']);
});
