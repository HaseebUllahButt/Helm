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
  for (const error of [null, undefined, {}, 42, 'a private server trace', 'upload failed', { status: Symbol('private'), name: Symbol('private') }]) {
    assert.equal(errorMessage(error), 'Helm cannot finish this action. Try again.');
  }
  assert.match(errorMessage(new Error('EACCES: /private/file')), /permissions/);
  assert.match(errorMessage(new Error('ENOSPC'), { machine: 'Laptop' }), /space on Laptop/);
  assert.match(errorMessage(new Error('401 Unauthorized')), /Sign in again/);
  assert.match(errorMessage(new Error('unknown method: owner.get')), /Update Helm/);
  assert.equal(errorMessage('private', { fallback: 'Helm cannot open this file.' }), 'Helm cannot open this file.');
});
