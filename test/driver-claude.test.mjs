import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function modelControl(t, version = '2.1.302') {
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
  // Helm registers its hooks first, and Claude answers with its version.
  const init = writes.shift();
  assert.equal(init.request.subtype, 'initialize');
  assert.deepEqual(init.request.hooks, { PreModelSwitch: [{ hookCallbackIds: ['helm-model-switch'] }] });
  receive(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: init.request_id,
    response: { claude_code_version: version } } }) + '\n');
  await new Promise(setImmediate);
  return { driver, writes, exit: () => exited({ code: 0 }),
    send: message => receive(JSON.stringify(message) + '\n'),
    reply: response => receive(JSON.stringify({ type: 'control_response',
      response: { ...response, request_id: writes.findLast(w => w.type === 'control_request').request_id } }) + '\n') };
}

/** What Claude Code 2.1.302 sent for a switch in a real run against a stand-in API. */
const switchHook = (over = {}) => ({ type: 'control_request', request_id: 'hook-1', request: { subtype: 'hook_callback',
  callback_id: 'helm-model-switch', input: { hook_event_name: 'PreModelSwitch', from_model: 'claude-opus-5-5',
    to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'sdk', context_tokens: 300008,
    prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0.75, pricing: 'catalog', ...over } } });

test('a Claude chat fails rather than run under the daemon when the process host cannot hold it', async () => {
  for (const host of [
    { hasProc: () => false, openProc: async () => { throw new Error('host down'); }, procPipe: () => null },
    { hasProc: () => false, openProc: async () => ({}), procPipe: () => null },
  ]) {
    const { fake, driver } = make('plain', { procHost: host, procId: 'hosted' });
    try {
      await assert.rejects(driver.start());
      assert.deepEqual(fake.stdinLines(), [], 'no Claude may start under the daemon');
    } finally { rmSync(fake.dir, { recursive: true, force: true }); }
  }
});

test('a model the owner picked over a warm cache waits for the owner, with Claude\'s own figures', async t => {
  const { driver, writes, send, reply } = await modelControl(t);
  assert.equal(driver.modelSwitchSignal, true);
  const pending = driver.setModel('sonnet', { ask: true });
  send(switchHook());
  const answer = writes.at(-1);
  assert.equal(answer.response.request_id, 'hook-1');
  assert.equal(answer.response.response.hookSpecificOutput.permissionDecision, 'deny');
  reply({ subtype: 'error', error: 'Model switch blocked by a PreModelSwitch hook: Helm is asking', error_code: 'blocked_by_hook' });
  assert.deepEqual(await pending, { ask: { tokens: 300008, costUsd: 0.75, ttl: '5m' } });
  assert.equal(driver.model, 'opus');
});

test('a cold cache, a small one, or a confirmed pick switches without a question', async t => {
  for (const [over, ask] of [[{ prompt_cache_warm: false, estimated_cache_write_usd: 0 }, true],
    [{ context_tokens: 20_000 }, true], [{}, false]]) {
    const { driver, writes, send, reply } = await modelControl(t);
    const pending = driver.setModel('sonnet', { ask });
    send(switchHook(over));
    assert.deepEqual(writes.at(-1).response.response, {}, 'Claude goes on as it decides');
    reply({ subtype: 'success' });
    assert.deepEqual(await pending, {});
    assert.equal(driver.model, 'sonnet');
  }
});

