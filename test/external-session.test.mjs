import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-external-'));
const codexHome = join(root, 'codex-home');
const threadId = '01a0cafe-0000-7000-8000-000000000001';
const sessionsDir = join(codexHome, 'sessions', '2026', '09', '20');
const locksDir = join(codexHome, 'thread-writer-locks');
const transcript = join(sessionsDir, `rollout-test-${threadId}.jsonl`);
const lock = join(locksDir, `${threadId}.lock`);
const claudeHome = join(root, 'claude-home');
const claudeProject = join(claudeHome, 'projects', '-tmp-Maser');
const claudeId = '11111111-2222-4333-8444-555555555555';
const claudeTranscript = join(claudeProject, `${claudeId}.jsonl`);

process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NO_SERVICE = '1';
mkdirSync(process.env.HELM_DIR, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(locksDir, { recursive: true });
mkdirSync(claudeProject, { recursive: true });
writeFileSync(transcript, [
  JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: '/tmp/Maser', cli_version: '0.154.0' } }),
  JSON.stringify({ type: 'turn_context', payload: {
    cwd: '/tmp/Maser', model: 'gpt-5.6-sol', effort: 'high', approval_policy: 'never',
    sandbox_policy: { type: 'dangerFullAccess' },
  } }),
  JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: {
    type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({cmd:"pwd"}); text(r.output);',
  } }),
  JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: {
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'still working' }],
  } }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 },
    last_token_usage: { input_tokens: 700, cached_input_tokens: 500, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 750 },
    model_context_window: 10000,
  } } }),
].join('\n') + '\n');
writeFileSync(lock, '');
writeFileSync(claudeTranscript, [
  JSON.stringify({ type: 'user', uuid: 'cu1', cwd: '/tmp/Maser', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello claude' } }),
  JSON.stringify({ type: 'assistant', uuid: 'ca1', timestamp: new Date().toISOString(), message: { id: 'ca1', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'working externally' }], usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 20 } } }),
].join('\n') + '\n');
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [
    { id: 'codex', label: 'Codex', engine: 'codex', cmd: 'codex', args: [], env: { CODEX_HOME: codexHome }, source: 'custom' },
    { id: 'claude', label: 'Claude', engine: 'claude', cmd: 'claude', args: [], env: { CLAUDE_CONFIG_DIR: claudeHome }, source: 'custom' },
  ],
}));

test.after(() => rmSync(root, { recursive: true, force: true }));

class Runtime extends EventEmitter {
  async listLive() { return new Map(); }
  watch() {}
}

class FakeDriver extends EventEmitter {
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.engineSessionId = opts.engineSessionId;
    this.status = 'idle';
  }
  async start() { this.started = true; }
  canRunWhileBusy(text) { return text === '/status'; }
  enableWriting() { this.monitorOnly = false; }
  async send(text) {
    this.sent = text;
    if (text === '/status') {
      this.emit('event', { type: 'turn.start', turnId: 'status-turn', text });
      this.emit('event', { type: 'item.start', id: 'status-result', turnId: 'status-turn', kind: 'text' });
      this.emit('event', { type: 'item.delta', id: 'status-result', text: 'Context: 93% left' });
      this.emit('event', { type: 'item.done', id: 'status-result', status: 'ok' });
      this.emit('event', { type: 'turn.done', turnId: 'status-turn', status: 'ok' });
    }
  }
}

