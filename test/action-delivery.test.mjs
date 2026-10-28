import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionDelivery } from '../packages/connect/src/action-delivery.js';
const root = mkdtempSync(join(tmpdir(), 'helm-actions-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const request = { actionId: 'a'.repeat(32), id: 'chat', requestId: 'ask', decision: { option: 'allow' } };
test('lost approval replies and restart return the saved result without repeating the answer', async () => {
  let calls = 0;
  const sessions = { answer: async () => { calls++; return { ok: true }; } };
  const dir = join(root, 'done');
  const delivery = new ActionDelivery(sessions, { dir });
  assert.deepEqual(await Promise.all([delivery.deliver(request, 'phone'), delivery.deliver(request, 'phone')]),
    [{ state: 'done', result: { ok: true }, error: undefined }, { state: 'done', result: { ok: true }, error: undefined }]);
  const restart = new ActionDelivery(sessions, { dir });
  assert.equal(restart.status(request.actionId, 'phone').state, 'done');
  await restart.deliver(request, 'phone');
  assert.equal(calls, 1);
  await assert.rejects(restart.deliver({ ...request, decision: { option: 'deny' } }, 'phone'), /another approval/);
  assert.equal(restart.status(request.actionId, 'other').state, 'missing');
});
test('crash during an approval stays uncertain and never repeats the answer', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const finish = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const sessions = { answer: async () => { calls++; entered(); await finish; return { ok: true }; } };
  const dir = join(root, 'crash');
  const delivery = new ActionDelivery(sessions, { dir });
  const running = delivery.deliver(request, 'phone');
  await started;
  const restart = new ActionDelivery(sessions, { dir });
  assert.equal((await restart.deliver(request, 'phone')).state, 'checking');
  assert.equal(calls, 1);
  release();
  await running;
});
test('damaged saved records fail closed', async () => {
  const dir = join(root, 'damaged');
  const delivery = new ActionDelivery({ answer: async () => ({ ok: true }) }, { dir });
  await delivery.deliver(request, 'phone');
  writeFileSync(join(dir, readdirSync(dir)[0]), '{');
  assert.throws(() => delivery.status(request.actionId, 'phone'));
  await assert.rejects(delivery.deliver(request, 'phone'));
});
