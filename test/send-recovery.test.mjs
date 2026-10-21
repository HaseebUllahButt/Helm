import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'helm-send-recovery-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_SSH_DIR = join(root, 'ssh');
const { SendEngine } = await import('../packages/connect/src/send-engine.js');
const { codeSigningInfo, signHandoffDigest } = await import('../packages/connect/src/code-transfer.js');
const { sendReceiptDigest } = await import('../packages/connect/src/send-receiver.js');
const { M } = await import('@helm/protocol');
test.after(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;

function fixture(t) {
  const dir = join(root, String(++serial)); mkdirSync(dir);
  const source = join(dir, 'source'); mkdirSync(source); writeFileSync(join(source, 'data'), 'original bytes');
  const net = { self: 'aa11', machines: { aa11: { id: 'aa11', name: 'Laptop' },
    bb22: { id: 'bb22', name: 'VM', sendV2: true, ...codeSigningInfo() } }, devices: { phone: {} } };
  let opens = 0, receipt = null;
  const engine = new SendEngine({ network: net, directory: join(dir, 'jobs'),
    rpc: async (_target, method) => { assert.equal(method, M.SEND_RECEIPT); return { receipt }; },
    spawnProcess: () => {
      opens++;
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      let closed = false;
      child.kill = () => { if (!closed) { closed = true; child.emit('close', 12); } };
      setTimeout(child.kill, 20);
      return child;
    } });
  // This fixture tests work ordering without connecting any machine.
  engine.ensureServer = async () => {};
  t.after(() => engine.stop());
  return { engine, source, net, opens: () => opens, setReceipt(value) { receipt = value; } };
}

test('cancelling while its local tunnel opens never starts rsync afterwards', async t => {
  const f = fixture(t);
  let entered, release;
  const opening = new Promise(resolve => { entered = resolve; });
  f.engine.ensureServer = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const { job } = f.engine.start({ path: f.source, targetMachineId: 'bb22' }, 'phone');
  await opening;
  const active = f.engine.get(job.id).job; active.rate = 123; active.eta = 90;
  const cancelled = f.engine.cancel({ jobId: job.id }, 'phone'); release();
  const stopped = (await cancelled).job;
  assert.equal(stopped.phase, 'cancelled');
  assert.equal(stopped.rate, null);
  assert.equal(stopped.eta, null);
  assert.equal(f.opens(), 0, 'a stopped send must not start another process');
});

test('a signed receipt recovers an acknowledged copy even after its source is deleted', async t => {
  const f = fixture(t);
  const { job } = f.engine.start({ path: f.source, targetMachineId: 'bb22' }, 'phone');
  assert.equal((await f.engine.wait(job.id)).phase, 'failed');
  const record = f.engine.get(job.id), bytes = record.job.bytes.total;
  const receipt = { jobId: job.id, folder: '/received/source', at: Date.now() - 1000,
    sourceMachineId: f.net.self,
    intentDigest: createHash('sha256').update(JSON.stringify({ ...record.intent, source: f.net.self })).digest('hex') };
  receipt.signature = signHandoffDigest(sendReceiptDigest(receipt)); f.setReceipt(receipt);
  rmSync(f.source, { recursive: true });
  f.engine.retry({ jobId: job.id }, 'phone');
  const recovered = await f.engine.wait(job.id);
  assert.equal(recovered.phase, 'done', recovered.error);
  assert.equal(recovered.finishedAt, receipt.at);
  assert.equal(recovered.bytes.total, bytes);
  assert.equal(recovered.bytes.sent, bytes);
  assert.equal(f.opens(), 1, 'receipt recovery cannot replay the copy');
});

test('retry clears the old rate and remaining-time estimate while preparing', async t => {
  const f = fixture(t);
  const { job } = f.engine.start({ path: f.source, targetMachineId: 'bb22' }, 'phone');
  await f.engine.wait(job.id);
  const record = f.engine.get(job.id); record.job.rate = 123; record.job.eta = 90;
  record.job.route = 'old route'; record.job.changed = { files: 1, bytes: 5 };
  const retry = f.engine.retry({ jobId: job.id }, 'phone').job;
  assert.equal(retry.rate, null);
  assert.equal(retry.eta, null);
  assert.equal(retry.route, null);
  assert.equal(retry.changed, null);
});

test('an immediate cancel consumes a failed source scan without an unhandled rejection', async t => {
  const f = fixture(t);
  rmSync(f.source, { recursive: true });
  const { job } = f.engine.start({ path: f.source, targetMachineId: 'bb22' }, 'phone');
  assert.equal((await f.engine.cancel({ jobId: job.id }, 'phone')).job.phase, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.opens(), 0);
});

test('a failed send has no remaining-time or speed estimate', async t => {
  const f = fixture(t);
  const { job } = f.engine.start({ path: f.source, targetMachineId: 'bb22' }, 'phone');
  const active = f.engine.get(job.id).job; active.rate = 123; active.eta = 90;
  const stopped = await f.engine.wait(job.id);
  assert.equal(stopped.phase, 'failed');
  assert.equal(stopped.rate, null);
  assert.equal(stopped.eta, null);
});
