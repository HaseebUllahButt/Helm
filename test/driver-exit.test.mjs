import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDriver } from '../packages/connect/src/drivers/claude.js';

test('a finished agent stop leaves no exit deadline keeping Helm alive', async t => {
  let exited;
  const pipe = { onData() {}, onExit(fn) { exited = fn; }, write() {},
    end() { exited({ code: 0 }); }, kill() { exited({ code: 0 }); } };
  const driver = new ClaudeDriver({ cmd: 'unused', cwd: '/tmp', procId: 'hosted', procHost: {
    hasProc: () => false, openProc: async () => {}, procPipe: () => pipe,
  } });
  await driver.start();
  const timers = new Set();
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => {
    const timer = set(...args); timers.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); clear(timer); });
  t.after(() => { for (const timer of timers) clear(timer); });
  await driver.kill();
  assert.equal(timers.size, 0);
});
