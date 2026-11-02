import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLog, compactEvents } from '../packages/connect/src/events.js';
import { apply, emptyLog } from '../apps/web/src/session/types.ts';

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-history-compaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const rows = (dir, id) => readFileSync(join(dir, `${id}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const reply = (events) => {
  const state = emptyLog();
  for (const event of events) apply(state, event);
  return state.turns.flatMap(turn => turn.items).filter(item => item.kind === 'text').map(item => item.text);
};

/** A finished reply streamed in pieces, a thought between them, and a reply still streaming. */
function chat(log) {
  log.append('c', { type: 'turn.start', turnId: 't1', text: 'hello' });
  log.append('c', { type: 'item.start', id: 'a', turnId: 't1', kind: 'text' });
  log.append('c', { type: 'item.start', id: 'b', turnId: 't1', kind: 'thinking' });
  for (const piece of ['Hel', 'lo ', 'there']) {
    log.append('c', { type: 'item.delta', id: 'a', text: piece });
    log.append('c', { type: 'item.delta', id: 'b', text: '.' });
  }
  log.append('c', { type: 'item.done', id: 'a' });
  log.append('c', { type: 'item.done', id: 'b' });
  log.append('c', { type: 'turn.done', turnId: 't1', status: 'ok' });
  log.append('c', { type: 'turn.start', turnId: 't2', text: 'more' });
  log.append('c', { type: 'item.start', id: 'z', turnId: 't2', kind: 'text' });
  log.append('c', { type: 'item.delta', id: 'z', text: 'still ' });
  log.append('c', { type: 'item.delta', id: 'z', text: 'going' });
}

test('compaction joins the pieces of finished items and leaves the rest as it was', () => {
  const events = [
    { seq: 1, type: 'item.start', id: 'a' },
    { seq: 2, type: 'item.delta', id: 'a', text: 'x', turnId: 't' },
    { seq: 3, type: 'status', status: 'working' },
    { seq: 4, type: 'item.delta', id: 'a', text: 'y', turnId: 't' },
    { seq: 5, type: 'item.done', id: 'a' },
    { seq: 6, type: 'item.start', id: 'open' },
    { seq: 7, type: 'item.delta', id: 'open', text: 'p' },
    { seq: 8, type: 'item.delta', id: 'open', text: 'q' },
  ];
  const { events: kept, removed } = compactEvents(events);
  assert.equal(removed, 1);
  assert.deepEqual(kept.map(e => e.seq), [1, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(kept[2], { seq: 4, from: 2, at: undefined, type: 'item.delta', id: 'a', turnId: 't', replace: true, text: 'xy' });
  // Its number and `from` lead the line, where the file index reads them.
  assert.match(JSON.stringify(kept[2]), /^\{"seq":4,"from":2,/);
  assert.equal(compactEvents(kept).removed, 0);
});

test('a compacted chat reads the same, from a fresh device and from a half-saved one', t => {
  const dir = temp(t);
  const log = new EventLog(dir);
  chat(log);
  const before = log.since('c', 0);
  // A phone saved the chat while "Hello there" was half written.
  const half = before.filter(e => e.seq <= 5);
  assert.equal(log.compact('c', { minRemoved: 1 }), 4);

  for (const reader of [log, new EventLog(dir)]) {
    const window = reader.window('c', { tail: 100 });
    assert.deepEqual(reply(window.events), ['Hello there', 'still going']);
    // The gaps the joined rows left do not hide the start of the chat.
    assert.equal(window.firstSeq, 1);
    // The half-saved phone catches up from where it stopped: no text twice.
    const later = reader.window('c', { since: half.at(-1).seq }).events;
    assert.deepEqual(reply([...half, ...later]), ['Hello there', 'still going']);
  }
  // The pieces of the reply still streaming were not touched.
  assert.equal(rows(dir, 'c').filter(e => e.id === 'z' && e.type === 'item.delta').length, 2);
  // New rows still follow on.
  log.append('c', { type: 'item.delta', id: 'z', text: '!' });
  assert.deepEqual(reply(new EventLog(dir).window('c', { tail: 100 }).events), ['Hello there', 'still going!']);
});

test('the background pass leaves chats someone wrote to recently', async t => {
  const dir = temp(t);
  const log = new EventLog(dir);
  chat(log);
  log.append('quiet', { type: 'turn.start', turnId: 'q1', text: 'hi' });
  log.append('quiet', { type: 'item.start', id: 'q', turnId: 'q1', kind: 'text' });
  for (let n = 0; n < 60; n++) log.append('quiet', { type: 'item.delta', id: 'q', text: 'x' });
  log.append('quiet', { type: 'item.done', id: 'q' });
  const old = (Date.now() - 3_600_000) / 1000;
  utimesSync(join(dir, 'quiet.jsonl'), old, old);
  const busy = statSync(join(dir, 'c.jsonl')).size;
  assert.deepEqual(await log.compactAll(), { removed: 59, chats: 1 });
  assert.equal(statSync(join(dir, 'c.jsonl')).size, busy);
  assert.deepEqual(reply(log.window('quiet', { tail: 10 }).events), ['x'.repeat(60)]);
});

test('streamed pieces are joined before they are saved, and nothing passes them', async t => {
  const dir = temp(t);
  const log = new EventLog(dir);
  const sent = [];
  log.append('s', { type: 'item.start', id: 'a', kind: 'text' });
  for (const piece of ['one ', 'two ', 'three']) log.appendDelta('s', { type: 'item.delta', id: 'a', text: piece }, e => sent.push(e));
  // A piece of another item saves the waiting one first.
  log.appendDelta('s', { type: 'item.delta', id: 'b', text: 'other' }, e => sent.push(e));
  // So does any other row.
  log.append('s', { type: 'item.done', id: 'a' });
  assert.deepEqual(sent.map(e => [e.seq, e.id, e.text]), [[2, 'a', 'one two three'], [3, 'b', 'other']]);
  assert.deepEqual(rows(dir, 's').map(e => e.type), ['item.start', 'item.delta', 'item.delta', 'item.done']);
  // Alone, a piece is saved after a short wait.
  log.appendDelta('s', { type: 'item.delta', id: 'c', text: 'late' }, e => sent.push(e));
  while (sent.length < 3) await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.at(-1).text, 'late');
  // A reader never misses text that is waiting.
  log.appendDelta('s', { type: 'item.delta', id: 'c', text: '!' }, e => sent.push(e));
  assert.equal(log.since('s', 0).at(-1).text, '!');
});
