import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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

async function modelControl(t) {
  let receive, exited;
  const writes = [];
  const pipe = { onData(fn) { receive = fn; }, onExit(fn) { exited = fn; },
    write(raw) { writes.push(JSON.parse(raw)); }, end() { exited({ code: 0 }); },
    detach() {}, kill() { exited({ code: 0 }); } };
  const driver = new ClaudeDriver({ cmd: 'unused', cwd: '/tmp', model: 'opus',
    engineSessionId: 'existing-conversation', procId: 'hosted', procHost: {
      hasProc: () => false, openProc: async () => {}, procPipe: () => pipe } });
  await driver.start();
  t.after(() => driver.kill());
  return { driver, writes, reply: response => receive(JSON.stringify({ type: 'control_response',
    response: { ...response, request_id: writes.at(-1).request_id } }) + '\n') };
}

test('Claude model changes keep the conversation and wait for the provider acknowledgment', async t => {
  const { driver, writes, reply } = await modelControl(t);
  const pending = driver.setModel('sonnet');
  assert.equal(driver.model, 'opus');
  assert.deepEqual(writes[0].request, { subtype: 'set_model', model: 'sonnet' });
  reply({ subtype: 'success' });
  await pending;
  assert.equal(driver.model, 'sonnet');
  assert.equal(driver.engineSessionId, 'existing-conversation');
  assert.equal(writes.length, 1, 'changing model neither resends the conversation nor restarts it');
});

test('a rejected Claude model leaves the previous model and conversation usable', async t => {
  const { driver, reply } = await modelControl(t);
  const pending = driver.setModel('unavailable-model');
  reply({ subtype: 'error', error: 'This model is not available on your account.' });
  await assert.rejects(pending, /not available/);
  assert.equal(driver.model, 'opus');
  const retry = driver.setModel('sonnet');
  reply({ subtype: 'success' });
  await retry;
  assert.equal(driver.model, 'sonnet');
});

test('a missing Claude model acknowledgment is a failure and never a selected model', async t => {
  const { driver } = await modelControl(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = driver.setModel('sonnet');
  t.mock.timers.tick(15_001);
  await assert.rejects(pending, /did not confirm/);
  assert.equal(driver.model, 'opus');
});

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

test('user chats use an interactive client entrypoint while delegated tasks stay hidden SDK sessions', () => {
  for (const engineSessionId of [null, 'existing-conversation']) {
    const env = { CLAUDE_CONFIG_DIR: '/account', CLAUDE_CODE_ENTRYPOINT: 'sdk-py' };
    const user = new ClaudeDriver({ cmd: 'claude', env, cwd: '/project', engineSessionId });
    const child = new ClaudeDriver({ cmd: 'claude', env, cwd: '/project', engineSessionId, delegated: true });
    assert.equal(user.env.CLAUDE_CODE_ENTRYPOINT, 'claude-vscode');
    assert.equal(child.env.CLAUDE_CODE_ENTRYPOINT, 'sdk-cli');
    assert.equal(user.env.CLAUDE_CONFIG_DIR, '/account');
    assert.equal(user.cwd, '/project');
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'sdk-py', 'do not change the shared account environment');
  }
});

test('hosted Claude receives the project directory and interactive history entrypoint', async t => {
  const fake = fakeCli('claude', 'plain');
  let opened, exited;
  const pipe = { onData() {}, onExit(callback) { exited = callback; }, write() {},
    end() { exited?.({ code: 0 }); }, kill() { exited?.({ code: 0 }); } };
  const driver = new ClaudeDriver({ cmd: fake.cmd, env: { CLAUDE_CONFIG_DIR: '/account' },
    cwd: fake.dir, procId: 'new-chat', procHost: {
      hasProc: () => false,
      openProc: async (id, spec) => { opened = spec; },
      procPipe: () => pipe,
    } });
  t.after(async () => { await driver.kill(); rmSync(fake.dir, { recursive: true, force: true }); });
  await driver.start();
  assert.equal(opened.cwd, fake.dir);
  assert.equal(opened.env.CLAUDE_CONFIG_DIR, '/account');
  assert.equal(opened.env.CLAUDE_CODE_ENTRYPOINT, 'claude-vscode');
  assert.ok(opened.args.includes('-p'), 'preserve the streaming chat protocol');
});

test('effort switches on the live Claude pipe without restarting or replaying the conversation', async t => {
  const { driver, writes, reply } = await modelControl(t);
  driver.effort = 'high';
  const pending = driver.setEffort('medium');
  assert.equal(driver.effort, 'high');
  assert.deepEqual(writes.at(-1).request, { subtype: 'apply_flag_settings', settings: { effortLevel: 'medium' } });
  reply({ subtype: 'success' });
  await pending;
  assert.equal(driver.effort, 'medium');
  assert.equal(driver.engineSessionId, 'existing-conversation');
  await driver.send('continue');
  assert.equal(writes.length, 2, 'the same pipe receives the next message');
  assert.equal(writes[1].type, 'user');
});

