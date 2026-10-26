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
