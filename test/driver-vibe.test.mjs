import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect } from './helpers.mjs';
import { VibeDriver, vibeAcpCommand, VIBE_SIGN_IN } from '../packages/connect/src/drivers/vibe.js';
import { isInteractiveProc } from '../packages/connect/src/engines.js';
import { defaultMode, modeFor } from '../packages/connect/src/modes.js';

// The shapes below are what vibe-acp 3.0.4 sent in a live probe.
const CONFIG = (mode = 'accept-edits', model = 'zai-glm-5-3-flash', thinking = 'high') => [
  { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: mode,
    options: ['ask', 'accept-edits', 'smart-approve', 'auto-approve'].map((value) => ({ value, name: value })) },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
    options: [
      { value: 'mistral-large-4-0-3', name: 'Mistral Large 4' },
      { value: 'glm-5-3', name: 'GLM-5.3 (Mistral Hosted)' },
      { value: 'zai-glm-5-3-flash', name: 'GLM-5.3 Flash (Mistral Hosted)' },
    ] },
  { id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: thinking,
    options: ['low', 'high', 'max'].map((value) => ({ value, name: value })) },
];

/** A `vibe` and its `vibe-acp` in one folder; vibe-acp plays a recorded session. */
function fakeVibe({ signedIn = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-fake-vibe-'));
  const log = join(dir, 'stdin.ndjson');
  const agent = `
const fs = require('node:fs');
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const config = ${JSON.stringify(CONFIG())};
let buf = '';
if (process.argv.includes('--version')) { console.log('vibe-acp 3.0.4'); process.exit(0); }
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
    const m = JSON.parse(line);
    if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      authMethods: [{ id: 'browser-auth', name: 'Sign in through Mistral AI Studio' }],
      agentInfo: { name: '@mistralai/mistral-vibe', version: '3.0.4' } } });
    else if (m.method === 'session/new') {
      if (!${signedIn}) out({ id: m.id, error: { code: -32000, message: 'Missing API key for mistral provider.' } });
      else out({ id: m.id, result: { sessionId: 'vibe-1', configOptions: config } });
    } else if (m.method === 'session/set_config_option') {
      const o = config.find((c) => c.id === m.params.configId);
      if (o) o.currentValue = m.params.value;
      out({ id: m.id, result: { configOptions: config } });
    } else if (m.method === 'session/prompt') {
      out({ method: 'session/update', params: { sessionId: 'vibe-1', update: { sessionUpdate: 'session_info_update', title: '<helm_instructions> [Helm helpers: Do the work' } } });
      out({ method: 'session/update', params: { sessionId: 'vibe-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } } } });
      out({ method: 'session/update', params: { sessionId: 'vibe-1', update: { sessionUpdate: 'session_info_update', title: 'Pong' } } });
      out({ id: m.id, result: { stopReason: 'end_turn' } });
    } else if (m.id != null) out({ id: m.id, result: {} });
  }
});
`;
  writeFileSync(join(dir, 'agent.cjs'), agent);
  for (const name of ['vibe', 'vibe-acp']) {
    const cmd = join(dir, name);
    writeFileSync(cmd, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, 'agent.cjs'))} "$@"\n`);
    chmodSync(cmd, 0o755);
  }
  return {
    dir, cmd: join(dir, 'vibe'),
    sent: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

test('vibe: the driver runs vibe-acp from the folder that holds vibe', () => {
  assert.equal(vibeAcpCommand('vibe'), 'vibe-acp');
  assert.equal(vibeAcpCommand('~/.local/bin/vibe'), '~/.local/bin/vibe-acp');
  assert.equal(vibeAcpCommand('/opt/vibe/bin/vibe-acp'), '/opt/vibe/bin/vibe-acp');
  assert.equal(new VibeDriver({ cmd: '/x/vibe', cwd: '/tmp', env: {} }).cmd, '/x/vibe-acp');
});

test('vibe: Helm modes land on Vibe agents, yolo is the default', () => {
  assert.equal(defaultMode('vibe'), 'yolo');
  assert.deepEqual(['ask', 'edit', 'smart', 'yolo'].map((m) => modeFor('vibe', m).acp),
    ['ask', 'accept-edits', 'smart-approve', 'auto-approve']);
});

test('vibe: a turn sets the mode, model and thinking, then streams the reply', async (t) => {
  const fake = fakeVibe();
  const driver = new VibeDriver({ cmd: fake.cmd, env: {}, args: [], cwd: fake.dir,
    mode: 'yolo', model: 'glm-5-3', effort: 'max' });
  t.after(() => driver.kill());
  const log = collect(driver);
  await driver.send('Reply with the single word PONG.');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.equal(driver.engineSessionId, 'vibe-1');
  const text = log.of('item.start').find((e) => e.kind === 'text');
  assert.equal(log.of('item.delta').filter((e) => e.id === text.id).map((e) => e.text).join(''), 'PONG');
  const set = fake.sent().filter((m) => m.method === 'session/set_config_option')
    .map((m) => [m.params.configId, m.params.value]);
  assert.deepEqual(set.sort(), [['mode', 'auto-approve'], ['model', 'glm-5-3'], ['thinking', 'max']]);
  // The prompt copy that starts with Helm's instructions is no name; Vibe's own title is.
  assert.deepEqual(log.of('title').map((e) => e.title), ['Pong']);
  const catalog = driver.catalog();
  assert.deepEqual(catalog.efforts, ['low', 'high', 'max']);
  assert.equal(catalog.labels['mistral-large-4-0-3'], 'Mistral Large 4');
});

test('vibe: no Mistral sign-in tells the owner what to run', async (t) => {
  const fake = fakeVibe({ signedIn: false });
  const driver = new VibeDriver({ cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'yolo' });
  t.after(() => driver.kill());
  const log = collect(driver);
  await assert.rejects(driver.start(), (error) => error.message === VIBE_SIGN_IN);
  assert.equal(log.of('error').at(-1).message, VIBE_SIGN_IN);
});

test('vibe: the terminal app is a native chat, vibe-acp and one-shot runs are not', () => {
  assert.equal(isInteractiveProc('vibe', ['/home/a/.local/bin/vibe']), true);
  assert.equal(isInteractiveProc('vibe', ['/home/a/.local/share/uv/tools/mistral-vibe/lib/python3.14/site-packages/vibe/_bin/vibe-rs']), true);
  assert.equal(isInteractiveProc('vibe', ['vibe', '-p', 'hello']), false);
  assert.equal(isInteractiveProc('vibe', ['vibe', 'config', 'schema']), false);
  assert.equal(isInteractiveProc('vibe', ['vibe-acp']), false);
});
