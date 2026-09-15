import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCli, collect } from './helpers.mjs';
import { ClaudeDriver } from '../packages/connect/src/drivers/claude.js';

const make = (name, opts = {}) => {
  const fake = fakeCli('claude', name);
  const driver = new ClaudeDriver({
    cmd: fake.cmd, env: { CLAUDE_CONFIG_DIR: '/tmp/helm-test-claude-home' }, args: [],
    cwd: fake.dir, mode: 'default', ...opts,
  });
  return { fake, driver, log: collect(driver) };
};

test('argv: headless flags, the account home, and a session id to resume later', () => {
  const d = new ClaudeDriver({ cmd: 'claude', env: { CLAUDE_CONFIG_DIR: '~/.claude-personal' }, args: ['--model', 'claude-fable-5-1'], cwd: '/x', model: 'opus', effort: 'high', mode: 'acceptEdits' });
  const a = d.args;
  assert.equal(a[0], '--model'); // the alias's own arguments come first...
  assert.ok(a.includes('--include-partial-messages') && a.includes('--replay-user-messages'));
  assert.deepEqual(a.slice(a.indexOf('--permission-prompt-tool'), a.indexOf('--permission-prompt-tool') + 2), ['--permission-prompt-tool', 'stdio']);
  assert.deepEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'acceptEdits']);
  assert.equal(a[a.lastIndexOf('--model') + 1], 'opus'); // ...and the app's choice wins
  assert.ok(a.includes('--effort') && a[a.indexOf('--effort') + 1] === 'high');
  assert.match(a[a.length - 1], /^--session-id=[0-9a-f-]{36}$/);
  assert.equal(d.env.CLAUDE_CONFIG_DIR, '~/.claude-personal');

  const r = new ClaudeDriver({ cmd: 'claude', env: {}, cwd: '/x', mode: 'default', engineSessionId: 'abc' });
  assert.equal(r.args[r.args.length - 1], '--resume=abc');
  assert.ok(r.args.includes('manual')); // the CLI's name for the default mode
});

test('plain: text streams in as deltas, then the turn completes with its cost', async () => {
  const { driver, log } = make('plain');
  await driver.send('Reply with exactly the words: hello from helm');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(done.costUsd, 0.016515);
  const turn = log.of('turn.start')[0];
  assert.equal(turn.text, 'Reply with exactly the words: hello from helm');
  const text = log.of('item.start').find((e) => e.kind === 'text');
  assert.ok(text, 'a text item started');
  assert.equal(log.of('item.delta').filter((e) => e.id === text.id).map((e) => e.text).join(''), 'hello from helm');
  assert.ok(log.of('item.start').some((e) => e.kind === 'thinking'));
  assert.ok(log.of('limits').length, 'rate limit snapshot forwarded');
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
  await driver.kill();
  assert.equal(log.of('status').pop().status, 'exited');
});

test('tool: a Bash call becomes a tool item with streamed input and its output; a Write asks permission', async () => {
  const { driver, log, fake } = make('tool');
  await driver.send('Use the Bash tool…');
  const ask = await log.until((e) => e.type === 'permission.request');
  assert.equal(ask.kind, 'edit');
  assert.equal(ask.tool, 'Write');
  assert.equal(ask.title, 'Write out.txt');
  assert.equal(ask.detail.path, '/tmp/helm-record-9lHsJr/out.txt');
  assert.deepEqual(ask.options.map((o) => o.role), ['allow', 'allow-always', 'deny']);
  assert.equal(ask.options[1].label, 'Allow all edits this session');
  assert.equal(driver.status, 'blocked');

  const bash = log.of('item.start').find((e) => e.kind === 'tool' && e.name === 'Bash');
  assert.ok(bash.id.startsWith('toolu_'));
  const update = log.of('item.update').find((e) => e.id === bash.id && e.input);
  assert.equal(update.input.command, 'echo helm-test');
  const bashDone = log.of('item.done').find((e) => e.id === bash.id);
  assert.equal(bashDone.output, 'helm-test');
  assert.equal(bashDone.result.stdout, 'helm-test');

  await driver.answer(ask.requestId, { option: 'allow' });
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.ok(log.of('permission.resolved').some((e) => e.requestId === ask.requestId && e.decision === 'allow'));
  const writeDone = log.of('item.done').find((e) => e.id === ask.itemId);
  assert.equal(writeDone.status, 'ok');

  const sent = fake.stdinLines().find((l) => l.type === 'control_response');
  assert.deepEqual(sent, { type: 'control_response', response: { subtype: 'success', request_id: ask.requestId, response: { behavior: 'allow' } } });
  await driver.kill();
});

