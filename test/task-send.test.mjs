import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build, transform } from 'esbuild';
import { readFileSync } from 'node:fs';
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

const transferCode = (await transform(readFileSync('apps/web/src/Transfer.tsx', 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' })).code;
const returnCode = (await transform(readFileSync('apps/web/src/session/TaskReturn.tsx', 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' })).code;
function renderModule(code, imported = {}) {
  const module = { exports: {} };
  const react = { useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useMemo: fn => fn(), useCallback: fn => fn, useEffect() {} };
  vm.runInNewContext(code, { module, exports: module.exports, crypto: globalThis.crypto,
    require: name => ({ react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }, ...imported })[name] ?? {} });
  return module.exports;
}
function find(node, type) {
  if (!node || typeof node !== 'object') return;
  if (node.type === type) return node;
  for (const child of [node.props?.children].flat()) { const found = find(child, type); if (found) return found; }
}
test('the project Send entry restores its task receipt and shows queued work as waiting', () => {
  const store = new Map(), saved = load(store), key = saved.taskSendKey(undefined, 'source', '/project');
  saved.prepareTaskSend(key, request);
  saved.finishTaskSend(key, { sent: true, status: 'queued', targetMachineId: 'target', targetName: 'VM', preflight: {} });
  const app = renderModule(transferCode, { './taskSend': load(store), './session/TaskReturn': { TaskReturn: 'return-card' },
    './send/SendView': { SendView: 'project-send' } });
  const props = { client: {}, source: { id: 'source' }, envs: [], folder: '/project', onBack() {} };
  const view = app.TransferView(props);
  assert.equal(view.type, app.TaskTransferView, 'the project entry finds its saved task instead of offering a new send');
  const tree = view.type(view.props);
  assert.equal(find(tree, 'return-card').props.transfer.status, 'queued');
});
test('a source chat never calls a failed send a running task', () => {
  const app = renderModule(returnCode, { '../errors': { errorMessage: String } });
  const tree = app.TaskReturn({ client: {}, envId: 'source', transfer: { role: 'source', status: 'failed', machineName: 'VM', error: 'Login required.' } });
  assert.equal(find(tree, 'strong').props.children, 'Task send failed');
});

test('a restored failed send shows its failure and keeps the original retry request', () => {
  const store = new Map(), saved = load(store), key = saved.taskSendKey(undefined, 'source', '/project');
  saved.prepareTaskSend(key, request);
  saved.finishTaskSend(key, { sent: false, status: 'failed', targetMachineId: 'target', targetName: 'VM', error: 'Login required.', preflight: {} });
  const app = renderModule(transferCode, { './taskSend': load(store), './session/TaskReturn': { TaskReturn: 'return-card' },
    './send/SendView': { SendView: 'project-send' } });
  const view = app.TransferView({ client: {}, source: { id: 'source' }, envs: [], folder: '/project', onBack() {} });
  const tree = view.type(view.props);
  assert.equal(find(tree, 'h1').props.children, 'Task send failed');
  assert.equal(find(tree, 'return-card').props.transfer.error, 'Login required.');
  assert.equal(JSON.stringify(tree).includes('Open the new chat there'), false);
  assert.equal(saved.readTaskSend(key).request.handoffId, request.handoffId);
});
