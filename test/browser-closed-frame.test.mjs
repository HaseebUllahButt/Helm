import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'helm-browser-closed-'));
process.env.HELM_DIR = root;
test.after(() => rm(root, { recursive: true, force: true }));
const { closedBrowserSession } = await import('../packages/connect/src/browser.js');

const ProtocolError = class extends Error {};
function libraryError(message) {
  const error = new ProtocolError(message);
  error.stack = `Error: ${message}\n    at _CRSession.send (/x/node_modules/patchright-core/lib/coreBundle.js:36966:61)`;
  return error;
}

test('a command for a frame that closed is ignored, other errors are not', () => {
  assert.equal(closedBrowserSession(libraryError('Protocol error (Network.setCacheDisabled): Detached while handling command.')), true);
  assert.equal(closedBrowserSession(libraryError('Protocol error (Network.setCacheDisabled): Internal server error, session closed.')), true);
  assert.equal(closedBrowserSession(libraryError('Protocol error (Page.navigate): Cannot navigate to invalid URL')), false);
  const ours = new ProtocolError('Detached while handling command.');
  ours.stack = 'Error: x\n    at /x/packages/connect/src/browser.js:1:1';
  assert.equal(closedBrowserSession(ours), false, 'only errors from the browser library');
  assert.equal(closedBrowserSession(new Error('Detached while handling command. patchright-core')), false);
  assert.equal(closedBrowserSession(undefined), false);
});

test('the guard keeps a closed-frame rejection from stopping the process', async () => {
  const listeners = process.listeners('unhandledRejection');
  assert.ok(listeners.length >= 1);
  const guard = listeners.find((fn) => /closedBrowserSession/.test(String(fn)));
  assert.ok(guard);
  assert.doesNotThrow(() => guard(libraryError('Detached while handling command.')));
  const other = new Error('real bug');
  assert.throws(() => guard(other), /real bug/);
});
