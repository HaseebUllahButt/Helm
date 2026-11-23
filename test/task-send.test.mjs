import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['apps/web/src/taskSend.ts'], bundle: true, write: false, format: 'cjs' });
function load(store = new Map(), fail = false) {
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, atob,
    localStorage: { getItem: key => store.get(key) ?? null,
      setItem: (key, value) => { if (fail) throw new Error('full'); store.set(key, value); },
      removeItem: key => store.delete(key) } });
  return module.exports;
}
const request = { handoffId: 'a'.repeat(24), folder: '/project', targetMachineId: 'target',
  profileId: 'fake', prompt: 'first task', includeEnv: true, allowSkipped: true };
test('reopening an uncertain task send keeps its original ID and exact request', () => {
  const store = new Map(), first = load(store), key = first.taskSendKey(undefined, 'source', '/project');
  first.prepareTaskSend(key, request);
  const reopened = load(store);
  const retry = reopened.prepareTaskSend(key, { ...request, handoffId: 'b'.repeat(24), prompt: 'different task' });
  assert.deepEqual(JSON.parse(JSON.stringify(retry.request)), request);
  reopened.finishTaskSend(key, { sent: true, status: 'running', receipt: { sessionId: 'one-task' } });
  assert.equal(load(store).readTaskSend(key).result.receipt.sessionId, 'one-task');
  reopened.forgetTaskSend(key);
  assert.equal(load(store).readTaskSend(key), null);
});
test('task sends stay separate across accounts, machines, projects and chats', () => {
  const h = load(), token = sub => `x.${btoa(JSON.stringify({ net: 'network', sub }))}.x`;
  const keys = [h.taskSendKey(token('one'), 'source', '/project'), h.taskSendKey(token('two'), 'source', '/project'),
    h.taskSendKey(token('one'), 'other', '/project'), h.taskSendKey(token('one'), 'source', '/other'),
    h.taskSendKey(token('one'), 'source', '/project', 'chat')];
  assert.equal(new Set(keys).size, keys.length);
});
test('unreadable or full storage refuses a new task before it can be sent', () => {
  const store = new Map([['bad', '{']]);
  assert.throws(() => load(store).prepareTaskSend('bad', request), /Cannot read/);
  assert.throws(() => load(store, true).prepareTaskSend('new', request), /No task was sent/);
  assert.equal(store.has('new'), false);
});
