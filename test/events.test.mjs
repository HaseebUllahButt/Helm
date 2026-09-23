import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLog } from '../packages/connect/src/events.js';

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