test('deny: the refusal reaches the CLI as a deny with a message', async () => {
  const { driver, log, fake } = make('deny');
  await driver.send('Use the Write tool…');
  const ask = await log.until((e) => e.type === 'permission.request');
  await driver.answer(ask.requestId, { option: 'deny', message: 'The user declined this on their phone.' });
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  const writeDone = log.of('item.done').find((e) => e.id === ask.itemId);
  assert.equal(writeDone.status, 'error');
  const sent = fake.stdinLines().find((l) => l.type === 'control_response');
  assert.deepEqual(sent.response.response, { behavior: 'deny', message: 'The user declined this on their phone.' });
  await driver.kill();
});

test('always: the CLI\'s own suggestion is echoed back so the next edit does not ask', async () => {
  const { driver, log, fake } = make('always');
  await driver.send('two writes');
  const ask = await log.until((e) => e.type === 'permission.request');
  await driver.answer(ask.requestId, { option: 'always' });
  await log.until((e) => e.type === 'turn.done');
  assert.equal(log.of('permission.request').length, 1);
  assert.equal(log.of('item.start').filter((e) => e.name === 'Write').length, 2);
  const sent = fake.stdinLines().find((l) => l.type === 'control_response');
  assert.deepEqual(sent.response.response.updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  await driver.kill();
});

test('question: AskUserQuestion is a question card; the answer goes back as updatedInput.answers', async () => {
  const { driver, log, fake } = make('question');
  await driver.send('ask me');
  const ask = await log.until((e) => e.type === 'permission.request');
  assert.equal(ask.kind, 'question');
  assert.deepEqual(ask.options, []);
  assert.equal(ask.questions[0].question, 'Tabs or spaces?');
  assert.deepEqual(ask.questions[0].options.map((o) => o.label), ['Tabs', 'Spaces']);
  await driver.answer(ask.requestId, { option: 'allow', answers: { 'Tabs or spaces?': 'Spaces' } });
  await log.until((e) => e.type === 'turn.done');
  const sent = fake.stdinLines().find((l) => l.type === 'control_response');
  assert.equal(sent.response.response.behavior, 'allow');
  assert.deepEqual(sent.response.response.updatedInput.answers, { 'Tabs or spaces?': 'Spaces' });
  assert.equal(sent.response.response.updatedInput.questions.length, 1);
  const answered = log.of('item.done').find((e) => e.id === ask.itemId);
  assert.deepEqual(answered.result.answers, { 'Tabs or spaces?': 'Spaces' });
  const reply = log.of('item.start').filter((e) => e.kind === 'text').pop();
  assert.equal(log.of('item.delta').filter((e) => e.id === reply.id).map((e) => e.text).join(''), 'You chose Spaces.');
  await driver.kill();
});

test('plan: ExitPlanMode is a plan card with the plan text', async () => {
  const { driver, log } = make('plan', { mode: 'plan' });
  await driver.send('plan it');
  const ask = await log.until((e) => e.type === 'permission.request' && e.kind === 'plan');
  assert.match(ask.detail, /^# Plan: Add LICENSE file/);
  assert.deepEqual(ask.options.map((o) => o.label), ['Approve plan', 'Keep planning']);
  await driver.answer(ask.requestId, { option: 'allow' });
  const write = await log.until((e) => e.type === 'permission.request' && e.kind === 'edit');
  assert.equal(write.tool, 'Write');
  await driver.answer(write.requestId, { option: 'deny', message: 'plan only' });
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'error'); // the recording hit max turns
  await driver.kill();
});

test('interrupt: stops the turn and reports it as interrupted, not as an error', async () => {
  const { driver, log, fake } = make('interrupt');
  await driver.send('count');
  await log.until((e) => e.type === 'item.start');
  await driver.interrupt();
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'interrupted');
  assert.equal(done.error, undefined);
  const sent = fake.stdinLines().find((l) => l.type === 'control_request');
  assert.equal(sent.request.subtype, 'interrupt');
  assert.equal(sent.request.cancel_queued, true);
  await driver.kill();
});

