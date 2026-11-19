import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parsePhoneArgs, runPhoneCommand } from '../packages/connect/src/phone-cli.js';

// helm phone as an agent runs it, against a fake Helm that answers the calls.

function sink() { const s = { text: '', write(d) { s.text += d; return true; } }; return s; }

function fakeHelm(script) {
  const calls = [];
  const rpc = async (_env, method, params) => {
    calls.push({ method, params });
    const step = script(method, params, calls);
    if (step instanceof Error) throw step;
    return step;
  };
  return { rpc, calls };
}

async function run(args, script, { env = { HELM_SESSION_ID: 'chat-1' }, signals } = {}) {
  const out = sink(), err = sink();
  const { rpc, calls } = fakeHelm(script);
  const code = await runPhoneCommand(args, { rpc, self: () => 'me', env, out, err, retryMs: 1, ...(signals ? { signals } : {}) });
  return { code, out: out.text, err: err.text, calls };
}

test('--choice may come many times; other flags once', () => {
  assert.deepEqual(parsePhoneArgs(['ask', 'Which?', '--choice', 'A', '--choice=B', '--timeout', '5']),
    { options: { choices: ['A', 'B'], timeout: '5' }, words: ['ask', 'Which?'] });
  assert.throws(() => parsePhoneArgs(['ask', '--why', 'a', '--why', 'b']), /more than once/);
  assert.throws(() => parsePhoneArgs(['ask', '--nope', 'x']), /unknown option/);
});

test('ask prints the answer and ends with 0', async () => {
  let waits = 0;
  const r = await run(['ask', 'Which plan?', '--choice', 'Small', '--choice', 'Big', '--why', 'Billing'], (method) => {
    if (method === 'phone.ask') return { state: 'asking' };
    waits += 1;
    return waits < 2 ? { state: 'asking' } : { state: 'answered', answer: { text: 'Big', choice: 2 } };
  });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'Big\n');
  assert.match(r.err, /Waiting for the owner/);
  const ask = r.calls[0].params;
  assert.equal(ask.sessionId, 'chat-1');
  assert.match(ask.requestId, /^phone-[a-f0-9]{24}$/);
  assert.deepEqual([ask.type, ask.question, ask.choices, ask.why, ask.timeoutMinutes], ['ask', 'Which plan?', ['Small', 'Big'], 'Billing', 30]);
});

test('each kind prints its own answer; --json prints it whole', async () => {
  const answers = { photo: { path: '/h/uploads/c/p.jpg', bytes: 10 }, location: { latitude: 31.5204, longitude: 74.3587, accuracy: 12 }, code: { code: '482913' } };
  for (const [type, answer] of Object.entries(answers)) {
    const r = await run([type, 'why'], (m) => m === 'phone.ask' ? { state: 'answered', answer } : null);
    assert.equal(r.code, 0);
    if (type === 'photo') assert.equal(r.out, '/h/uploads/c/p.jpg\n');
    if (type === 'location') assert.equal(r.out, '31.520400 74.358700\nAccuracy: about 12 m\n');
    if (type === 'code') { assert.equal(r.out, '482913\n'); assert.equal(r.calls[0].params.site, 'why'); }
    const j = await run([type, '--json'], (m) => m === 'phone.ask' ? { state: 'answered', answer } : null);
    assert.deepEqual(JSON.parse(j.out), answer);
  }
});

test('refused, no answer in time and a closed request have their own exit codes', async () => {
  const refused = await run(['photo'], () => ({ state: 'refused', message: 'Not now' }));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /The owner refused: Not now/);
  const late = await run(['location', '--timeout', '2'], () => ({ state: 'timeout' }));
  assert.equal(late.code, 3);
  assert.match(late.err, /did not answer in 2 min/);
  const ended = await run(['code'], () => ({ state: 'cancelled', message: 'The chat ended.' }));
  assert.equal(ended.code, 130);
  assert.match(ended.err, /The chat ended/);
});

test('a restart of Helm is waited out, and a lost request is asked again with the same id', async () => {
  let n = 0;
  const r = await run(['code', 'GitHub'], (method) => {
    n += 1;
    if (n === 1) return { state: 'asking' };
    if (n === 2) return new Error('Helm did not respond (restarting)');
    if (n === 3) return { state: 'unknown' };
    if (n === 4) return { state: 'asking' };
    return { state: 'answered', answer: { code: '111222' } };
  });
  assert.equal(r.code, 0);
  assert.equal(r.out, '111222\n');
  assert.match(r.err, /may be restarting/);
  const asks = r.calls.filter((c) => c.method === 'phone.ask');
  assert.equal(asks.length, 2);
  assert.equal(asks[0].params.requestId, asks[1].params.requestId);
});

test('Ctrl+C closes the card', async () => {
  const signals = new EventEmitter();
  let release;
  const r = run(['photo'], (method) => {
    if (method === 'phone.ask') return { state: 'asking' };
    if (method === 'phone.cancel') { release?.(); return { state: 'cancelled' }; }
    return new Promise((resolve) => { release = () => resolve({ state: 'cancelled', message: 'The agent stopped asking.' }); setImmediate(() => signals.emit('SIGINT')); });
  }, { signals });
  const done = await r;
  assert.equal(done.code, 130);
  assert.ok(done.calls.some((c) => c.method === 'phone.cancel'));
});

test('wrong use says how to use it, and it needs a Helm chat', async () => {
  assert.equal((await run(['sms'], () => ({}))).code, 2);
  assert.equal((await run(['ask'], () => ({}))).code, 2);
  assert.equal((await run(['photo', '--choice', 'a'], () => ({}))).code, 2);
  assert.equal((await run(['ask', 'Q', '--timeout', '0'], () => ({}))).code, 2);
  const outside = await run(['photo'], () => ({}), { env: {} });
  assert.equal(outside.code, 1);
  assert.match(outside.err, /Run helm phone in a Helm chat/);
});

test('list shows open requests and cancel closes them', async () => {
  const requests = [{ requestId: 'phone-aaaa11112222', sessionId: 'c1', chat: 'Fix the login', type: 'photo', title: 'Send a photo', why: 'See the error', at: 0, until: Date.now() + 60_000 }];
  const listed = await run(['list'], (m) => m === 'phone.list' ? { requests } : null);
  assert.match(listed.out, /phone-aaaa11112222 {2}Send a photo/);
  assert.match(listed.out, /Chat: Fix the login\. Closes in 1 min\. Why: See the error/);
  const none = await run(['list'], () => ({ requests: [] }));
  assert.match(none.out, /No phone requests are open/);
  const closed = await run(['cancel', 'phone-aaaa'], (m) => m === 'phone.list' ? { requests } : { state: 'cancelled' });
  assert.match(closed.out, /Closed 1 phone request\./);
  assert.deepEqual(closed.calls.filter((c) => c.method === 'phone.cancel').map((c) => c.params.requestId), ['phone-aaaa11112222']);
});
