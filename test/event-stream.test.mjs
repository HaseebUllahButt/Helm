import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, emptyLog } from '../apps/web/src/session/types.ts';

const root = mkdtempSync(join(tmpdir(), 'helm-event-stream-'));
process.env.HELM_DIR = root;
const { streamBatch, ChatEventStream } = await import('../packages/connect/src/event-stream.js');
const { SessionViewers } = await import('../packages/connect/src/session-viewers.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('repeated tool output gives way to its newest value while text and sequence numbers stay intact', () => {
  const events = [{ seq: 1, type: 'item.start', id: 'tool', kind: 'command' }];
  for (let seq = 2; seq <= 101; seq++) events.push({ seq, type: 'item.update', id: 'tool', output: 'x'.repeat(8000) + seq });
  events.push({ seq: 102, type: 'item.delta', id: 'answer', text: 'Read this now.' });
  const before = JSON.stringify(events);
  const batch = streamBatch(events);
  assert.deepEqual(batch.map(e => e.seq), events.map(e => e.seq));
  assert.equal(batch.at(-1).text, 'Read this now.');
  assert.equal(batch.filter(e => e.output).length, 1);
  assert.equal(batch.at(-2).output, 'x'.repeat(8000) + '101');
  assert.ok(JSON.stringify(batch).length < before.length / 20, 'old output snapshots must not compete with the answer');
  assert.equal(JSON.stringify(events), before, 'stored history must remain unchanged');
});

test('text flushes nearby tool updates without waiting for the tool timer or changing order', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const stream = new ChatEventStream({ recipients: () => ['phone'], emit: (...args) => sent.push(args) });
  t.after(() => stream.stop());
  stream.push('chat', { seq: 1, type: 'item.update', id: 'tool', output: 'first' });
  t.mock.timers.tick(50);
  stream.push('chat', { seq: 2, type: 'item.update', id: 'tool', output: 'newest' });
  assert.equal(sent.length, 0);
  stream.push('chat', { seq: 3, type: 'item.delta', id: 'answer', text: 'Read now' });
  t.mock.timers.tick(0);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1].map(e => e.seq), [1, 2, 3]);
  assert.equal(sent[0][1][0].output, undefined);
  assert.equal(sent[0][1][1].output, 'newest');
  assert.equal(sent[0][1][2].text, 'Read now');
  assert.deepEqual(sent[0][2], ['phone']);
});

test('tool updates still arrive while text is quiet and a closed view receives nothing', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  let readers = ['phone'];
  const stream = new ChatEventStream({ recipients: () => readers, emit: (...args) => sent.push(args) });
  stream.push('chat', { seq: 1, type: 'item.update', id: 'tool', output: 'current' });
  t.mock.timers.tick(149);
  assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  assert.equal(sent.length, 1);
  stream.push('chat', { seq: 2, type: 'item.update', id: 'tool', output: 'closed' });
  readers = [];
  t.mock.timers.tick(150);
  assert.equal(sent.length, 1);
  stream.push('chat', { seq: 3, type: 'item.update', id: 'tool', output: 'stopped' });
  stream.stop();
  readers = ['phone'];
  t.mock.timers.tick(150);
  assert.equal(sent.length, 1);
});

test('item identities and history resets keep independent tool results separate', () => {
  const events = [
    { seq: 1, type: 'item.update', id: 'tool', output: 'old run' },
    { seq: 2, type: 'history.reset' },
    { seq: 3, type: 'item.start', id: 'tool', kind: 'tool', input: { path: 'first' } },
    { seq: 4, type: 'item.update', id: 'other', output: 'another tool' },
    { seq: 5, type: 'item.update', id: 'tool', changes: [{ path: 'one', diff: 'old' }], input: { path: 'second' } },
    { seq: 6, type: 'item.done', id: 'tool', changes: [{ path: 'one', diff: 'final' }], status: 'ok', output: 'finished' },
  ];
  const batch = streamBatch(events);
  assert.equal(batch[0].output, 'old run');
  assert.equal(batch[3].output, 'another tool');
  assert.equal(batch[4].changes, undefined);
  assert.deepEqual(batch[4].input, { path: 'second' });
  assert.equal(batch[5].changes[0].diff, 'final');
  assert.equal(batch[5].status, 'ok');
});

test('coalesced tools keep the same final chat state, including empty completion fields', () => {
  for (const done of [
    { output: null, changes: null, input: { ignored: true } },
    { output: '', changes: [] },
    { output: 'finished', changes: [{ path: 'final' }] },
  ]) {
    const events = [
      { type: 'turn.start', turnId: 'turn', text: 'Work' },
      { type: 'item.start', id: 'tool', turnId: 'turn', kind: 'tool', input: { initial: true } },
      { type: 'item.update', id: 'tool', output: 'first', changes: [{ path: 'first' }], input: { updated: true } },
      { type: 'item.update', id: 'tool', output: 'second' },
      { type: 'item.done', id: 'tool', status: 'ok', ...done },
    ].map((event, i) => ({ ...event, seq: i + 1, at: i + 1 }));
    const reduce = rows => { const state = emptyLog(); for (const row of rows) apply(state, row); return state; };
    assert.deepEqual(reduce(streamBatch(events)), reduce(events));
  }
});

test('chat streams target open devices and release each view separately', () => {
  let views;
  const sessions = { get: () => ({}), watching: id => views.watching(id), events: { last: () => 4 } };
  views = new SessionViewers(sessions, {});
  const phone = JSON.stringify(['phone', 'tab-a']);
  const laptop = JSON.stringify(['laptop', 'tab-b']);
  views.watch('chat', phone); views.watch('chat', laptop);
  assert.deepEqual(views.recipients('chat'), ['phone', 'laptop']);
  views.unwatch('chat', phone);
  assert.deepEqual(views.recipients('chat'), ['laptop']);
  views.unwatch('chat', laptop);
  assert.deepEqual(views.recipients('chat'), []);
  views.watch('chat');
  assert.equal(views.recipients('chat'), null, 'old viewers retain their existing broadcast behavior');
});

test('a latest window keeps readable text ahead of repeated tool output without changing stored history', async () => {
  const { EventLog } = await import('../packages/connect/src/events.js');
  const log = new EventLog(join(root, 'events'));
  log.append('chat', { type: 'turn.start', turnId: 'turn', text: 'Work on this' });
  log.append('chat', { type: 'item.start', id: 'answer', turnId: 'turn', kind: 'text' });
  log.append('chat', { type: 'item.delta', id: 'answer', text: 'The current plan is ready.' });
  log.append('chat', { type: 'item.start', id: 'tool', turnId: 'turn', kind: 'command', command: 'build' });
  for (let i = 0; i < 100; i++) log.append('chat', { type: 'item.update', id: 'tool', output: 'x'.repeat(8000) + i });
  const latest = log.window('chat', { tail: 200 });
  assert.ok(latest.events.some(e => e.text === 'The current plan is ready.'));
  assert.equal(latest.events.filter(e => e.output).length, 1);
  assert.equal(log.since('chat', 0).filter(e => e.output).length, 100);
});
