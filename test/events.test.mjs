import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLog, activeTurnFromEvents } from '../packages/connect/src/events.js';
import { EventFile } from '../packages/connect/src/event-file.js';
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

test('older pages read their payloads and selected owners instead of every old tool payload', t => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-offsets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = [];
  const emit = event => events.push({ seq: events.length + 1, at: 0, ...event });
  for (let turn = 0; turn < 80; turn++) {
    const turnId = 't' + turn, id = 'tool' + turn;
    emit({ type: 'turn.start', turnId, text: 'Check ' + turn });
    emit({ type: 'item.start', turnId, id, kind: 'tool', input: { text: 'x'.repeat(100_000) } });
    for (let n = 0; n < 50; n++) emit({ type: 'item.delta', id, text: '日本語 😀 ' + n });
    emit({ type: 'item.done', id, status: 'ok' });
    emit({ type: 'turn.done', turnId, status: 'ok' });
  }
  writeFileSync(join(dir, 's.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const log = new EventLog(dir);
  log.window('s', { tail: 20 });
  let bytesRead = 0;
  let indexedRecords = 0;
  const read = EventFile.prototype.read;
  const record = EventFile.prototype.record;
  t.mock.method(EventFile.prototype, 'record', function(...args) {
    indexedRecords++;
    return record.apply(this, args);
  });
  t.mock.method(EventFile.prototype, 'read', function(start, end) {
    bytesRead += end - start;
    return read.call(this, start, end);
  });
  let page = log.window('s', { before: 1500, tail: 20 });
  assert.ok(page.events.length);
  assert.ok(bytesRead < 500_000, `${bytesRead} bytes read for one older page`);
  const seen = new Set();
  for (let n = 0; n < 100 && page.firstSeq > page.logFirst; n++) {
    const before = page.firstSeq;
    for (const event of page.events) seen.add(event.seq);
    page = log.window('s', { before });
    assert.ok(page.firstSeq < before, 'each page moves backwards');
  }
  for (const event of page.events) seen.add(event.seq);
  assert.equal(seen.size, 1499, 'all earlier events remain available');
  const forward = log.window('s', { since: 100 });
  assert.equal(forward.events[0].seq, 101);
  assert.ok(forward.hasMore);
  assert.equal(indexedRecords, 0, 'history pages never rebuild the existing index');
  log.append('s', { type: 'turn.start', turnId: 'appended', text: 'One new event' });
  log.window('s', { before: 1500, tail: 20 });
  assert.equal(indexedRecords, 1, 'a known append indexes only its new record');
  log.replace('s', [{ seq: 7000, type: 'turn.start', turnId: 'new', text: 'Replacement' }]);
  assert.equal(log.window('s', { before: 7001 }).events[0].text, 'Replacement');
  log.restart('s');
  log.append('s', { type: 'turn.start', turnId: 'again', text: 'After restart' });
  assert.equal(log.window('s', { before: 8000 }).events[0].text, 'After restart');
});

test('extending an old page to its turn start stops when the wire budget fails', t => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-long-page-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events = [
    { seq: 1, type: 'turn.start', turnId: 't', text: 'One long task' },
    { seq: 2, type: 'item.start', turnId: 't', id: 'reply', kind: 'text' },
    ...Array.from({ length: 2400 }, (_, n) => ({ seq: n + 3, type: 'item.delta', id: 'reply', text: 'x'.repeat(8000) })),
  ];
  writeFileSync(join(dir, 's.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const log = new EventLog(dir);
  log.window('s', { tail: 20 });
  let bytesRead = 0;
  const read = EventFile.prototype.read;
  t.mock.method(EventFile.prototype, 'read', function(start, end) {
    bytesRead += end - start;
    return read.call(this, start, end);
  });
  const page = log.window('s', { before: 2300, tail: 5 });
  assert.equal(page.events[0].text, 'One long task');
  assert.ok(page.firstSeq > 2200, 'the sparse turn start never fills the omitted middle');
  assert.ok(bytesRead < 250_000, `${bytesRead} bytes read across a 19 MB turn`);
});

test('history positions are rebuilt after log eviction', t => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-evicted-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = new EventLog(dir);
  log.append('first', { type: 'turn.start', turnId: 'old', text: 'Old' });
  new EventLog(dir).window('first', { before: 2 });
  log.window('first', { before: 2 });
  for (let n = 0; n < 25; n++) log.append('chat' + n, { type: 'turn.start', turnId: 't' + n });
  log.replace('first', [{ seq: 80, type: 'turn.start', turnId: 'new', text: 'New' }]);
  assert.equal(log.window('first', { before: 81 }).events[0].text, 'New');
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

test('image corrections survive retention and are hydrated in cold history windows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-image-retention-'));
  const log = new EventLog(dir);
  const data = 'aGVsbG8=';
  log.append('chat', { type: 'turn.start', turnId: 'imported-image', text: 'Old envelope', imported: true });
  log.append('chat', { type: 'item.start', id: 'reply', turnId: 'imported-image', kind: 'text' });
  log.append('chat', { type: 'turn.done', turnId: 'imported-image', status: 'ok' });
  log.append('chat', { type: 'turn.images', turnId: 'imported-image', text: 'Caption',
    attachments: [log.putAttachment('chat', { filename: 'saved.png', mime: 'image/png', data })],
  });
  for (let n = 0; n < 2300; n++) log.append('chat', { type: 'item.delta', id: 'reply', text: 'x' });
  const reopened = new EventLog(dir);
  const state = emptyLog();
  for (const event of reopened.window('chat', { tail: 20 }).events) apply(state, event);
  const turn = state.turns.find(t => t.id === 'imported-image');
  assert.equal(turn.text, 'Caption');
  assert.equal(turn.attachments[0].data, data);
  assert.equal(turn.done.status, 'ok');
});