test('a rejected or unacknowledged effort keeps the live Claude conversation and old effort', async t => {
  const { driver, reply } = await modelControl(t);
  driver.effort = 'high';
  const rejected = driver.setEffort('max');
  reply({ subtype: 'error', error: 'Effort is not available on this model.' });
  await assert.rejects(rejected, /not available/);
  assert.equal(driver.effort, 'high');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = driver.setEffort('low');
  t.mock.timers.tick(15_001);
  await assert.rejects(pending, /did not confirm/);
  assert.equal(driver.effort, 'high');
});

test('default effort clears the live override and invalid effort never reaches Claude', async t => {
  const { driver, writes, reply } = await modelControl(t);
  const pending = driver.setEffort('auto');
  assert.deepEqual(writes.at(-1).request.settings, { effortLevel: null });
  reply({ subtype: 'success' });
  await pending;
  assert.equal(driver.effort, null);
  await assert.rejects(driver.setEffort('invalid'), /invalid/);
  assert.equal(writes.length, 1);
});

test('a Claude exit rejects a pending setting change immediately', async t => {
  const { driver } = await modelControl(t);
  const pending = driver.setEffort('medium');
  const rejected = assert.rejects(pending, /exited before confirming/);
  await driver.kill();
  await rejected;
  assert.equal(driver.effort, null);
});

test('plain: text streams in as deltas, then the turn completes with its cost', async () => {
  const { driver, log } = make('plain');
  await driver.send('Reply with exactly the words: hello from helm');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  // The CLI's figure is a running total; Sessions turns it into the turn's.
  assert.equal(done.costTotalUsd, 0.016515);
  const turn = log.of('turn.start')[0];
  assert.equal(turn.text, 'Reply with exactly the words: hello from helm');
  const text = log.of('item.start').find((e) => e.kind === 'text');
  assert.ok(text, 'a text item started');
  assert.equal(log.of('item.delta').filter((e) => e.id === text.id).map((e) => e.text).join(''), 'hello from helm');
  assert.ok(log.of('item.start').some((e) => e.kind === 'thinking'));
  assert.ok(log.of('limits').length, 'rate limit snapshot forwarded');
  assert.deepEqual(log.of('status').map((e) => e.status), ['working', 'idle']);
  const commands = await driver.availableCommands();
  assert.ok(commands.some((command) => command.name === 'compact'));
  assert.ok(commands.some((command) => command.name === 'code-review'));
  await driver.kill();
  assert.equal(log.of('status').pop().status, 'exited');
});

test('a wake-up the CLI starts by itself is a turn of its own, not the last one closing again', async () => {
  // Background tasks finishing make Claude answer with no message from us.
  // Folded into the last turn, each one closed that turn again.
  const { driver, log } = make('wake');
  await driver.send('Reply with exactly the words: hello from helm');
  await log.until((e) => e.type === 'turn.done' && String(e.turnId).startsWith('wake-') && log.of('turn.done').length === 3);
  const starts = log.of('turn.start');
  const dones = log.of('turn.done');
  assert.equal(starts.length, 3);
  assert.equal(starts[0].text, 'Reply with exactly the words: hello from helm');
  assert.ok(starts.slice(1).every((e) => e.wake === true && e.text === '' && e.turnId.startsWith('wake-')));
  // The last result is said twice; the second opens no turn and closes nothing.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(log.of('turn.start').length, 3);
  assert.equal(log.of('turn.done').length, 3);
  assert.deepEqual(dones.map((e) => e.turnId), starts.map((e) => e.turnId), 'every turn closes exactly once');
  const wakeText = log.of('item.start').find((e) => e.kind === 'text' && e.turnId === starts[1].turnId);
  assert.ok(wakeText, "the wake-up's words belong to the wake-up");
  assert.equal(log.of('item.delta').filter((e) => e.id === wakeText.id).map((e) => e.text).join(''), 'background check is clean');
  await driver.kill();
});

test('delegated Claude tasks cannot enter a plan approval workflow', () => {
  const { driver } = make('plain', { mode: 'bypassPermissions', delegated: true });
  const flag = driver.args.indexOf('--disallowedTools');
  assert.ok(flag >= 0);
  assert.equal(driver.args[flag + 1], 'EnterPlanMode,ExitPlanMode');
});

