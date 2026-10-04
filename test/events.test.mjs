import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLog } from '../packages/connect/src/events.js';
import { apply, emptyLog } from '../apps/web/src/session/types.ts';

test('events are numbered, persisted, and replayable from a sequence number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-'));
  const log = new EventLog(dir);
  const a = log.append('s1', { type: 'turn.start', text: 'hi' });
  const b = log.append('s1', { type: 'item.delta', id: 'x', text: 'he' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.ok(a.at <= b.at);
  assert.deepEqual(log.since('s1', 1).map((e) => e.seq), [2]);
  assert.equal(log.last('s1'), 2);

  // A fresh instance reads the file back.
  const again = new EventLog(dir);
  assert.deepEqual(again.since('s1', 0).map((e) => e.type), ['turn.start', 'item.delta']);
  assert.equal(again.append('s1', { type: 'turn.done' }).seq, 3);
});

test('unconsumed queue edits and reference snapshots survive retention and cold windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-queue-retention-'));
  const original = new EventLog(dir);
  const edited = 'Keep this entire message. '.repeat(600);
  original.append('thread', { type: 'turn.start', turnId: 'active', text: 'Work' });
  original.append('thread', { type: 'item.start', id: 'answer', turnId: 'active', kind: 'text' });
  original.append('thread', { type: 'turn.start', turnId: 'local-queued', text: 'Initial', queued: true, delivery: 'queue', references: ['reference'], referenceContext: 'Frozen reference content' });
  original.append('thread', { type: 'turn.edit', turnId: 'local-queued', text: edited });
  original.append('thread', { type: 'turn.start', turnId: 'local-removed', text: 'Removed', queued: true });
  original.append('thread', { type: 'turn.remove', turnId: 'local-removed' });
  for (let index = 0; index < 2300; index++) original.append('thread', { type: 'item.delta', id: 'answer', text: 'x' });
  for (const log of [original, new EventLog(dir), new EventLog(dir)]) {
    const events = log.tail('thread', 0);
    const ticket = events.find((event) => event.turnId === 'local-queued' && event.type === 'turn.start');
    assert.equal(ticket.delivery, 'queue');
    assert.equal(ticket.referenceContext, 'Frozen reference content');
    assert.deepEqual(ticket.references, ['reference']);
    assert.equal(events.find((event) => event.type === 'turn.edit').text, edited);
    const state = emptyLog();
    for (const event of log.window('thread', { tail: 50 }).events) apply(state, event);
    assert.equal(state.turns.find((turn) => turn.id === 'local-queued')?.text, edited);
    assert.equal(state.turns.some((turn) => turn.id === 'local-removed'), false);
  }
});

test('a parked attachment can be read back for queued-message recovery', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  const data = 'iVBORw0KGgo=';
  const { ref } = log.putAttachment('s1', { filename: 'a.png', mime: 'image/png', data });
  assert.equal(log.attachment('s1', ref), data);
  assert.equal(log.attachment('s1', 'missing'), null);
});

test('pending permissions are derived from the log', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  log.append('s', { type: 'permission.request', requestId: 'r1', kind: 'command' });
  log.append('s', { type: 'permission.request', requestId: 'r2', kind: 'edit' });
  log.append('s', { type: 'permission.resolved', requestId: 'r1', decision: 'allow' });
  assert.deepEqual(log.pending('s').map((e) => e.requestId), ['r2']);
});

test('the open turn is the last turn.start without a turn.done', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  assert.equal(log.openTurn('s'), null);
  log.append('s', { type: 'turn.start', turnId: 't1', text: 'a' });
  assert.equal(log.openTurn('s').turnId, 't1');
  log.append('s', { type: 'turn.done', turnId: 't1', status: 'ok' });
  assert.equal(log.openTurn('s'), null);
});

