import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
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
  const limits = formatRateLimits({ rateLimits: {
    limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1789947078 },
  } });
  assert.match(limits, /### Limits/);
  assert.match(limits, /- \*\*codex\*\* — 42% used · 300m window · resets .* UTC/);
  // A provider-supplied label cannot smuggle markup into the report.
  assert.match(formatRateLimits({ rateLimits: { limitName: 'co*dex', primary: { usedPercent: 1 } } }),
    /\*\*co\\\*dex\*\*/);
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
  assert.equal(driver.status, 'working', 'the model turn still owns the status and Stop control');
  assert.deepEqual(log.of('status').map((e) => e.status), ['working']);
  assert.equal(fake.stdinLines().filter((line) => line.method === 'turn/start').length, 1);

  await log.until((e) => e.type === 'turn.done' && !String(e.turnId).startsWith('command-'));
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