test('pending permissions are derived from the log', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  log.append('s', { type: 'permission.request', requestId: 'r1', kind: 'command' });
  log.append('s', { type: 'permission.request', requestId: 'r2', kind: 'edit' });
  log.append('s', { type: 'permission.resolved', requestId: 'r1', decision: 'allow' });
  assert.deepEqual(log.pending('s').map((e) => e.requestId), ['r2']);
});

test('unanswered permissions survive long turns, eviction and a restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-permission-retention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const live = new EventLog(dir);
  const request = live.append('s', { type: 'permission.request', requestId: 'waiting', itemId: 'tool',
    kind: 'command', title: 'Run a command', options: [{ id: 'allow' }],
    codex: { id: 42, method: 'item/commandExecution/requestApproval' } });
  live.append('s', { type: 'permission.request', requestId: 'answered' });
  live.append('s', { type: 'permission.resolved', requestId: 'answered', decision: 'allow' });
  for (let i = 0; i < 2400; i++) live.append('s', { type: 'item.delta', id: 'other', text: 'x' });
  assert.deepEqual(live.pending('s'), [request]);
  assert.deepEqual(live.since('s').filter(e => e.type === 'permission.request'), [request]);
  for (let i = 0; i < 25; i++) live.append(`other-${i}`, { type: 'turn.start' });
  for (const reader of [live, new EventLog(dir)]) {
    assert.deepEqual(reader.glance('s').pending, [request]);
    assert.deepEqual(reader.since('s').filter(e => e.type === 'permission.request'), [request]);
    assert.deepEqual(reader.pending('s'), [request]);
  }
  live.append('s', { type: 'permission.resolved', requestId: 'waiting', decision: 'allow' });
  for (let i = 0; i < 2400; i++) live.append('s', { type: 'item.delta', id: 'other', text: 'x' });
  const cold = new EventLog(dir);
  assert.deepEqual(cold.pending('s'), []);
  assert.deepEqual(cold.since('s').filter(e => e.type.startsWith('permission.')), []);
});

