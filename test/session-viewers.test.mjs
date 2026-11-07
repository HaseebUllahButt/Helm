import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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


test('PTY attachment preserves the host snapshot position and supports older hosts', async t => {
  const { viewers, sessions } = fixture(t, async () => ({ text: '' }));
  sessions.get().pty = true;
  sessions.watch = () => {};
  const terminal = { snapshot: async () => ({ text: '🙂é中', position: 40 }), renew: async () => ({ ok: true }) };
  // Use a separate core with the actual PTY snapshot interface.
  const positioned = new SessionViewers(sessions, { terminal: () => terminal });
  const screen = await positioned.attach('chat');
  assert.equal(screen.position, 40);
  assert.equal(screen.text, '🙂é中');
  assert.equal((await positioned.attach('chat', { renew: true })).text, null);
  terminal.snapshot = async () => ({ text: 'old host' });
  assert.equal((await positioned.attach('chat')).position, undefined);
  positioned.stop();
});


test('native history grows its byte window even when a large tool result hides all older messages', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-native-window-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'chat.jsonl');
  const records = Array.from({ length: 150 }, (_, i) => JSON.stringify({ type: 'assistant',
    message: { id: 'm' + i, content: [{ type: 'text', text: 'Reply ' + i }] } }));
  records.push(JSON.stringify({ type: 'progress', data: 'x'.repeat((4 << 20) + 1000) }));
  writeFileSync(path, records.join('\n') + '\n');
  const { viewers, sessions } = fixture(t, async () => ({}));
  Object.assign(sessions.get(), { engine: 'claude', transcript: path });
  sessions.events.tail = () => [];
  const first = await viewers.messages('chat', { limit: 40 });
  assert.equal(first.hasMore, true, 'a byte boundary does not mean the chat starts here');
  const older = await viewers.messages('chat', { limit: 80, pageBytes: 8 << 20 });
  assert.equal(older.messages.length, 80);
  assert.equal(older.hasMore, true);
  const all = await viewers.messages('chat', { limit: 200, pageBytes: 20 << 20 });
  assert.equal(all.messages.length, 150);
  assert.equal(all.hasMore, false);
  assert.equal(all.messages[0].text, 'Reply 0');
});