test('kill: a prompt still open is denied before the process is closed', async () => {
  const { driver, log, fake } = make('deny');
  await driver.send('write');
  const ask = await log.until((e) => e.type === 'permission.request');
  await driver.kill();
  const sent = fake.stdinLines().find((l) => l.type === 'control_response');
  assert.equal(sent.response.request_id, ask.requestId);
  assert.equal(sent.response.response.behavior, 'deny');
  assert.equal(log.of('status').pop().status, 'exited');
});

test('subagent: a Task call is a subagent card; the child\'s stream nests under it', async () => {
  const { driver, log } = make('subagent');
  await driver.send('spawn an Explore agent');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');

  const task = log.of('item.start').find((e) => e.kind === 'subagent');
  assert.ok(task, 'the Task call started as a subagent item');
  assert.equal(task.name, 'Task');
  assert.equal(task.id, 'toolu_task01');
  const taskInput = log.of('item.update').find((e) => e.id === task.id && e.input);
  assert.equal(taskInput.input.subagent_type, 'Explore');

  // The sidechain's own tools and text carry the Task id as parentId.
  const glob = log.of('item.start').find((e) => e.name === 'Glob');
  assert.equal(glob.parentId, 'toolu_task01');
  const childText = log.of('item.start').find((e) => e.kind === 'text' && e.parentId === 'toolu_task01');
  assert.ok(childText, 'subagent text nested under the card');
  assert.equal(log.of('item.delta').filter((e) => e.id === childText.id).map((e) => e.text).join(''), 'Found 3 TypeScript files.');

  // task_* system frames keep the card's agent status current.
  const progress = log.of('item.update').find((e) => e.id === task.id && e.agent?.lastTool === 'Glob');
  assert.ok(progress, 'task_progress landed on the card');
  assert.ok(log.of('item.update').some((e) => e.id === task.id && e.agent?.status === 'completed'));

  // The tool_result is the agent's report; it lands after the notification.
  const taskDone = log.of('item.done').filter((e) => e.id === task.id).pop();
  assert.equal(taskDone.status, 'ok');
  assert.equal(taskDone.output, 'Found 3 TypeScript files: a.ts, b.ts, c.ts');

  // The parent's own items are not parented.
  const parentText = log.of('item.start').find((e) => e.kind === 'text' && !e.parentId);
  assert.ok(parentText);
  await driver.kill();
});

test('deltas to one item are coalesced into fewer events', async () => {
  const { driver, log } = make('tool');
  await driver.send('go');
  await log.until((e) => e.type === 'permission.request');
  const bash = log.of('item.start').find((e) => e.name === 'Bash');
  const parts = log.of('item.delta').filter((e) => e.id === bash.id);
  // five input_json_delta chunks in the recording; a 2ms replay lands them in one or two frames
  assert.ok(parts.length < 5, `expected coalescing, got ${parts.length} frames`);
  assert.equal(JSON.parse(parts.map((p) => p.text).join('')).command, 'echo helm-test');
  await driver.kill();
});