test('the open turn is the last turn.start without a turn.done', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  assert.equal(log.openTurn('s'), null);
  log.append('s', { type: 'turn.start', turnId: 't1', text: 'a' });
  assert.equal(log.openTurn('s').turnId, 't1');
  log.append('s', { type: 'turn.done', turnId: 't1', status: 'ok' });
  assert.equal(log.openTurn('s'), null);
});

test('memory keeps the tail, the file keeps everything and pages back to the start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-'));
  const lines = [];
  for (let i = 1; i <= 2500; i++) lines.push(JSON.stringify({ seq: i, at: 0, type: 'item.delta', id: 'x', text: String(i) }));
  writeFileSync(join(dir, 'big.jsonl'), lines.join('\n') + '\n');
  const log = new EventLog(dir);
  const all = log.since('big', 0);
  assert.equal(all.length, 2000);
  assert.equal(all[0].seq, 501);
  assert.equal(log.append('big', { type: 'turn.done' }).seq, 2501);
  assert.equal(readFileSync(join(dir, 'big.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2501);
  let page = log.window('big', { tail: 200 });
  assert.equal(page.logFirst, 1, 'the app is told there is history behind the tail');
  const seen = new Set(page.events.map(e => e.seq));
  for (let pages = 0; page.firstSeq > 1 && pages < 100; pages++) {
    page = log.window('big', { before: page.firstSeq });
    for (const e of page.events) seen.add(e.seq);
  }
  assert.equal(seen.size, 2501, 'every event, read back from the file');
  // A device that last saw seq 10 catches up from the file, with no hole.
  const forward = log.window('big', { since: 10 });
  assert.equal(forward.events[0].seq, 11);
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

test('unfinished local commands and named queued tickets never revive completed provider work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-local-command-recovery-'));
  const log = new EventLog(dir);
  log.append('s', { type: 'turn.start', turnId: 'command-old-status', text: '/status', local: true });
  log.append('s', { type: 'turn.start', turnId: 'real-done', text: 'Work' });
  log.append('s', { type: 'turn.done', turnId: 'real-done', status: 'ok' });
  log.append('s', { type: 'turn.start', turnId: 'named-queued-ticket', text: 'Next task', queued: true });
  assert.equal(log.activeTurn('s'), null);
  assert.equal(new EventLog(dir).activeTurn('s'), null, 'a cold read must not revive either record');
  log.append('s', { type: 'turn.start', turnId: 'real-live', text: 'Still working' });
  log.append('s', { type: 'turn.start', turnId: 'command-new-status', text: '/status', local: true });
  assert.equal(log.activeTurn('s').turnId, 'real-live', 'local cards cannot displace real work');
});

test('a provider turn that a later turn superseded is not still running', () => {
  // Claude echoes each message handed over mid-run as a turn of its own and
  // closes only the last one. Once that closes, nothing is running.
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-superseded-')));
  log.append('s', { type: 'turn.start', turnId: 'local-a', text: 'Prefixed by returned context' });
  log.append('s', { type: 'turn.start', turnId: 'echo-a', text: 'Returned context, then the request' });
  log.append('s', { type: 'turn.start', turnId: 'echo-b', text: 'Also check the docs' });
  assert.equal(log.activeTurn('s').turnId, 'echo-b');
  log.append('s', { type: 'turn.done', turnId: 'echo-b', status: 'ok' });
  assert.equal(log.activeTurn('s'), null, 'neither the older echo nor its unmatched ticket is live');
  log.append('s', { type: 'turn.start', turnId: 'local-next', text: 'Next', queued: false });
  assert.equal(log.activeTurn('s').turnId, 'local-next', 'a newer unechoed send is still the live one');
});

