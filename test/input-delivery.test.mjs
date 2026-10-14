import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'helm-input-delivery-tests-'));
Object.assign(process.env, { HELM_DIR: root, HELM_DB: join(root, 'hub.sqlite'), HELM_SSH_DIR: join(root, 'ssh'),
  HELM_PROCS_SOCKET: join(root, 'procs.sock'), HELM_TERMINALS_SOCKET: join(root, 'terms.sock'), HELM_NATIVE_SOCKET: join(root, 'native.sock'),
  HELM_NO_SERVICE: '1' });
test.after(() => rmSync(root, { recursive: true, force: true }));
const { InputDelivery } = await import('../packages/connect/src/input-delivery.js');
const { reliableInput } = await import('../packages/protocol/reliable-input.js');

function setup(t, input) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-input-receipts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const session = { driver: 'devin', stopGeneration: 0 };
  const turns = new Map();
  const sessions = { get: () => session, turnState: (_id, turn) => turns.get(turn), input };
  return { dir, session, turns, sessions, inbox: new InputDelivery(sessions, { dir }) };
}
const request = { id: 'helper', data: 'change of plan', messageId: 'a'.repeat(32) };

test('concurrent retries and a new daemon share one persisted receipt, even after log eviction', async t => {
  let calls = 0, finish;
  const fixture = setup(t, async () => { calls++; await new Promise(resolve => { finish = resolve; }); return { ok: true }; });
  const first = fixture.inbox.deliver(request, 'sender');
  const second = fixture.inbox.deliver(request, 'sender');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  assert.deepEqual(await first, { ok: true });
  await second;
  const restarted = new InputDelivery(fixture.sessions, { dir: fixture.dir });
  assert.deepEqual(await restarted.deliver(request, 'sender'), { ok: true });
  assert.equal(calls, 1);
  await assert.rejects(restarted.deliver({ ...request, data: 'different' }, 'sender'), { code: 'delivery_conflict' });
  await assert.rejects(restarted.deliver({ ...request, id: 'another-helper' }, 'sender'), { code: 'delivery_conflict' });
  assert.deepEqual(readdirSync(join(fixture.dir, 'pending')), []);
  const saved = JSON.parse(readFileSync(join(fixture.dir, 'receipts', readdirSync(join(fixture.dir, 'receipts'))[0])));
  assert.equal(JSON.stringify(saved).includes('change of plan'), false, 'completed receipts retain no prompt or image bytes');
});

test('a crash before input resumes the pending message without a waiting caller', async t => {
  let fail;
  const f = setup(t, () => new Promise((_resolve, reject) => { fail = reject; }));
  const first = f.inbox.deliver(request);
  await new Promise(resolve => setImmediate(resolve));
  f.inbox.stop(); fail(new Error('disconnected'));
  await assert.rejects(first, { code: 'delivery_pending' });
  let received;
  f.sessions.input = async (_id, data, opts) => { received = { data, opts }; return { ok: true }; };
  const restarted = new InputDelivery(f.sessions, { dir: f.dir });
  restarted.resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.data, request.data);
  assert.match(received.opts.turnId, /^local-message-[a-f0-9]{64}$/);
  assert.deepEqual(await restarted.deliver(request), { ok: true });
});

test('shutdown before the input microtask leaves a pending message for the replacement daemon', async t => {
  let calls = 0;
  const f = setup(t, async () => { calls++; return { ok: true }; });
  const first = f.inbox.deliver(request);
  f.inbox.stop();
  await assert.rejects(first, { code: 'delivery_pending' });
  assert.equal(calls, 0);
  await new InputDelivery(f.sessions, { dir: f.dir }).deliver(request);
  assert.equal(calls, 1);
});

test('recovery removes a leftover pending file when its receipt was committed before the crash', async t => {
  let finish;
  const f = setup(t, () => new Promise(resolve => { finish = resolve; }));
  const first = f.inbox.deliver(request);
  await new Promise(resolve => setImmediate(resolve));
  const pending = join(f.dir, 'pending', readdirSync(join(f.dir, 'pending'))[0]);
  const record = readFileSync(pending);
  finish({ ok: true }); await first;
  writeFileSync(pending, record);
  f.sessions.input = () => assert.fail('a committed receipt must not be replayed');
  new InputDelivery(f.sessions, { dir: f.dir }).resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(readdirSync(join(f.dir, 'pending')), []);
});

