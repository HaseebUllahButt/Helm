import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionUpdates } from '../packages/connect/src/session-updates.js';

// Chat updates reach every device. One that changes nothing on any screen
// is not sent; status goes at once; counters share a frame per window.
function updates(windowMs = 60_000) {
  const sent = [];
  let next = null;
  const u = new SessionUpdates({ windowMs, send: (payload) => { sent.push(payload); next?.(); } });
  const frame = () => new Promise((resolve) => { next = resolve; });
  const tick = () => new Promise((resolve) => queueMicrotask(resolve));
  return { u, sent, frame, tick };
}

const chat = (extra = {}) => ({ id: 'c1', status: 'idle', title: 'Fix it', lastSeq: 1, ...extra });

test('an update that changes nothing the devices hold is not sent', async (t) => {
  const { u, sent, tick } = updates();
  t.after(() => u.stop());
  u.push({ session: chat({ alive: false }) });
  await tick();
  u.push({ session: chat({ alive: false }) });
  // Devices keep `alive` when an update leaves it out.
  u.push({ session: chat() });
  await tick();
  assert.equal(sent.length, 1);
  u.push({ session: chat({ alive: false, title: 'Fix it now' }) });
  await tick();
  assert.equal(sent.length, 2, 'a real change still goes');
});

test('status goes at once; counters wait and go once with the newest value', async (t) => {
  const { u, sent, frame, tick } = updates(20);
  t.after(() => u.stop());
  u.push({ session: chat() });
  await tick();
  u.push({ session: chat({ lastSeq: 2 }) });
  u.push({ session: chat({ lastSeq: 3 }) });
  await tick();
  assert.equal(sent.length, 1, 'counter changes wait for the window');
  const counters = frame();
  await counters;
  assert.equal(sent.length, 2);
  assert.equal(sent[1].session.lastSeq, 3);
  u.push({ session: chat({ lastSeq: 4, status: 'working' }) });
  await tick();
  assert.equal(sent.length, 3, 'a status change does not wait');
  assert.equal(sent[2].session.status, 'working');
});

test('a plain update and its transition in the same tick make one frame', async (t) => {
  const { u, sent, tick } = updates();
  t.after(() => u.stop());
  u.push({ session: chat() });
  await tick();
  u.push({ session: chat({ status: 'working' }) });
  u.push({ session: chat({ status: 'working' }), transition: { from: 'idle', to: 'working' } });
  await tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].transition, { from: 'idle', to: 'working' });
  u.push({ session: chat({ status: 'working' }), transition: { from: 'working', to: 'working' } });
  await tick();
  assert.equal(sent.length, 3, 'a transition always goes');
});

test('a question, a deletion and a list refresh always go', async (t) => {
  const { u, sent, tick } = updates();
  t.after(() => u.stop());
  u.push({ session: chat() });
  await tick();
  u.push({ session: chat({ ask: { text: 'Run it?' } }), asked: true });
  await tick();
  u.push({ session: chat({ ask: { text: 'Run it?' } }), asked: true });
  await tick();
  u.push({});
  u.push({ session: chat({ deleted: true }) });
  await tick();
  assert.deepEqual(sent.map((p) => p.asked ? 'asked' : p.session?.deleted ? 'deleted' : p.session ? 'plain' : 'refresh'),
    ['plain', 'asked', 'asked', 'refresh', 'deleted']);
  u.push({ session: chat() });
  await tick();
  assert.equal(sent.length, 6, 'a chat seen again after deletion starts fresh');
});