test('a legacy optimistic status ticket is retired by its local command echo', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-legacy-status-')));
  log.append('s', { type: 'turn.start', turnId: 'local-ticket', text: '/status' });
  log.append('s', { type: 'turn.start', turnId: 'command-status', text: '/status', local: true });
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
  // Far enough past KEEP that the live log has been trimmed once too.
  for (let i = 0; i < 2300; i++) log.append('s', { type: 'item.delta', id: 'reply', text: 'x' });
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
    assert.equal(window.logFirst, 1, 'the whole history is still there to page back to');
    assert.ok(window.firstSeq > window.events[0].seq, 'sparse anchors remain separate from the unbroken window');
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
  assert.ok(readFileSync(join(dir, 's.jsonl'), 'utf8').length > 500_000, 'the file is left whole');
  const reopened = new EventLog(dir), window = reopened.window('s', { tail: 10 }), state = emptyLog();
  for (const event of window.events) apply(state, event);
  assert.equal(state.turns[0].items[0].id, 'edit');
  assert.equal(window.logFirst, 1);
  assert.ok(JSON.stringify(window).length < 200_000, 'the old payload is not sent with the tail');
});

test('a visual and its page survive a long chat being trimmed, including restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-visual-')), log = new EventLog(dir);
  const ref = log.putAttachment('s', { filename: 'v.html', mime: 'text/html', data: Buffer.from('<p>hi</p>').toString('base64') }).ref;
  log.append('s', { type: 'turn.start', turnId: 't0', text: 'draw it' });
  log.append('s', { type: 'item.start', id: 'visual-1', turnId: 't0', kind: 'visual', visual: { ref, title: 'Picture', height: 400, bytes: 9 } });
  log.append('s', { type: 'item.done', id: 'visual-1', turnId: 't0', status: 'ok' });
  log.append('s', { type: 'turn.done', turnId: 't0', status: 'ok' });
  for (let turn = 1; turn < 3; turn++) {
    log.append('s', { type: 'turn.start', turnId: `t${turn}`, text: 'more' });
    log.append('s', { type: 'item.start', id: `reply${turn}`, turnId: `t${turn}`, kind: 'text' });
    for (let i = 0; i < 2100; i++) log.append('s', { type: 'item.delta', id: `reply${turn}`, text: 'x' });
    log.append('s', { type: 'turn.done', turnId: `t${turn}`, status: 'ok' });
  }
  for (const reader of [log, new EventLog(dir)]) {
    const events = reader.since('s');
    assert.equal(events.find(e => e.id === 'visual-1' && e.type === 'item.start')?.visual?.ref, ref);
    assert.ok(events.some(e => e.id === 'visual-1' && e.type === 'item.done'));
    assert.ok(events.some(e => e.type === 'turn.start' && e.turnId === 't0'));
    assert.equal(Buffer.from(reader.attachment('s', ref), 'base64').toString(), '<p>hi</p>');
  }
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
  assert.ok(events.length >= 2002 && events.length <= 2202, 'trimmed in batches of 200');
  assert.deepEqual(events.filter(e => e.type === 'turn.start').map(e => e.turnId), ['t2']);
  assert.equal(new EventLog(dir).since('s').length, 2002);
});