test('Helm-managed Claude threads keep native subagents on start and resume', () => {
  for (const engineSessionId of [undefined, 'abc']) {
    const { driver } = make('plain', { engineSessionId, instructions: 'Use Helm' });
    assert.equal(driver.args[driver.args.indexOf('--disallowedTools') + 1], 'EnterPlanMode,ExitPlanMode');
    assert.equal(driver.args[driver.args.indexOf('--append-system-prompt') + 1], 'Use Helm');
    if (engineSessionId) assert.ok(driver.args.includes('--resume=abc'));
  }
});

test('reattaching Claude restores its active text block and completes the original turn', async () => {
  let receive;
  const pipe = { onData: (cb) => { receive = cb; }, onExit: () => {}, detach: () => {} };
  const { driver, log } = make('plain', {
    procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe },
    openTurn: () => 'original-turn',
    resumeEvents: () => [{ type: 'item.start', id: 'message-1#0', kind: 'text', turnId: 'original-turn' }],
  });
  await driver.start();
  receive(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'continued' } } }) + '\n');
  receive(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0 }) + '\n');
  assert.equal(log.of('item.delta')[0].id, 'message-1#0');
  assert.equal(log.of('item.delta')[0].text, 'continued');
  assert.equal(log.of('turn.done')[0].turnId, 'original-turn');
  assert.equal(log.of('turn.done')[0].status, 'ok');
  await driver.suspend();
});

test('a Claude question remains answerable after the daemon is replaced', async () => {
  const writes = [];
  const pipe = { onData: () => {}, onExit: () => {}, detach: () => {}, write: (data) => writes.push(JSON.parse(data)) };
  const { driver } = make('plain', {
    procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe },
    openTurn: () => 'original-turn', pendingEvents: () => [{
      requestId: 'question-before-update', kind: 'question', raw: { input: { questions: [{ question: 'Continue?' }] } },
    }],
  });
  await driver.start();
  assert.equal(driver.status, 'blocked');
  await driver.answer('question-before-update', { option: 'allow', answers: { 'Continue?': 'Yes' } });
  assert.equal(writes[0].response.request_id, 'question-before-update');
  assert.equal(writes[0].response.response.updatedInput.answers['Continue?'], 'Yes');
  await driver.suspend();
});

test('reattaching Claude restores a background task and routes its completion without a repeated tool id', async () => {
  let receive;
  const pipe = { onData: cb => { receive = cb; }, onExit: () => {}, detach: () => {} };
  const { driver, log } = make('plain', { procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe },
    openTurn: () => null, resumeEvents: () => [{ type: 'item.update', id: 'spawn-card', agent: { id: 'background-task', status: 'running' } }] });
  await driver.start();
  assert.equal(log.of('subagent.status').at(-1).status, 'working');
  receive(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'background-task', status: 'completed', summary: 'Ready' }) + '\n');
  assert.deepEqual(log.of('subagent.status').map(e => [e.id, e.status]), [['spawn-card', 'working'], ['spawn-card', 'idle']]);
  await driver.suspend();
});

test('a background shell command is not a child task, even when it fails', async () => {
  let receive;
  const pipe = { onData: cb => { receive = cb; }, onExit: () => {}, detach: () => {} };
  const { driver, log } = make('plain', { procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe },
    openTurn: () => null, resumeEvents: () => [] });
  await driver.start();
  const frame = (m) => receive(JSON.stringify({ type: 'system', ...m }) + '\n');
  frame({ subtype: 'task_started', task_id: 'bash-1', tool_use_id: 'toolu_bash', task_type: 'local_bash', description: 'scrape' });
  frame({ subtype: 'task_progress', task_id: 'bash-1' });
  frame({ subtype: 'task_notification', task_id: 'bash-1', status: 'failed', summary: 'exit 1' });
  // A real helper agent still reports its failure.
  frame({ subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'toolu_agent', task_type: 'local_agent', description: 'look' });
  frame({ subtype: 'task_notification', task_id: 'agent-1', status: 'failed', summary: 'gave up' });
  assert.deepEqual(log.of('subagent.status').map(e => [e.id, e.status]), [['toolu_agent', 'working'], ['toolu_agent', 'error']]);
  assert.equal(log.of('item.done').find(e => e.id === 'toolu_bash')?.status, 'error', 'the command itself still shows as failed');
  await driver.suspend();
});

