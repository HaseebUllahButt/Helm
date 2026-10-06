import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-hooks-'));
process.env.HELM_DIR = join(root, 'helm');
const { hookSettings, startHookServer, sendHook } = await import('../packages/connect/src/claude-hooks.js');
const path = join(root, 'hooks.sock');

test('the settings add Helm to each hook Claude has, waiting long only for a question', () => {
  const { hooks } = JSON.parse(hookSettings('/usr/bin/node', "/opt/it's/hook.js"));
  assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'PermissionRequest', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.equal(hooks.PermissionRequest[0].matcher, '*');
  assert.ok(hooks.PermissionRequest[0].hooks[0].timeout >= 3600);
  assert.equal(hooks.Stop[0].hooks[0].timeout, undefined);
  assert.equal(hooks.Stop[0].hooks[0].command, `'/usr/bin/node' '/opt/it'\\''s/hook.js'`);
});

test('a question waits for the answer; a notice does not', async () => {
  const seen = [];
  let answer;
  const h = await startHookServer((native, event, reply) => {
    seen.push([native, event.hook_event_name]);
    if (event.hook_event_name === 'PermissionRequest') answer = reply; else reply(null);
  }, path);
  try {
    assert.equal(await sendHook('native-1', { hook_event_name: 'Stop' }, { path }), null);
    const waiting = sendHook('native-1', { hook_event_name: 'PermissionRequest', tool_name: 'Write' }, { path });
    await new Promise((r) => setTimeout(r, 50));
    const out = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    answer(out);
    assert.deepEqual(await waiting, out);
    assert.deepEqual(seen, [['native-1', 'Stop'], ['native-1', 'PermissionRequest']]);
  } finally { h.close(); }
});

test('a hook that goes away tells Helm the question was answered elsewhere', async () => {
  let closed = false;
  const h = await startHookServer((native, event, reply) => { reply.onClose(() => { closed = true; }); }, path);
  try {
    const { createConnection } = await import('node:net');
    const sock = createConnection(path);
    await new Promise((r) => sock.on('connect', r));
    sock.write(JSON.stringify({ native: 'n', event: { hook_event_name: 'PermissionRequest' } }) + '\n');
    await new Promise((r) => setTimeout(r, 50));
    sock.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, true);
  } finally { h.close(); }
});

test('no Helm listening: the hook says nothing and Claude carries on', async () => {
  assert.equal(await sendHook('native-1', { hook_event_name: 'PermissionRequest' }, { path: join(root, 'none.sock') }), null);
});