test('only the tail is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-'));
  const lines = [];
  for (let i = 1; i <= 2500; i++) lines.push(JSON.stringify({ seq: i, at: 0, type: 'item.delta', id: 'x', text: String(i) }));
  writeFileSync(join(dir, 'big.jsonl'), lines.join('\n') + '\n');
  const log = new EventLog(dir);
  const all = log.since('big', 0);
  assert.equal(all.length, 2000);
  assert.equal(all[0].seq, 501);
  assert.equal(log.append('big', { type: 'turn.done' }).seq, 2501);
  assert.equal(readFileSync(join(dir, 'big.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2001);
});

// The bug these cover, with its numbers: a devin thread on the owner's VM
// held 822 events and 6.8MB, 95% of it whole-file diffs repeated on an
// item's start, its updates and its done. The app asked for "the first 500
// events" and the honest answer was 5MB - 1.5s on loopback, 58s from the
// laptop, and a timeout at 20s on the phone. A chat that cannot be opened is
// worse than a chat with a clipped diff in it.

test('one event is capped before it goes on the wire', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  const huge = 'x'.repeat(200_000);
  log.append('s', { type: 'turn.start', turnId: 't', text: 'go' });
  log.append('s', {
    type: 'item.start', id: 'i1', kind: 'edit', turnId: 't',
    changes: [{ path: 'a.ts', kind: 'update', diff: huge }],
    input: { old_string: huge, file_path: 'a.ts' },
    output: huge,
  });
  const [, item] = log.window('s', { tail: 10 }).events;
  assert.ok(item.changes[0].diff.length < 9_000, 'the diff is clipped');
  assert.ok(item.changes[0].diff.includes('more characters'), 'and says so');
  assert.ok(item.input.old_string.length < 5_000, 'so is a huge tool input');
  assert.ok(item.output.length < 33_000, 'so is output');
  assert.equal(item.input.file_path, 'a.ts', 'small fields are untouched');
  // The log itself still has what the driver wrote; only the wire is capped.
  assert.equal(log.since('s', 0)[1].changes[0].diff.length, 200_000);
});

test('a page is measured in bytes, and a chat opens on its end', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  // Twelve turns, each carrying ~40KB of text: far more than one page.
  for (let t = 1; t <= 12; t++) {
    log.append('s', { type: 'turn.start', turnId: `t${t}`, text: `ask ${t}` });
    log.append('s', { type: 'item.start', id: `i${t}`, kind: 'text', turnId: `t${t}`, text: 'y'.repeat(40_000) });
    log.append('s', { type: 'turn.done', turnId: `t${t}`, status: 'ok' });
  }
  const page = log.window('s', { tail: 300 });
  assert.ok(JSON.stringify(page.events).length <= 200_000, 'the reply fits a page');
  assert.equal(page.events[page.events.length - 1].type, 'turn.done', 'it ends at the end');
  assert.equal(page.events[0].type, 'turn.start', 'and starts on a whole exchange');
  assert.equal(page.logFirst, 1, 'the machine says where its log starts');
  assert.ok(page.firstSeq > page.logFirst, 'so the app knows there is more behind');

  // Walking back from there reaches the beginning and says so.
  const back = log.window('s', { before: page.firstSeq });
  assert.ok(back.events.length, 'earlier events come back');
  assert.ok(back.events[back.events.length - 1].seq < page.firstSeq, 'and they are earlier');
  assert.equal(log.window('s', { before: back.firstSeq }).logFirst, 1);
});

test('completed provider echoes and withdrawn tickets are not active local prompts', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  log.append('s', { type: 'turn.start', turnId: 'local-1', text: 'hello', queued: false });
  assert.equal(log.activeTurn('s').turnId, 'local-1');
  log.append('s', { type: 'turn.start', turnId: 'real-1', text: 'hello' });
  assert.equal(log.activeTurn('s').turnId, 'real-1');
  log.append('s', { type: 'turn.done', turnId: 'real-1', status: 'ok' });
  assert.equal(log.activeTurn('s'), null);
  log.append('s', { type: 'turn.start', turnId: 'local-2', text: 'again', queued: false });
  log.append('s', { type: 'turn.remove', turnId: 'local-2' });
  assert.equal(log.activeTurn('s'), null);
});

test('a short conversation is served whole, from its first event', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  log.append('s', { type: 'turn.start', turnId: 't1', text: 'hi' });
  log.append('s', { type: 'item.start', id: 'i', kind: 'text', turnId: 't1', text: 'hello' });
  const w = log.window('s', { tail: 300 });
  assert.deepEqual(w.events.map((e) => e.seq), [1, 2]);
  assert.equal(w.firstSeq, w.logFirst, 'nothing is behind it');
  assert.equal(w.hasMore, false);
});