test('an active external Codex thread is monitored, then continued after handoff', async () => {
  // Stand in for Codex's writer: it holds the rollout open and removes the
  // lock during a graceful SIGTERM, exactly what takeover waits for.
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { openSync, rmSync } from 'node:fs';
    openSync(${JSON.stringify(transcript)}, 'a');
    process.on('SIGTERM', () => {
      rmSync(${JSON.stringify(lock)}, { force: true });
      process.exit(0);
    });
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(writer.stdout, 'data');

  const { inventory } = await import('../packages/connect/src/inventory.js');
  const profiles = [{ id: 'codex', engine: 'codex', env: { CODEX_HOME: codexHome } }];
  const found = (await inventory(profiles)).find((x) => x.id === threadId);
  assert.equal(found.active, true);
  assert.equal(found.cwd, '/tmp/Maser');
  assert.equal(found.transcript, transcript);

  let driver;
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const sessions = new Sessions(new Runtime(), {
    makeDriver: (_engine, opts) => (driver = new FakeDriver(opts)),
  });
  const monitored = await sessions.resumeExternal({
    engine: 'codex', account: 'codex', id: threadId, cwd: '/tmp/Maser', title: 'Maser work',
  });
  assert.equal(monitored.external, true);
  assert.equal(monitored.driver, 'codex');
  assert.equal((await sessions.list()).find((s) => s.id === monitored.id).externalActive, true);
  const monitoredHistory = sessions.history(monitored.id).events;
  assert.ok(monitoredHistory.some((e) => e.type === 'item.delta' && e.text === 'still working'));
  assert.ok(monitoredHistory.some((e) => e.type === 'item.start' && e.kind === 'tool' && e.name === 'exec'));
  await sessions.input(monitored.id, '/status');
  assert.equal(sessions.get(monitored.id).external, true, 'read-only commands do not acquire the writer');
  assert.equal(existsSync(lock), true, 'the external CLI keeps running while status is inspected');
  assert.equal(driver.sent, '/status');
  const exited = once(writer, 'exit');
  await sessions.input(monitored.id, 'take it from here');
  await exited;
  assert.equal(sessions.get(monitored.id).external, false);
  assert.equal(sessions.get(monitored.id).driver, 'codex');
  assert.equal(driver.engineSessionId, threadId);
  assert.equal(driver.monitorOnly, false);
  assert.equal(driver.started, undefined, 'the lazy driver sends without an eager duplicate start');
  assert.equal(driver.sent, 'take it from here');
  const history = sessions.history(monitored.id).events;
  assert.ok(history.some((e) => e.type === 'item.delta' && e.text === 'still working'),
    'the monitored transcript remains visible after the view becomes driven');
  assert.ok(history.some((e) => e.type === 'item.start' && e.kind === 'tool' && e.name === 'exec'),
    'Codex tool calls from the external rollout remain visible too');
});

test('Codex rollout state restores status fields before another model turn', async () => {
  const { codexSessionState } = await import('../packages/connect/src/transcript.js');
  const state = await codexSessionState(transcript);
  assert.equal(state.settings.model, 'gpt-5.6-sol');
  assert.equal(state.settings.effort, 'high');
  assert.equal(state.usage.last.totalTokens, 750);
  assert.equal(state.usage.modelContextWindow, 10000);
  assert.equal(state.cliVersion, '0.154.0');
});

test('an active external Claude thread is monitored and status does not take ownership', async () => {
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { openSync } from 'node:fs';
    openSync(${JSON.stringify(claudeTranscript)}, 'a');
    process.on('SIGTERM', () => process.exit(0));
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(writer.stdout, 'data');
  try {
    const { inventory } = await import('../packages/connect/src/inventory.js');
    const profiles = [{ id: 'claude', engine: 'claude', env: { CLAUDE_CONFIG_DIR: claudeHome } }];
    const found = (await inventory(profiles)).find((x) => x.id === claudeId);
    assert.equal(found.active, true);
    assert.equal(found.transcript, claudeTranscript);

    let driver;
    const { Sessions } = await import('../packages/connect/src/sessions.js');
    const sessions = new Sessions(new Runtime(), {
      makeDriver: (_engine, opts) => (driver = new FakeDriver(opts)),
    });
    const monitored = await sessions.resumeExternal({
      engine: 'claude', account: 'claude', id: claudeId, cwd: '/tmp/Maser', title: 'Claude work',
    });
    assert.equal(monitored.external, true);
    await sessions.input(monitored.id, '/status');
    assert.equal(sessions.get(monitored.id).external, true);
    assert.equal(driver, undefined, 'status is read locally and does not start a competing CLI');
    assert.doesNotThrow(() => process.kill(writer.pid, 0));
    const status = sessions.history(monitored.id).events.filter((e) => e.type === 'item.delta').at(-1)?.text;
    assert.match(status, /\*\*Model:\*\* claude-test/);
    assert.match(status, /\*\*Input:\*\* 10/);

    const exited = once(writer, 'exit');
    await sessions.input(monitored.id, 'continue here');
    await exited;
    assert.equal(sessions.get(monitored.id).external, false);
    assert.equal(driver.sent, 'continue here');
  } finally {
    try { process.kill(writer.pid, 'SIGKILL'); } catch { /* already exited */ }
  }
});
