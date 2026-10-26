import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SessionViewers } from '../packages/connect/src/session-viewers.js';

function fixture(t, read) {
  const timers = new Set();
  t.mock.method(globalThis, 'setTimeout', callback => {
    const timer = { callback, unref() {} };
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => timers.delete(timer));
  const s = { id: 'chat' };
  const sessions = Object.assign(new EventEmitter(), { get: () => s, runtime: { read }, events: { last: () => 0 },
    unwatch() {}, watching: () => false });
  const viewers = new SessionViewers(sessions, { handle: () => s, index: new Map([[s.id, s]]),
    terminal: () => ({ unview() {} }) });
  sessions.detach = id => viewers.detach(id);
  t.after(() => viewers.stop());
  return { viewers, sessions, timers };
}

test('a failed first terminal read permits a fresh watch', async t => {
  let reads = 0;
  const { viewers, timers } = fixture(t, async () => {
    if (++reads === 1) throw new Error('read failed');
    return { text: 'screen' };
  });
  await assert.rejects(viewers.attach('chat'), /read failed/);
  assert.equal((await viewers.attach('chat')).text, 'screen');
  assert.equal(timers.size, 1, 'the second attachment starts a live poll');
});

test('a removed chat releases its viewer leases and screen poll', async t => {
  const { viewers, timers } = fixture(t, async () => ({ text: 'screen' }));
  viewers.watch('chat', 'device');
  await viewers.attach('chat');
  assert.equal(viewers.watching('chat'), true);
  assert.equal(timers.size, 1);
  viewers.forget('chat');
  assert.equal(viewers.watching('chat'), false);
  assert.equal(timers.size, 0);
});

for (const action of ['detach', 'stop']) {
  test(`${action} during the first terminal read leaves no poll`, async t => {
    let release;
    const read = new Promise(resolve => { release = resolve; });
    const { viewers, timers } = fixture(t, () => read);
    const attaching = viewers.attach('chat');
    viewers[action]('chat');
    release({ text: 'screen' });
    await attaching;
    assert.equal(timers.size, 0);
  });
}

test('a detached terminal poll cannot send stale screen data to a new watch', async t => {
  let release, reads = 0;
  const { viewers, sessions, timers } = fixture(t, async () => {
    if (++reads === 2) return new Promise(resolve => { release = resolve; });
    return { text: reads === 1 ? 'old screen' : 'new screen' };
  });
  const data = [];
  sessions.on('data', value => data.push(value));
  await viewers.attach('chat');
  const timer = [...timers][0];
  timers.delete(timer);
  const polling = timer.callback();
  viewers.detach('chat');
  await viewers.attach('chat');
  release({ text: 'stale screen' });
  await polling;
  assert.deepEqual(data, []);
  assert.equal(timers.size, 1, 'only the new watch keeps polling');
});
