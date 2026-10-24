import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['apps/web/src/errors.ts'], bundle: true, write: false, format: 'esm' });
const { errorMessage } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

test('network failures show safe next steps and the affected machine', () => {
  for (const [code, raw, expected] of [
    ['timeout', 'session.deliver timed out; message 63d6b99d80dbbf70b29db7d320c8d800 is still unconfirmed', /reply in time/],
    ['offline', 'Machine abcdef1234567890 not connected', /Laptop is not connected/],
    ['ECONNRESET', 'socket closed at RPC.session.deliver', /Laptop is not connected/],
    ['', 'Helm is restarting', /Helm is restarting/],
    ['', 'agent is not running', /agent is not running/],
    ['', 'Error: RPC session.start failed\n at foo (secret.js:2)\nabcdef1234567890', /cannot finish this action/],
  ]) {
    const message = errorMessage(Object.assign(new Error(raw), { code }), { machine: 'Laptop' });
    assert.match(message, expected);
    assert.doesNotMatch(message, /session\.|abcdef|63d6|RPC|secret\.js|\n/);
  }
});

test('unknown values never become error text and action details stay useful', () => {
  for (const error of [null, undefined, {}, 42, '{"error":"private trace"}', '/private/trace', { status: Symbol('private'), name: Symbol('private') }]) {
    assert.equal(errorMessage(error), 'Helm cannot finish this action. Try again.');
  }
  assert.match(errorMessage(new Error('EACCES: /private/file')), /permissions/);
  assert.match(errorMessage(new Error('ENOSPC'), { machine: 'Laptop' }), /space on Laptop/);
  assert.match(errorMessage(new Error('401 Unauthorized')), /Sign in again/);
  assert.match(errorMessage(new Error('unknown method: owner.get')), /Update Helm/);
  assert.equal(errorMessage('session.private', { fallback: 'Helm cannot open this file.' }), 'Helm cannot open this file.');
});


test('readable errors keep their meaning without technical text', () => {
  assert.equal(errorMessage(new Error('message cancelled because the thread was stopped')), 'Message cancelled because the thread was stopped');
  assert.equal(errorMessage('Error: the folder is read only.'), 'The folder is read only.');
  assert.equal(errorMessage('upload failed'), 'Upload failed');
  for (const raw of ['session.deliver failed', 'workerFailed at handler (/tmp/agent.js:12:3)',
    'at worker (agent:12:4)', 'Failed with 63d6b99d80dbbf70b29db7d320c8d800',
    'Failed with 12345678-1234-1234-1234-123456789abc', 'Failed with 0x123',
    'Failed\n at worker', 'Failed on C:\\Users\\owner', '{"error":"Failed"}', '["Failed"]',
    'RPC refused the request', 'Error:\nworker failed', '"Private trace"', 'null', 'x'.repeat(161)]) {
    assert.equal(errorMessage(raw), 'Helm cannot finish this action. Try again.', raw);
  }
});

test('the same raw failure logs once across repeated calls and Error objects', () => {
  const warnings = [];
  const previous = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    for (let i = 0; i < 10; i++) errorMessage(i % 2 ? new Error('A unique warning for repeated renders.') : 'A unique warning for repeated renders.');
    errorMessage('A second unique warning for repeated renders.');
    assert.equal(warnings.length, 2);
  } finally { console.warn = previous; }
});
