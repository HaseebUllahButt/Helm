import test from 'node:test';
import assert from 'node:assert/strict';
import { runPhoneCommand } from '../packages/connect/src/phone-cli.js';

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

async function run(args, script) {
  const out = sink(), err = sink();
  const { rpc, calls } = fakeHelm(script);
  const code = await runPhoneCommand(args, { rpc, self: () => 'me', env: { HELM_SESSION_ID: 'chat-1' }, out, err, retryMs: 1 });
  return { code, out: out.text, err: err.text, calls };
}

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