test('a Stop during restart cancels an unaccepted delivery instead of reviving the helper', async t => {
  let fail;
  const f = setup(t, () => new Promise((_resolve, reject) => { fail = reject; }));
  const first = f.inbox.deliver(request);
  await new Promise(resolve => setImmediate(resolve));
  f.inbox.stop(); fail(new Error('disconnected')); await assert.rejects(first);
  f.session.stopGeneration++;
  f.sessions.input = () => assert.fail('a cancelled delivery must not wake the agent');
  await assert.rejects(new InputDelivery(f.sessions, { dir: f.dir }).deliver(request), { code: 'delivery_cancelled' });
});

test('a damaged pending message fails closed instead of sending changed words', async t => {
  const f = setup(t, () => assert.fail('no message may be sent'));
  const first = f.inbox.deliver(request); f.inbox.stop();
  await assert.rejects(first, { code: 'delivery_pending' });
  const path = join(f.dir, 'pending', readdirSync(join(f.dir, 'pending'))[0]);
  const saved = JSON.parse(readFileSync(path)); saved.request.data = 'changed on disk';
  writeFileSync(path, JSON.stringify(saved));
  await assert.rejects(new InputDelivery(f.sessions, { dir: f.dir }).deliver(request), { code: 'delivery_failed' });
  await assert.rejects(new InputDelivery(f.sessions, { dir: f.dir }).deliver({ ...request, messageId: 1 }), { code: 'invalid_argument' });
});

test('a crash after the queue ticket is written cannot deliver it again before the receipt is saved', async t => {
  let fail, calls = 0;
  const f = setup(t, async (_id, _text, options) => {
    calls++; f.turns.set(options.turnId, 'open');
    await new Promise((_resolve, reject) => { fail = reject; });
  });
  const first = f.inbox.deliver(request);
  await new Promise(resolve => setImmediate(resolve));
  f.inbox.stop(); fail(new Error('socket closed')); await assert.rejects(first);
  const restarted = new InputDelivery(f.sessions, { dir: f.dir });
  assert.deepEqual(await restarted.deliver(request), { ok: true, duplicate: true });
  assert.equal(calls, 1);
});

test('terminal input is rejected before acceptance; failed sends remain failed on retry', async t => {
  let calls = 0;
  const f = setup(t, async () => { calls++; throw new Error('invalid image'); });
  f.session.nativeCli = true;
  await assert.rejects(f.inbox.deliver(request), { code: 'delivery_unsupported' });
  assert.equal(calls, 0);
  delete f.session.nativeCli;
  await assert.rejects(f.inbox.deliver(request), /invalid image/);
  await assert.rejects(new InputDelivery(f.sessions, { dir: f.dir }).deliver(request), /invalid image/);
  assert.equal(calls, 1);
});

test('the sender retries the same immutable message across disconnects', async () => {
  const params = { id: 'helper', data: 'original', attachments: [{ data: 'abc' }] };
  const calls = [];
  const result = await reliableInput(async (method, request) => {
    calls.push({ method, request: structuredClone(request) });
    if (calls.length === 1) { params.data = 'edited'; params.attachments[0].data = 'different'; throw new Error('disconnected'); }
    return { ok: true };
  }, params, { messageId: 'b'.repeat(32), sleep: async () => {} });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1].request.data, 'original');
});

test('older daemons fall back once, and ambiguous legacy input is never replayed', async () => {
  const calls = [];
  await assert.rejects(reliableInput(async method => {
    calls.push(method);
    throw Object.assign(new Error(method === 'session.deliver' ? 'unknown method: session.deliver' : 'disconnected'),
      { code: method === 'session.deliver' ? 'unknown_method' : 'disconnected' });
  }, request, { sleep: () => assert.fail('legacy input must never retry') }), /disconnected/);
  assert.deepEqual(calls, ['session.deliver', 'session.input']);
});

test('an application rejection is not retried merely because its text mentions a socket', async () => {
  await assert.rejects(reliableInput(async () => {
    throw Object.assign(new Error('provider socket refused the message'), { code: 'delivery_failed' });
  }, request, { sleep: () => assert.fail('application failures must be shown immediately') }), /provider socket/);
});
