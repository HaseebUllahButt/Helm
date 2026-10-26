import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpDriver } from '../packages/connect/src/drivers/acp.js';
import { collect } from './helpers.mjs';

// Run a real child with ACP over stdio. Each case controls the protocol,
// without a real account, network access, or delays to order its messages.
function agent(t, { init = '', session = '', prompt = '', ...opts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-acp-protocol-'));
  const script = join(dir, 'agent.mjs');
  const input = join(dir, 'input.ndjson');
  writeFileSync(script, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
const update = u => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'chat-1', update: u } });
const calls = new Map();
const request = (id, method, params) => new Promise(resolve => {
  calls.set(id, resolve);
  out({ jsonrpc: '2.0', id, method, params: { sessionId: 'chat-1', ...params } });
});
const lines = createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));
for await (const line of lines) {
  appendFileSync(${JSON.stringify(input)}, line + '\\n');
  const m = JSON.parse(line);
  if (!m.method) { calls.get(m.id)?.(m); continue; }
  const reply = result => out({ jsonrpc: '2.0', id: m.id, result });
  const error = (message, code = -32603) => out({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  // Requests may need the next input (permission answers), so do not block
  // this reader while the prompt is running.
  (async () => {
    switch (m.method) {
      case 'initialize': { ${init} return reply({ protocolVersion: 1, agentCapabilities: {} }); }
      case 'session/new': { ${session} return reply({ sessionId: 'chat-1' }); }
      case 'session/prompt': { ${prompt} return reply({ stopReason: 'end_turn' }); }
      default: if (m.id != null) return reply({});
    }
  })().catch(e => { console.error(e); process.exit(1); });
}

`);
  const driver = new AcpDriver({ engine: 'opencode', args: () => [script], acpMode: () => null }, {
    cmd: process.execPath, cwd: dir, mode: 'ask', ...opts,
  });
  t.after(() => driver.kill());
  return { driver, log: collect(driver), dir,
    sent: () => readFileSync(input, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

for (const kind of ['execute', 'edit']) {
  test(`ACP reads a ${kind} permission without an earlier tool call`, async t => {
    const { driver, log } = agent(t, { prompt: `
      await request('ask-1', 'session/request_permission', {
        toolCall: { toolCallId: 'tool-1', kind: '${kind}', title: 'Check files',
          rawInput: { command: 'echo hello' },
          content: [{ type: 'diff', path: 'hello.txt', oldText: 'old', newText: 'new' }] },
        options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }],
      });
    ` });
    await driver.send('Check files');
    const ask = await log.until(e => e.type === 'permission.request');
    assert.equal(ask.kind, kind === 'execute' ? 'command' : 'edit');
    if (kind === 'execute') assert.equal(ask.detail, 'echo hello');
    else assert.equal(ask.detail.changes[0].path, 'hello.txt');
    await driver.answer(ask.requestId, { option: 'allow' });
    await log.until(e => e.type === 'turn.done');
  });
}

for (const optionKind of ['allow_always', 'reject_always']) {
  test(`ACP shows only the offered ${optionKind} choice`, async t => {
    const { driver, log, sent } = agent(t, { prompt: `
      await request('ask-1', 'session/request_permission', {
        toolCall: { toolCallId: 'tool-1', title: 'Check files' },
        options: [{ optionId: 'choice', kind: '${optionKind}', name: 'Choose' }],
      });
    ` });
    await driver.send('Check files');
    const ask = await log.until(e => e.type === 'permission.request');
    const choice = optionKind === 'allow_always' ? 'always' : 'deny';
    assert.deepEqual(ask.options.map(o => o.id), [choice]);
    assert.equal(ask.defaultTo, optionKind === 'allow_always' ? 'allow' : 'deny');
    await driver.answer(ask.requestId, { option: choice });
    await log.until(e => e.type === 'turn.done');
    assert.deepEqual(sent().find(m => m.id === 'ask-1').result,
      { outcome: { outcome: 'selected', optionId: 'choice' } });
  });
}

for (const stage of ['init', 'session']) {
  test(`ACP closes a failed ${stage} process and retries the full handshake`, async t => {
    const { driver, log, sent, dir } = agent(t, { [stage]: `
      if (!existsSync('failed-once')) {
        writeFileSync('failed-once', String(process.pid));
        return error('Please retry');
      }
    ` });
    await assert.rejects(driver.send('hello'), /Please retry/);
    assert.equal(driver.status, 'exited');
    const failedPid = Number(readFileSync(join(dir, 'failed-once'), 'utf8'));
    assert.throws(() => process.kill(failedPid, 0), { code: 'ESRCH' });
    await driver.send('hello again');
    assert.equal((await log.until(e => e.type === 'turn.done')).status, 'ok');
    assert.equal(sent().filter(m => m.method === 'initialize').length, 2);
    assert.equal(sent().filter(m => m.method === 'session/new').length, stage === 'init' ? 1 : 2);
    assert.equal(sent().filter(m => m.method === 'session/prompt').length, 1);
  });
}

test('ACP merges partial tool updates and shows live command output', async t => {
  const { driver, log } = agent(t, { prompt: `
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Tool', kind: 'other', status: 'pending' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Run echo', kind: 'execute',
      rawInput: { command: 'echo hello', cwd: '/work' },
      content: [{ type: 'content', content: { type: 'text', text: 'hello' } }] });
    await request('ask-1', 'session/request_permission', {
      toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }],
    });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' });
  ` });
  await driver.send('Run echo');
  const ask = await log.until(e => e.type === 'permission.request');
  const progress = log.of('item.update').find(e => e.id === 'tool-1');
  assert.equal(progress?.kind, 'command');
  assert.equal(progress.command, 'echo hello');
  assert.equal(progress.cwd, '/work');
  assert.equal(progress.output, 'hello');
  assert.equal(ask.detail, 'echo hello');
  await driver.answer(ask.requestId, { option: 'allow' });
  await log.until(e => e.type === 'turn.done');
  assert.equal(log.of('item.start').filter(e => e.id === 'tool-1').length, 1);
  assert.equal(log.of('item.done').find(e => e.id === 'tool-1').output, 'hello');
});

test('ACP keeps initial tool output and reads embedded text resources', async t => {
  const { driver, log } = agent(t, { prompt: `
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read file', kind: 'read',
      content: [{ type: 'content', content: { type: 'resource', resource: { uri: 'file:///hello.txt', text: 'file text' } } }] });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-2', title: 'Run echo', kind: 'execute',
      rawInput: { command: 'echo two' }, status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'two' } }] });
  ` });
  await driver.send('Read file');
  await log.until(e => e.type === 'turn.done');
  assert.equal(log.of('item.done').find(e => e.id === 'tool-1').output, 'file text');
  const command = log.of('item.start').find(e => e.id === 'tool-2');
  assert.equal(command.kind, 'command');
  assert.equal(command.command, 'echo two');
});

test('ACP replaces tool content when an update supplies an empty list', async t => {
  const { driver, log } = agent(t, { prompt: `
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Edit file', kind: 'edit' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', content: [
      { type: 'content', content: { type: 'text', text: 'old preview' } },
      { type: 'diff', path: 'hello.txt', oldText: 'old', newText: 'new' },
    ] });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', content: [], status: 'completed' });
  ` });
  await driver.send('Edit file');
  await log.until(e => e.type === 'turn.done');
  const updates = log.of('item.update').filter(e => e.id === 'tool-1');
  assert.deepEqual(updates.at(-1).changes, []);
  assert.equal(log.of('item.done').find(e => e.id === 'tool-1').output, '');
});