test('only a Claude known to run the switch hook is trusted to price it, and only while it runs', async t => {
  const old = await modelControl(t, '2.1.299');
  assert.equal(old.driver.modelSwitchSignal, false);
  const now = await modelControl(t);
  const said = [];
  now.driver.on('init', info => said.push(info.modelSwitchSignal));
  now.send({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5' });
  now.exit();
  assert.equal(now.driver.modelSwitchSignal, false);
  assert.deepEqual(said, [true, false]);
});

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

test("Claude's own helpers keep their saved context for an hour, unless the account decides or pays per token", () => {
  const sub = new ClaudeDriver({ cmd: 'claude', env: { CLAUDE_CONFIG_DIR: '/account' }, cwd: '/project' });
  assert.equal(sub.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, '1h');
  const own = new ClaudeDriver({ cmd: 'claude', env: { CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' }, cwd: '/project' });
  assert.equal(own.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, '5m');
  const forced = new ClaudeDriver({ cmd: 'claude', env: { FORCE_PROMPT_CACHING_5M: '1' }, cwd: '/project' });
  assert.equal(forced.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, undefined);
  const key = new ClaudeDriver({ cmd: 'claude', env: { ANTHROPIC_API_KEY: 'sk-test' }, cwd: '/project' });
  assert.equal(key.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, undefined);
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

test('a wake-up turn reads as working until it finishes, not done', async (t) => {
  // A background subagent finishing makes Claude start a turn by itself.
  // The last turn just said idle; without a status of its own the chat
  // read "done" for the whole wake-up while Claude ran tools.
  const { driver, log } = make('wake');
  t.after(() => driver.kill());
  await driver.send('Reply with exactly the words: hello from helm');
  await log.until((e) => e.type === 'turn.done' && log.of('turn.done').length === 3);
  const seq = log.events.filter((e) => e.type === 'status' || e.type === 'turn.start' || e.type === 'turn.done')
    .map((e) => e.type === 'status' ? e.status : e.type);
  assert.deepEqual(seq, [
    'working', 'turn.start', 'turn.done', 'idle',
    'turn.start', 'working', 'turn.done', 'idle',
    'turn.start', 'working', 'turn.done', 'idle',
  ]);
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
  const answer = writes.find((w) => w.type === 'control_response');
  assert.equal(answer.response.request_id, 'question-before-update');
  assert.equal(answer.response.response.updatedInput.answers['Continue?'], 'Yes');
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

test('Claude counts the work it left running after its turn, also across a reattach', async () => {
  let receive;
  const pipe = { onData: cb => { receive = cb; }, onExit: () => {}, detach: () => {} };
  const { driver } = make('plain', { procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe },
    openTurn: () => null, resumeEvents: () => [] });
  await driver.start();
  const frame = (m) => receive(JSON.stringify({ type: 'system', ...m }) + '\n');
  frame({ subtype: 'task_started', task_id: 'bash-1', tool_use_id: 'toolu_bash', task_type: 'local_bash', description: 'checks' });
  frame({ subtype: 'task_started', task_id: 'watch-1', tool_use_id: 'toolu_watch', task_type: 'monitor', description: 'log' });
  assert.equal(driver.backgroundTasks, 2);
  frame({ subtype: 'task_progress', task_id: 'bash-1' });
  frame({ subtype: 'task_notification', task_id: 'bash-1', status: 'completed', summary: 'exit 0' });
  assert.equal(driver.backgroundTasks, 1);
  frame({ subtype: 'task_notification', task_id: 'watch-1', status: 'stopped' });
  assert.equal(driver.backgroundTasks, 0);
  await driver.suspend();
  const again = make('plain', { procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe }, openTurn: () => null,
    resumeEvents: () => [
      { type: 'item.update', id: 'toolu_a', agent: { id: 'bash-a', status: 'running', type: 'local_bash' } },
      { type: 'item.update', id: 'toolu_b', agent: { id: 'bash-b', status: 'running', type: 'local_bash' } },
      { type: 'item.update', id: 'toolu_b', agent: { id: 'bash-b', status: 'completed', type: 'local_bash' } },
    ] }).driver;
  await again.start();
  assert.equal(again.backgroundTasks, 1, 'the one still running before the restart');
  await again.suspend();
});

test('reattaching Claude does not revive a background shell command as a helper', async () => {
  const pipe = { onData: () => {}, onExit: () => {}, detach: () => {} };
  const { driver, log } = make('plain', { procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe },
    openTurn: () => null, resumeEvents: () => [{ type: 'item.update', id: 'bash-card', agent: { id: 'bash-1', status: 'running', type: 'local_bash' } }] });
  await driver.start();
  assert.equal(log.of('subagent.status').length, 0);
  await driver.suspend();
});

test('passive Claude watches do not keep a finished chat working, but their tool result stays visible', async () => {
  let receive;
  const pipe = { onData: cb => { receive = cb; }, onExit: () => {}, detach: () => {} };
  const { driver, log } = make('plain', { procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe },
    openTurn: () => null, resumeEvents: () => [] });
  await driver.start();
  const frame = (m) => receive(JSON.stringify({ type: 'system', ...m }) + '\n');
  for (const [id, fields] of Object.entries({
    artifact: { task_type: 'monitor_ws', ambient: true },
    monitor: { task_type: 'monitor_mcp' },
    housekeeping: { task_type: 'other', skip_transcript: true },
  })) {
    frame({ subtype: 'task_started', task_id: id, tool_use_id: id, ...fields });
    frame({ subtype: 'task_progress', task_id: id });
    frame({ subtype: 'task_notification', task_id: id, status: 'stopped', summary: 'Watch stopped' });
    // A late progress frame must not resurrect a stopped watch as a helper.
    frame({ subtype: 'task_progress', task_id: id });
  }
  assert.equal(driver.status, 'idle');
  assert.equal(log.of('subagent.status').length, 0);
  assert.equal(log.of('item.done').length, 3);
  assert.equal(log.of('item.update').find(e => e.id === 'artifact')?.agent.type, 'monitor_ws');
  frame({ subtype: 'task_started', task_id: 'helper', tool_use_id: 'helper', task_type: 'local_agent' });
  assert.deepEqual(log.of('subagent.status').map(e => [e.id, e.status]), [['helper', 'working']]);
  await driver.suspend();
});

test('reattaching Claude keeps typed watches and legacy artifact subscriptions out of the helper team', async () => {
  let receive;
  const pipe = { onData: cb => { receive = cb; }, onExit: () => {}, detach: () => {} };
  const { driver, log } = make('plain', { procId: 'alive', procHost: { hasProc: () => true, procPipe: () => pipe },
    openTurn: () => null, resumeEvents: () => [
      { type: 'item.start', id: 'artifact', kind: 'tool', name: 'Artifact' },
      { type: 'item.update', id: 'artifact', agent: { id: 'watch-old', status: 'running' } },
      { type: 'item.update', id: 'monitor', agent: { id: 'watch-new', status: 'running', type: 'monitor_mcp' } },
      { type: 'item.update', id: 'helper', agent: { id: 'agent-1', status: 'running', type: 'local_agent' } },
    ] });
  await driver.start();
  const frame = (m) => receive(JSON.stringify({ type: 'system', ...m }) + '\n');
  frame({ subtype: 'task_started', task_id: 'watch-old', tool_use_id: 'artifact' });
  frame({ subtype: 'task_progress', task_id: 'watch-old' });
  frame({ subtype: 'task_notification', task_id: 'watch-new', status: 'failed', summary: 'Disconnected' });
  frame({ subtype: 'task_notification', task_id: 'agent-1', status: 'completed', summary: 'Done' });
  assert.deepEqual(log.of('subagent.status').map(e => [e.id, e.status]), [['helper', 'working'], ['helper', 'idle']]);
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
  const sent = fake.stdinLines().find((l) => l.type === 'control_request' && l.request.subtype !== 'initialize');
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

test("Claude's record of a command it ran is a quiet answer, not a message or a turn", async (t) => {
  let receive, exited;
  const pipe = { onData(fn) { receive = fn; }, onExit(fn) { exited = fn; }, write() {},
    end() { exited({ code: 0 }); }, detach() {}, kill() { exited({ code: 0 }); } };
  const driver = new ClaudeDriver({ cmd: 'unused', cwd: '/tmp', procId: 'hosted',
    procHost: { hasProc: () => true, procPipe: () => pipe } });
  const events = [];
  driver.on('event', (e) => events.push(e));
  await driver.start();
  t.after(() => driver.kill());
  const replay = (content, extra = {}) => receive(JSON.stringify({ type: 'user', isReplay: true,
    parent_tool_use_id: null, uuid: `u-${events.length}`, message: { role: 'user', content }, ...extra }) + '\n');
  replay('<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>', { isMeta: true });
  replay('<local-command-stdout>Set model to \x1b[1m`claude-opus-5-5`\x1b[22m</local-command-stdout>');
  replay('<local-command-stdout></local-command-stdout>');
  const starts = events.filter((e) => e.type === 'turn.start');
  assert.equal(starts.length, 1, 'one card, and nothing for the caveat or an empty print');
  assert.equal(starts[0].local, true);
  assert.equal(starts[0].text, '');
  assert.equal(events.find((e) => e.type === 'item.delta').text, 'Set model to `claude-opus-5-5`');
  assert.equal(events.at(-1).type, 'turn.done', 'the card closes at once');

  // The next real message is a turn of its own, not folded into the card.
  replay('Now the real work');
  assert.equal(events.filter((e) => e.type === 'turn.start').at(-1).text, 'Now the real work');
  assert.equal(events.some((e) => e.type === 'input.consumed'), false);
});

test('a command Claude answers itself shows its answer under the command, not an empty turn', async (t) => {
  let receive, exited;
  const pipe = { onData(fn) { receive = fn; }, onExit(fn) { exited = fn; }, write() {},
    end() { exited({ code: 0 }); }, detach() {}, kill() { exited({ code: 0 }); } };
  const driver = new ClaudeDriver({ cmd: 'unused', cwd: '/tmp', procId: 'hosted',
    procHost: { hasProc: () => true, procPipe: () => pipe } });
  const events = [];
  driver.on('event', (e) => events.push(e));
  await driver.start();
  t.after(() => driver.kill());
  const say = (m) => receive(JSON.stringify(m) + '\n');
  const synthetic = (text) => say({ type: 'assistant', parent_tool_use_id: null, uuid: `a-${events.length}`,
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } });
  const result = (text) => say({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0 });

  // Recorded from Claude Code 2.1.296: the answer comes first, then the echo.
  await driver.send('/context');
  synthetic('## Context Usage\n\n**Tokens:** 28.3k / 383k (7%)');
  say({ type: 'user', isReplay: true, parent_tool_use_id: null, uuid: 'echo-1',
    message: { role: 'user', content: '<command-name>/context</command-name>\n  <command-message>context</command-message>\n  <command-args></command-args>' } });
  result('## Context Usage');
  assert.equal(events.some((e) => e.type === 'turn.start' && e.wake), false, 'not a turn Claude started by itself');
  const start = events.find((e) => e.type === 'turn.start');
  assert.equal(start.text, '/context');
  const answer = events.find((e) => e.type === 'item.start');
  assert.equal(answer.turnId, start.turnId);
  assert.match(events.find((e) => e.type === 'item.delta').text, /^## Context Usage/);
  assert.equal(events.filter((e) => e.type === 'turn.done').at(-1).turnId, start.turnId);

  // Claude echoes /cost as /usage; the message is still the one sent.
  events.length = 0;
  await driver.send('/cost');
  synthetic('Total cost: $0.0000');
  say({ type: 'user', isReplay: true, parent_tool_use_id: null, uuid: 'echo-2',
    message: { role: 'user', content: '<command-name>/usage</command-name><command-message>usage</command-message><command-args></command-args>' } });
  result('Total cost: $0.0000');
  assert.equal(events.find((e) => e.type === 'turn.start').text, '/cost');

  // A command Claude refuses never echoes; its answer still has a turn.
  events.length = 0;
  await driver.send('/status');
  synthetic("/status isn't available in this environment.");
  result("/status isn't available in this environment.");
  const refused = events.find((e) => e.type === 'turn.start');
  assert.equal(refused?.text, '/status');
  assert.equal(events.find((e) => e.type === 'item.delta').text, "/status isn't available in this environment.");
  assert.equal(events.filter((e) => e.type === 'turn.done').at(-1).turnId, refused.turnId);
});

test('a slash command Claude echoes in its own markup reads as the command', async () => {
  const { localCommandRecord } = await import('../packages/connect/src/drivers/claude.js');
  assert.deepEqual(localCommandRecord('<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args>claude-opus-5-5</command-args>'),
    { kind: 'command', text: '/model claude-opus-5-5' });
  assert.deepEqual(localCommandRecord('<command-name>/cost</command-name><command-message>cost</command-message><command-args></command-args>'),
    { kind: 'command', text: '/cost' });
  // A skill run as a command opens with its message, then its name.
  assert.deepEqual(localCommandRecord('<command-message>rpc-action-items</command-message>\n<command-name>/rpc-action-items</command-name>\n<command-args>for today</command-args>'),
    { kind: 'command', text: '/rpc-action-items for today' });
  assert.equal(localCommandRecord('Explain <local-command-stdout> tags'), null);
});

test('Claude compaction is one compact item, open from "compacting" until the CLI says it is done', async t => {
  let receive, exited;
  const pipe = { onData(fn) { receive = fn; }, onExit(fn) { exited = fn; },
    write() {}, end() { exited({ code: 0 }); }, detach() {}, kill() { exited({ code: 0 }); } };
  const driver = new ClaudeDriver({ cmd: 'unused', cwd: '/tmp', engineSessionId: 'conversation', procId: 'hosted',
    procHost: { hasProc: () => false, openProc: async () => {}, procPipe: () => pipe } });
  const log = collect(driver);
  await driver.start();
  t.after(() => driver.kill());
  const say = (m) => receive(JSON.stringify(m) + '\n');
  say({ type: 'system', subtype: 'status', status: 'compacting' });
  say({ type: 'system', subtype: 'status', status: 'compacting' });
  const starts = log.of('item.start').filter((e) => e.name === 'compact');
  assert.equal(starts.length, 1, 'the heartbeat repeat is the same compaction');
  assert.equal(driver.status, 'working');
  say({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  say({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } });
  assert.deepEqual(log.of('item.done').filter((e) => e.id === starts[0].id).map((e) => e.status), ['ok']);

  say({ type: 'system', subtype: 'status', status: 'compacting' });
  say({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'too long' });
  const second = log.of('item.start').filter((e) => e.name === 'compact')[1];
  const failed = log.of('item.done').find((e) => e.id === second.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'too long');
});

// What the conversation weighs is the last top-level reply, not the result's
// sum over the turn; the size is the model's, unless the account's settings
// compact sooner (what Claude's own /context counts against).
async function contextFeed(t, { settings, modelUsage }) {
  const home = mkdtempSync(join(tmpdir(), 'helm-claude-ctx-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (settings) writeFileSync(join(home, 'settings.json'), JSON.stringify(settings));
  let receive, exited;
  const writes = [];
  const pipe = { onData(fn) { receive = fn; }, onExit(fn) { exited = fn; }, write(raw) { writes.push(JSON.parse(raw)); }, end() { exited({ code: 0 }); }, detach() {}, kill() { exited({ code: 0 }); } };
  const driver = new ClaudeDriver({ cmd: 'unused', env: { CLAUDE_CONFIG_DIR: home }, cwd: '/tmp', mode: 'default',
    engineSessionId: 'existing-conversation', procId: 'hosted', procHost: { hasProc: () => false, openProc: async () => {}, procPipe: () => pipe } });
  await driver.start();
  t.after(() => driver.kill());
  const log = collect(driver);
  const feed = (m) => receive(`${JSON.stringify(m)}\n`);
  const reply = (usage, extra = {}) => feed({ type: 'assistant', parent_tool_use_id: null,
    message: { model: 'claude-opus-5-5[1m]', content: [], usage }, ...extra });
  const result = () => feed({ type: 'result', subtype: 'success', is_error: false, modelUsage, usage: { input_tokens: 999_999, output_tokens: 1 } });
  return { log, reply, result, feed, driver, writes };
}

test("Claude's own count of its window wins over Helm's read of its settings", async (t) => {
  const { log, reply, result, feed, writes } = await contextFeed(t, {
    settings: { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 383_000 } } },
    modelUsage: { 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 } },
  });
  reply({ input_tokens: 5, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0, output_tokens: 3 });
  result();
  assert.equal(log.of('context').at(-1).window, 383_000, 'the settings read stands until Claude answers');
  const ask = writes.findLast((w) => w.request?.subtype === 'get_context_usage');
  assert.deepEqual(ask.request, { subtype: 'get_context_usage', detail: 'summary' });
  // Set somewhere Helm does not read (an environment variable, managed settings).
  feed({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id,
    response: { totalTokens: 300_005, maxTokens: 350_000, rawMaxTokens: 350_000, autocompactSource: 'env', autoCompactThreshold: 317_000 } } });
  await new Promise(setImmediate);
  assert.deepEqual(log.of('context').at(-1), { type: 'context', used: 300_008, window: 350_000, full: 1_000_000, model: 'claude-opus-5-5' });
});

test('Claude reports context from the last top-level reply, sized by the compaction window in settings', async (t) => {
  const { log, reply, result } = await contextFeed(t, {
    settings: { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 383_000 } } },
    modelUsage: { 'claude-haiku-4-5': { contextWindow: 200_000 }, 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 } },
  });
  reply({ input_tokens: 10, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5_000, output_tokens: 500 });
  assert.deepEqual(log.of('context'), [], 'no size is known before the first result');
  // A helper's reply is not the conversation.
  reply({ input_tokens: 1, output_tokens: 1 }, { parent_tool_use_id: 'toolu_helper' });
  result();
  assert.deepEqual(log.of('context'), [{ type: 'context', used: 105_510, window: 383_000, full: 1_000_000, model: 'claude-opus-5-5' }]);
  reply({ input_tokens: 20, cache_read_input_tokens: 140_000, cache_creation_input_tokens: 8_000, output_tokens: 480 });
  assert.deepEqual(log.of('context').at(-1), { type: 'context', used: 148_500, window: 383_000, full: 1_000_000, model: 'claude-opus-5-5' });
});

test('compacting drops the ring to what is left at once, not after the next reply', async (t) => {
  const { log, reply, result, feed } = await contextFeed(t, { modelUsage: { 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 } } });
  reply({ input_tokens: 5, cache_read_input_tokens: 640_000, cache_creation_input_tokens: 5_000, output_tokens: 453 });
  result();
  assert.equal(log.of('context').at(-1).used, 645_458);
  feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 645_458, post_tokens: 8_538 } });
  assert.deepEqual(log.of('context').at(-1), { type: 'context', used: 8_538, window: 1_000_000, full: 1_000_000, model: 'claude-opus-5-5' });
  // A Claude that does not say empties the ring until the next reply does.
  feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } });
  assert.deepEqual(log.of('context').at(-1), { type: 'context', used: 0, window: 1_000_000, compacted: true });
});