test('reattaching Claude does not revive a background shell command as a helper', async () => {
  const pipe = { onData: () => {}, onExit: () => {}, detach: () => {} };
  const { driver, log } = make('plain', { procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe },
    openTurn: () => null, resumeEvents: () => [{ type: 'item.update', id: 'bash-card', agent: { id: 'bash-1', status: 'running', type: 'local_bash' } }] });
  await driver.start();
  assert.equal(log.of('subagent.status').length, 0);
  await driver.suspend();
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

test('auto: Claude safety stops are denied locally instead of pinging the phone', async () => {
  const { driver, log, fake } = make('tool', { mode: 'auto' });
  await driver.send('Use the Bash tool…');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(log.of('permission.request').length, 0);
  const response = fake.stdinLines().find((l) => l.type === 'control_response');
  assert.equal(response.response.response.behavior, 'deny');
  assert.match(response.response.response.message, /Claude Auto safety mode/);
  await driver.kill();
});

test('bypassPermissions: Claude tool permissions are allowed locally without notification', async () => {
  const { driver, log, fake } = make('tool', { mode: 'bypassPermissions' });
  await driver.send('Use the Bash tool…');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(log.of('permission.request').length, 0);
  const response = fake.stdinLines().find((l) => l.type === 'control_response');
  assert.equal(response.response.response.behavior, 'allow');
  await driver.kill();
});

test('switching to bypass settles an already-open Claude permission card', async () => {
  const { driver, log, fake } = make('deny');
  await driver.send('Use the Write tool…');
  const ask = await log.until((e) => e.type === 'permission.request');
  await driver.setMode('bypassPermissions');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(driver.pending.size, 0);
  assert.ok(log.of('permission.resolved').some((e) => e.requestId === ask.requestId && e.decision === 'allow'));
  const response = fake.stdinLines().find((l) => l.type === 'control_response');
  assert.equal(response.response.response.behavior, 'allow');
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

test('legacy ExitPlanMode is denied locally without asking for plan approval', async () => {
  const { driver, log, fake } = make('plan');
  await driver.send('plan it');
  const write = await log.until((e) => e.type === 'permission.request' && e.kind === 'edit');
  assert.equal(log.of('permission.request').some((e) => e.kind === 'plan'), false);
  const response = fake.stdinLines().find((l) => l.type === 'control_response');
  assert.equal(response.response.response.behavior, 'deny');
  assert.match(response.response.response.message, /Plan mode is disabled/);
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
  assert.deepEqual(log.of('subagent.status').map(e => [e.id, e.status]),
    [['toolu_task01', 'working'], ['toolu_task01', 'working'], ['toolu_task01', 'idle']]);

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

// ------------------------------------------------------------------ branching

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('a branch starts as a fork of the parent, cut at a message, into its own id', () => {
  const d = new ClaudeDriver({ cmd: 'claude', env: {}, cwd: '/x', mode: 'default', forkFrom: { sessionId: A, at: B } });
  const a = d.args;
  assert.ok(a.includes(`--resume=${A}`));
  assert.ok(a.includes('--fork-session'));
  assert.ok(a.includes(`--resume-session-at=${B}`));
  const own = a.find((x) => x.startsWith('--session-id='));
  assert.match(own, /^--session-id=[0-9a-f-]{36}$/);
  assert.notEqual(own, `--session-id=${A}`, 'the branch gets an id of its own');
  assert.ok(!a.some((x) => x === `--resume=${d.engineSessionId}`), 'it does not resume itself');
});

test('a fork with an id that is not a uuid is dropped, never turned into an argument', () => {
  for (const bad of [{ sessionId: 'x; rm -rf ~', at: B }, { sessionId: A, at: '--dangerous' }, { sessionId: A }, null, {}]) {
    const d = new ClaudeDriver({ cmd: 'claude', env: {}, cwd: '/x', mode: 'default', forkFrom: bad });
    assert.ok(!d.args.includes('--fork-session'), JSON.stringify(bad));
    assert.ok(!d.args.some((x) => x.includes('rm -rf') || x.includes('--dangerous')));
  }
});

test('a finished turn says where a branch could be cut, and the branch stands alone after it', async () => {
  const { driver, log } = make('plain', { forkFrom: { sessionId: A, at: B } });
  assert.ok(driver.args.includes('--fork-session'));
  await driver.send('hi');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.match(done.resumeAt ?? '', /^[0-9a-f-]{36}$/, 'the last assistant message of the turn');
  assert.equal(driver.forkFrom, null, 'after its first turn a branch resumes like any thread');
  assert.ok(!driver.args.includes('--fork-session'));
  await driver.kill();
});

test('helm\'s brief goes in the system prompt, not the owner\'s message', () => {
  const d = new ClaudeDriver({ cmd: 'claude', env: {}, cwd: '/x', mode: 'default', instructions: '[helm delegation: x]' });
  const a = d.args;
  assert.equal(a[a.indexOf('--append-system-prompt') + 1], '[helm delegation: x]');
  assert.ok(!new ClaudeDriver({ cmd: 'claude', env: {}, cwd: '/x', mode: 'default' }).args.includes('--append-system-prompt'));
});