test('the digest reads the tail without hydrating what it will not look at', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  for (let i = 1; i <= 500; i++) log.append('s', { type: 'item.delta', id: 'x', text: String(i) });
  const tail = log.tail('s', 10);
  assert.equal(tail.length, 10);
  assert.equal(tail[tail.length - 1].text, '500');
  assert.equal(log.tail('s', 0).length, 500);
});

// The blank chat: the first cut of the tail window sliced the last 300
// events of a thread whose final turn was longer than that, so every event
// in the window was an item belonging to a turn that had been cut - and a
// reducer with no turn to hang them on drew an empty conversation.
test('a window that lands inside a long turn still carries that turn', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  log.append('s', { type: 'turn.start', turnId: 't1', text: 'the question' });
  for (let i = 0; i < 60; i++) {
    log.append('s', { type: 'item.start', id: `i${i}`, kind: 'edit', turnId: 't1',
      changes: [{ path: `f${i}.ts`, kind: 'update', diff: 'd'.repeat(20_000) }] });
  }
  const w = log.window('s', { tail: 10 });
  assert.equal(w.events[0].type, 'turn.start', 'the turn it is inside comes with it');
  assert.equal(w.events[0].text, 'the question');
  assert.ok(w.events.length > 1 && w.events.length < 62, 'and only part of the turn');
  assert.ok(JSON.stringify(w.events).length <= 200_000, 'still within a page');
});

test('a window that skips the middle of a turn still points at the hole', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  log.append('s', { type: 'turn.start', turnId: 't1', text: 'one long turn' });
  for (let i = 0; i < 60; i++) {
    log.append('s', { type: 'item.start', id: `i${i}`, kind: 'edit', turnId: 't1',
      changes: [{ path: `f${i}.ts`, kind: 'update', diff: 'd'.repeat(20_000) }] });
  }
  const w = log.window('s', { tail: 10 });
  assert.equal(w.events[0].type, 'turn.start');
  assert.ok(w.firstSeq > w.events[0].seq, 'the front is where the unbroken part starts');
  assert.ok(w.firstSeq > w.logFirst, 'so the app offers what is behind it');

  // And asking for that fills in from the middle, not from the top again.
  const back = log.window('s', { before: w.firstSeq });
  assert.ok(back.events[back.events.length - 1].seq < w.firstSeq);
  assert.ok(back.events.length > 1);
});

test('a cold history window keeps output with its host instead of a mid-turn queue ticket', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  log.append('s', { type: 'turn.start', turnId: 'host', text: 'original question' });
  log.append('s', { type: 'turn.start', turnId: 'local-steer', text: 'also check this', queued: true });
  log.append('s', { type: 'turn.deliver', turnId: 'local-steer' });
  log.append('s', { type: 'turn.accept', turnId: 'local-steer' });
  log.append('s', { type: 'item.start', id: 'reply', kind: 'text', turnId: 'host' });
  for (let i = 0; i < 40; i++) log.append('s', {
    type: 'item.start', id: `edit${i}`, kind: 'edit', turnId: 'host',
    changes: [{ path: `f${i}.ts`, kind: 'update', diff: 'd'.repeat(20_000) }],
  });
  log.append('s', { type: 'item.delta', id: 'reply', text: 'The current answer' });
  log.append('s', { type: 'item.done', id: 'reply', status: 'ok' });
  const window = log.window('s', { tail: 5 });
  const state = emptyLog();
  for (const event of window.events) apply(state, event);
  const host = state.turns.find(t => t.id === 'host');
  assert.equal(host?.queued, false);
  assert.equal(host?.items.find(i => i.id === 'reply')?.text, 'The current answer');
  assert.equal(state.turns.find(t => t.id === 'local-steer')?.queued, false, 'the accepted message is not resurrected in the outbox');
  assert.ok(window.firstSeq > window.events[0].seq, 'paging still points at the omitted middle');
  assert.ok(JSON.stringify(window.events).length < 200_000);
});