test('the live turn is read from disk once per change and shares the cache with other derived values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-active-'));
  try {
    const writer = new EventLog(dir);
    writer.append('a1', { type: 'turn.start', turnId: 't1', text: 'go' });
    const reader = new EventLog(dir);
    assert.equal(reader.activeTurn('a1')?.turnId, 't1');
    assert.equal(reader.derive('a1', (events) => events.length), 1, 'a second value for the same thread is kept apart');
    assert.equal(reader.activeTurn('a1')?.turnId, 't1');
    writer.append('a1', { type: 'turn.done', turnId: 't1', status: 'ok' });
    assert.equal(reader.activeTurn('a1'), null, 'a turn finished on disk is seen');
    reader.append('a1', { type: 'turn.start', turnId: 't2', text: 'again' });
    assert.equal(reader.activeTurn('a1')?.turnId, 't2', 'a turn started in this log is seen');
    reader.append('a1', { type: 'turn.done', turnId: 't2', status: 'ok' });
    assert.equal(reader.activeTurn('a1'), null);
    assert.equal(reader.activeTurn('none'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cold active-turn checks agree with the full log through ticket and local-card transitions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-active-cold-'));
  try {
    const reader = new EventLog(dir), events = [];
    const steps = [
      { type: 'turn.start', turnId: 'local-send', text: 'go' },
      { type: 'item.delta', id: 'output', text: '"type":"turn.done"', nested: { type: 'turn.done', turnId: 'local-send' } },
      { type: 'turn.start', turnId: 'real', text: 'go', inputId: 'local-send' },
      { type: 'turn.start', turnId: 'local-card', local: true, text: '/status' },
      { type: 'turn.start', turnId: 'queued', queued: true, text: 'next' },
      { type: 'turn.edit', turnId: 'queued', text: 'edited' },
      { type: 'turn.done', turnId: 'real', status: 'ok' },
      { type: 'turn.accept', turnId: 'queued' },
      { type: 'turn.start', turnId: 'next', text: 'edited' },
      { type: 'turn.remove', turnId: 'next' },
    ];
    for (const step of steps) {
      events.push({ seq: events.length + 1, ...step });
      writeFileSync(join(dir, 's.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n{"type":');
      assert.deepEqual(reader.activeTurn('s'), activeTurnFromEvents(events));
      assert.deepEqual(reader.activeTurn('s'), activeTurnFromEvents(events), 'cached result agrees too');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('opening a long log never rewrites it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-trimmed-'));
  try {
    const log = new EventLog(dir);
    log.append('s', { type: 'turn.start', turnId: 't1', text: 'long task' });
    log.append('s', { type: 'item.start', id: 'reply', turnId: 't1', kind: 'text' });
    for (let i = 0; i < 2100; i++) log.append('s', { type: 'item.delta', id: 'reply', text: 'x' });
    new EventLog(dir).since('s');
    const file = join(dir, 's.jsonl');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    assert.equal(lines, 2102, 'the file keeps everything');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(file, old, old);
    assert.equal(new EventLog(dir).since('s').length, 2002, 'memory keeps the tail and the turn and item it belongs to');
    assert.equal(statSync(file).mtimeMs, old.getTime(), 'nothing was dropped, so nothing was written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a glance at a cold log gives a restart what opening it would', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-glance-'));
  try {
    const log = new EventLog(dir);
    log.append('s', { type: 'turn.start', turnId: 'local-q', text: 'later please', queued: true });
    log.append('s', { type: 'turn.start', turnId: 't1', text: 'long task' });
    log.append('s', { type: 'item.start', id: 'reply', turnId: 't1', kind: 'text' });
    log.append('s', { type: 'permission.request', requestId: 'old', kind: 'command', title: 'answered' });
    log.append('s', { type: 'permission.resolved', requestId: 'old', decision: 'allow' });
    for (let i = 0; i < 2100; i++) log.append('s', { type: 'item.delta', id: 'reply', turnId: 't1', text: 'x' });
    log.append('s', { type: 'permission.request', requestId: 'open', kind: 'command', title: 'waiting' });
    // Grown past KEEP and not yet trimmed, as a busy thread's log is at restart.
    const glanced = new EventLog(dir).glance('s');
    const opened = new EventLog(dir);
    const plain = (events) => JSON.parse(JSON.stringify(events));
    assert.deepEqual(plain(glanced.turns), plain(opened.tail('s', 0).filter((e) => e.type.startsWith('turn.'))));
    assert.equal(glanced.seq, opened.last('s'));
    assert.deepEqual(glanced.pending.map((p) => p.requestId), ['open']);
    assert.deepEqual(opened.pending('s').map((p) => p.requestId), ['open']);
    // Now trimmed by that open, and read cold again.
    const cold = new EventLog(dir);
    assert.deepEqual(cold.pending('s').map((p) => p.requestId), ['open']);
    assert.equal(cold.last('s'), opened.last('s'));
    assert.deepEqual(cold.glance('s').turns.map((e) => e.turnId), ['local-q', 't1']);
    assert.equal(cold.since('s').length, opened.since('s').length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a live log trimmed in batches shows what a fresh read of it shows, plus at most 200 older events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-batch-'));
  try {
    const log = new EventLog(dir);
    for (let i = 0; i < 5000; i++) {
      if (i % 300 === 0) log.append('s', { type: 'turn.start', turnId: `t${i}`, text: 'go' });
      log.append('s', { type: 'item.delta', id: `r${i - i % 300}`, turnId: `t${i - i % 300}`, text: String(i) });
    }
    const live = log.since('s'), cold = new EventLog(dir).since('s');
    const plain = (events) => JSON.parse(JSON.stringify(events));
    assert.deepEqual(plain(live.slice(-2000)), plain(cold.slice(-2000)), 'the newest 2000 are the same');
    const seen = new Set(live.map(e => e.seq));
    assert.ok(cold.every(e => seen.has(e.seq)), 'nothing a fresh read keeps is missing');
    assert.ok(live.length > cold.length && live.length <= cold.length + 200, `${live.length} against ${cold.length}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a log trimmed by an older Helm pages back only to where its history is unbroken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-events-gap-'));
  try {
    const rows = [
      { seq: 3, type: 'turn.start', turnId: 'old', text: 'kept as an anchor' },
      { seq: 7, type: 'item.start', id: 'r', turnId: 'old', kind: 'text' },
      ...Array.from({ length: 100 }, (_, i) => ({ seq: 500 + i, type: 'item.delta', id: 'r', text: String(i) })),
    ];
    writeFileSync(join(dir, 's.jsonl'), rows.map(e => JSON.stringify(e)).join('\n') + '\n');
    const log = new EventLog(dir);
    assert.equal(log.window('s', { tail: 10 }).logFirst, 500);
    assert.deepEqual(log.window('s', { before: 500 }).events, []);
    log.append('s', { type: 'item.delta', id: 'r', text: 'more' });
    assert.equal(new EventLog(dir).window('s', { tail: 10 }).logFirst, 500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a changed step moves its own revision and every card it sits in, so drawn steps can skip', () => {
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { seq: ++seq, at: seq, ...e });
  ev({ type: 'turn.start', turnId: 't', text: 'go' });
  ev({ type: 'item.start', turnId: 't', id: 'helper', kind: 'subagent' });
  ev({ type: 'item.start', turnId: 't', id: 'step', kind: 'tool', parentId: 'helper' });
  ev({ type: 'item.start', turnId: 't', id: 'said', kind: 'text' });
  const [helper, step, said] = log.turns[0].items;
  assert.equal(helper.revision, 3, 'a new step inside a card moves the card');
  const before = { said: said.revision };
  ev({ type: 'item.done', id: 'step', status: 'ok' });
  assert.equal(step.revision, 5);
  assert.equal(helper.revision, 5, 'a finished step inside a card moves the card');
  assert.equal(said.revision, before.said, 'a step that did not change keeps its revision');
  ev({ type: 'item.delta', id: 'said', text: 'hi' });
  assert.equal(said.revision, 6);
  assert.equal(helper.revision, 5, 'text growing elsewhere leaves the card alone');
  ev({ type: 'turn.done', turnId: 't', status: 'ok' });
  assert.equal(said.revision, 7, 'ending the turn closes the streaming text and moves it');
});


test('a fast review stays with its message when Codex echoes the turn after its items', () => {
  const state = emptyLog();
  let seq = 0;
  const ev = e => apply(state, { at: ++seq, seq, ...e });
  ev({ type: 'turn.start', turnId: 'local-send', text: 'Check the project' });
  ev({ type: 'item.start', id: 'review', turnId: 'codex-turn', kind: 'tool', name: 'codexReview', input: { action: 'Read app.ts', reviewStatus: 'approved' } });
  ev({ type: 'item.done', id: 'review', status: 'ok' });
  ev({ type: 'turn.start', turnId: 'codex-turn', inputId: 'local-send', text: 'Check the project' });
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0].id, 'codex-turn');
  assert.equal(state.turns[0].items[0].id, 'review');
  ev({ type: 'turn.start', turnId: 'other-turn', text: 'Check the project' });
  assert.equal(state.turns.length, 2, 'a different turn cannot claim these review items');
});