test("whether a thinking-level change keeps the cache is Claude's word, and a refusal turns it off", async (t) => {
  const { feed, driver } = await contextFeed(t, {});
  const inits = [];
  driver.on('init', (info) => inits.push(info.effortKeepsCache));
  feed({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', effort: 'high', per_turn_effort_active: true });
  feed({ type: 'system', subtype: 'per_turn_effort_changed', per_turn_effort_active: false, uuid: 'u', session_id: 's' });
  // A Claude too old to say leaves it unknown, never a guess.
  feed({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(inits, [true, false, null]);
  assert.equal(driver.info.model, 'claude-opus-5-5');
});

test('Claude uses the model window when settings say nothing', async (t) => {
  const { log, reply, result } = await contextFeed(t, { modelUsage: { 'claude-opus-5-5[1m]': { contextWindow: 1_000_000 } } });
  reply({ input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000, output_tokens: 10 });
  result();
  assert.deepEqual(log.of('context'), [{ type: 'context', used: 20_015, window: 1_000_000, full: 1_000_000, model: 'claude-opus-5-5' }]);
});

test('a larger window in settings never grows the model window, and a dated model id still matches', async (t) => {
  const { log, reply, result } = await contextFeed(t, {
    settings: { modelSettings: { 'claude-haiku-4-5': { autoCompactWindow: 500_000 } } },
    modelUsage: { 'claude-haiku-4-5-20251001': { contextWindow: 200_000 } },
  });
  reply({ input_tokens: 1_000, output_tokens: 0 }, { message: { model: 'claude-haiku-4-5-20251001', content: [], usage: { input_tokens: 1_000, output_tokens: 0 } } });
  result();
  assert.deepEqual(log.of('context'), [{ type: 'context', used: 1_000, window: 200_000, full: 200_000, model: 'claude-haiku-4-5' }]);
});

test('a dated model id takes the compaction window written for its short name', async (t) => {
  const { log, reply, result } = await contextFeed(t, {
    settings: { modelSettings: { 'claude-haiku-4-5': { autoCompactWindow: 99_000 } } },
    modelUsage: { 'claude-haiku-4-5-20251001': { contextWindow: 200_000 } },
  });
  reply({ input_tokens: 1_000, output_tokens: 0 }, { message: { model: 'claude-haiku-4-5-20251001', content: [], usage: { input_tokens: 1_000, output_tokens: 0 } } });
  result();
  assert.deepEqual(log.of('context'), [{ type: 'context', used: 1_000, window: 99_000, full: 200_000, model: 'claude-haiku-4-5' }]);
});