test('a window starting with a queued ticket also carries its still-running host', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  log.append('s', { type: 'turn.start', turnId: 'host', text: 'original question' });
  log.append('s', { type: 'turn.start', turnId: 'local-next', text: 'next message', queued: true });
  log.append('s', { type: 'item.start', id: 'reply', kind: 'text', turnId: 'host' });
  log.append('s', { type: 'item.delta', id: 'reply', text: 'Still working on the original' });
  const state = emptyLog();
  for (const event of log.window('s', { tail: 3 }).events) apply(state, event);
  assert.equal(state.turns.find(t => t.id === 'local-next')?.queued, true);
  assert.equal(state.turns.find(t => t.id === 'host')?.items[0].text, 'Still working on the original');
});

test('retention preserves the real owner and item of a turn longer than 2000 events, including restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-retain-'));
  const log = new EventLog(dir);
  log.append('s', { type: 'turn.start', turnId: 'host', text: 'long original task' });
  log.append('s', { type: 'item.start', id: 'reply', turnId: 'host', kind: 'text' });
  for (let i = 0; i < 2100; i++) log.append('s', { type: 'item.delta', id: 'reply', text: 'x' });
  log.append('s', { type: 'turn.start', turnId: 'local-next', text: 'also check this', queued: true });
  log.append('s', { type: 'turn.deliver', turnId: 'local-next' });
  log.append('s', { type: 'turn.accept', turnId: 'local-next' });
  log.append('s', { type: 'item.delta', id: 'reply', text: ' latest answer' });
  for (const instance of [log, new EventLog(dir), new EventLog(dir)]) {
    const window = instance.window('s', { tail: 200 }), state = emptyLog();
    for (const event of window.events) apply(state, event);
    const host = state.turns.find(t => t.id === 'host');
    assert.equal(host?.text, 'long original task');
    assert.ok(host?.items.find(i => i.id === 'reply')?.text.endsWith(' latest answer'));
    assert.equal(state.turns.find(t => t.id === 'local-next')?.queued, false);
    assert.equal(window.logFirst, instance.last('s') - 1999);
    assert.ok(window.firstSeq >= window.logFirst);
    assert.ok(window.events[0].seq < window.logFirst, 'sparse anchors remain separate from retained history');
    assert.deepEqual(instance.window('s', { before: window.logFirst }).events, []);
  }
});

test('disk compaction retains compact item anchors without carrying old tool payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-compact-'));
  const rows = [
    { seq: 1, type: 'turn.start', turnId: 'host', text: 'check files' },
    { seq: 2, type: 'item.start', id: 'edit', turnId: 'host', kind: 'edit', changes: [{ diff: 'z'.repeat(500_000) }] },
    ...Array.from({ length: 2100 }, (_, i) => ({ seq: i + 3, type: 'item.update', id: 'edit', status: 'streaming' })),
  ];
  writeFileSync(join(dir, 's.jsonl'), rows.map(e => JSON.stringify(e)).join('\n') + '\n');
  const log = new EventLog(dir), kept = log.since('s');
  assert.equal(kept.length, 2002);
  assert.equal(kept.find(e => e.type === 'item.start')?.changes, undefined);
  assert.ok(readFileSync(join(dir, 's.jsonl'), 'utf8').length < 200_000);
  const reopened = new EventLog(dir), window = reopened.window('s', { tail: 10 }), state = emptyLog();
  for (const event of window.events) apply(state, event);
  assert.equal(state.turns[0].items[0].id, 'edit');
  assert.equal(window.logFirst, 103);
});

test('old owner anchors disappear when no retained event needs them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-bound-')), log = new EventLog(dir);
  for (let turn = 0; turn < 3; turn++) {
    log.append('s', { type: 'turn.start', turnId: `t${turn}`, text: 'task' });
    log.append('s', { type: 'item.start', id: `reply${turn}`, turnId: `t${turn}`, kind: 'text' });
    for (let i = 0; i < 2100; i++) log.append('s', { type: 'item.delta', id: `reply${turn}`, text: 'x' });
    log.append('s', { type: 'turn.done', turnId: `t${turn}`, status: 'ok' });
  }
  const events = log.since('s');
  assert.equal(events.length, 2002);
  assert.deepEqual(events.filter(e => e.type === 'turn.start').map(e => e.turnId), ['t2']);
  assert.equal(new EventLog(dir).since('s').length, 2002);
});
