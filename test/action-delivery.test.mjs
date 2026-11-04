import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

test('a refused approval has a final failure only when the agent was not contacted', async () => {
  for (const notSent of [true, false]) {
    let calls = 0;
    const dir = join(root, `refused-${notSent}`);
    const sessions = { answer: async () => {
      calls++;
      throw Object.assign(new Error('The agent stopped.'), { deliveryNotSent: notSent });
    } };
    const delivery = new ActionDelivery(sessions, { dir });
    const result = await delivery.deliver(request, 'phone');
    assert.equal(result.state, notSent ? 'done' : 'checking');
    if (notSent) assert.deepEqual(result.error, { message: 'The agent stopped.', code: 'delivery_failed' });
    const restarted = new ActionDelivery(sessions, { dir });
    assert.deepEqual(await restarted.deliver(request, 'phone'), result);
    assert.equal(calls, 1, 'neither final nor uncertain failures replay the answer');
  }
});


for (const phase of ['acceptance', 'result']) test(`a full disk during ${phase} leaves no temporary file or repeatable approval`, async t => {
  const dir = join(root, 'full-' + phase);
  let calls = 0, writes = 0;
  const sessions = { answer: async () => { calls++; return { ok: true }; } };
  const delivery = new ActionDelivery(sessions, { dir });
  const original = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (file, value, options) => {
    if (typeof file === 'string' && file.startsWith(dir + '/')) {
      assert.equal(options.flag, 'wx');
      writes++;
      if (writes === (phase === 'acceptance' ? 1 : 2)) {
        original(file, '{"partial":', options);
        throw Object.assign(new Error('The disk is full.'), { code: 'ENOSPC' });
      }
    }
    return original(file, value, options);
  });
  syncBuiltinESMExports();
  try {
    if (phase === 'acceptance') {
      await assert.rejects(delivery.deliver(request, 'phone'), { code: 'ENOSPC' });
      assert.equal(calls, 0);
      assert.deepEqual(readdirSync(dir), []);
      assert.equal(delivery.status(request.actionId, 'phone').state, 'missing');
    } else {
      assert.equal((await delivery.deliver(request, 'phone')).state, 'checking');
      assert.equal(calls, 1);
      assert.equal(readdirSync(dir).length, 1, 'only the saved pending record remains');
      const restarted = new ActionDelivery(sessions, { dir });
      assert.equal((await restarted.deliver(request, 'phone')).state, 'checking');
      assert.equal(calls, 1);
    }
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('an older closed-request receipt becomes a final failure without answering again', async () => {
  let calls = 0;
  const delivery = new ActionDelivery({ answer: async () => { calls++; throw new Error('no pending request ff4f8010-289b-4ac7-9f4b-5bd95e84c93c'); } }, { dir: join(root, 'closed-old') });
  const path = delivery.path(request.actionId, 'phone');
  assert.equal((await delivery.deliver(request, 'phone')).state, 'checking');
  const digest = delivery.read(path).digest;
  assert.deepEqual(delivery.status(request.actionId, 'phone'), {
    state: 'done', result: undefined, error: { message: 'This request is no longer open.', code: 'delivery_failed' },
  });
  assert.equal(delivery.read(path).digest, digest, 'keep the binding to the original answer');
  assert.equal((await delivery.deliver(request, 'phone')).state, 'done');
  assert.equal(calls, 1);
  assert.equal(new ActionDelivery({}, {dir:delivery.dir}).status(request.actionId, 'phone').state, 'done');
});

test('other older approval errors remain uncertain and never repeat', async () => {
  for (const error of ['connection closed', 'write failed: no pending request ask', 'no pending request ask\nwrite failed']) {
    const delivery = new ActionDelivery({}, { dir: join(root, 'still-unknown-' + Buffer.from(error).toString('hex')) });
    const path = delivery.path(request.actionId, 'phone');
    const record = { digest: 'original', state:'checking', error };
    delivery.save(path, record);
    assert.equal(delivery.status(request.actionId, 'phone').state, 'checking');
    assert.deepEqual(delivery.read(path), record);
  }
});
