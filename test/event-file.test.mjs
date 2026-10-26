import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventFile } from '../packages/connect/src/event-file.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-event-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'chat.jsonl');
}
const line = event => JSON.stringify(event) + '\n';

test('permission requests and answers remain available as old context', t => {
  const file = fixture(t);
  const rows = [
    { seq: 1, type: 'permission.request', requestId: 'ask' },
    { seq: 2, type: 'item.delta', id: 'text', text: 'more work' },
    { seq: 3, type: 'permission.resolved', requestId: 'ask', decision: 'allow' },
  ];
  writeFileSync(file, rows.map(line).join(''));
  assert.deepEqual([...new EventFile(file).refresh().view().contextBefore(rows.length)], [rows[0], rows[2]]);
});

test('byte positions preserve Unicode, legacy property order, corrupt lines and final records without newlines', t => {
  const file = fixture(t);
  const records = [
    { text: 'اردو 😀 '.repeat(15000), type: 'turn.start', turnId: 't', seq: 5 },
    { seq: 6, nested: { type: 'turn.start' }, type: 'item.delta', text: '日本語' },
    { seq: 7, type: 'turn.done', turnId: 't' },
  ];
  writeFileSync(file, '\n' + line(records[0]) + '{bad json}\n' + line(records[1]) + JSON.stringify(records[2]));
  const indexed = new EventFile(file).refresh();
  assert.deepEqual([...indexed.view()], records);
  assert.equal(indexed.first, 5);
  assert.deepEqual([...indexed.view({ since: 5, before: 7 })], [records[1]]);
  assert.deepEqual([...indexed.view().contextBefore(3)], [records[0], records[2]]);
  assert.equal(indexed.view({ before: 7 }).at(2), null, 'the view never crosses its boundary');
  appendFileSync(file, '\n' + line({ seq: 8, type: 'turn.start' }));
  assert.deepEqual([...indexed.refresh().view()].map(e => e.seq), [5, 6, 7, 8]);
});

test('unexpected growth, truncation, atomic replacement and deletion invalidate old byte positions', t => {
  const file = fixture(t), indexed = new EventFile(file);
  writeFileSync(file, line({ seq: 1, type: 'item.delta', text: 'old' }));
  indexed.refresh();
  writeFileSync(file, line({ seq: 100, type: 'turn.start', text: 'larger replacement' }) + line({ seq: 101, type: 'turn.done' }));
  assert.deepEqual([...indexed.refresh().view()].map(e => e.seq), [100, 101]);
  writeFileSync(file, line({ seq: 9, type: 'turn.start' }));
  assert.equal(indexed.refresh().view().at(0).seq, 9);
  writeFileSync(file + '.new', line({ seq: 20, type: 'turn.start' }));
  renameSync(file + '.new', file);
  assert.equal(indexed.refresh().view().at(0).seq, 20);
  rmSync(file);
  assert.equal(indexed.refresh().view().length, 0);
});

test('a torn final record becomes visible once its later bytes arrive', t => {
  const file = fixture(t), indexed = new EventFile(file);
  writeFileSync(file, line({ seq: 1, type: 'turn.start' }) + '{"seq":2,"type":"item.delta","text":"');
  assert.equal(indexed.refresh().view().length, 1);
  appendFileSync(file, 'done"}\n');
  assert.deepEqual([...indexed.refresh().view()].map(e => e.seq), [1, 2]);
});

test('known appends extend positions without rescanning old payloads', t => {
  const file = fixture(t), indexed = new EventFile(file);
  const first = { seq: 1, type: 'turn.start', turnId: 't' };
  writeFileSync(file, line(first));
  indexed.refresh();
  const originalStarts = indexed.starts;
  const next = { seq: 2, type: 'item.delta', text: '😀' };
  appendFileSync(file, line(next));
  indexed.append(next, line(next));
  indexed.refresh();
  assert.equal(indexed.starts, originalStarts, 'the original index was extended in place');
  assert.deepEqual([...indexed.view()], [first, next]);
});

test('cold opening reuses parsed tail records and releases the scan snapshot', t => {
  const file = fixture(t);
  const rows = Array.from({ length: 200 }, (_, n) => ({ seq: n + 1, type: 'item.delta', text: 'اردو 😀 ' + n }));
  writeFileSync(file, rows.map(line).join(''));
  const indexed = new EventFile(file);
  const read = t.mock.method(indexed, 'read', () => { throw new Error('A parsed tail must not read again'); });
  let escaped;
  indexed.refresh(current => {
    escaped = current.view();
    assert.equal(escaped.at(-1), escaped.at(-1), 'the opening reader reuses its parsed tail object');
    assert.deepEqual(escaped.at(-1), rows.at(-1));
    assert.deepEqual(escaped.at(-2), rows.at(-2));
    assert.equal(read.mock.callCount(), 0);
    renameSync(file, file + '.moved');
    assert.deepEqual(escaped.at(0), rows[0], 'an older record uses the same scan snapshot');
  }, 2);
  assert.equal(escaped.at(-1), null, 'an escaped view retains neither parsed tail nor whole-file bytes');
  assert.equal(indexed.event(0), null, 'the snapshot is released after the callback');
});

test('a failed opening callback releases scan data before the next request', t => {
  const file = fixture(t), indexed = new EventFile(file);
  writeFileSync(file, line({ seq: 1, type: 'turn.start', text: 'Before' }));
  assert.throws(() => indexed.refresh(current => {
    assert.equal(current.view().at(0).text, 'Before');
    throw new Error('Opening failed');
  }, 2), /Opening failed/);
  rmSync(file);
  assert.equal(indexed.event(0), null, 'no parsed record survives the failed callback');
  assert.equal(indexed.refresh().view().length, 0);
});

test('page reads reuse byte blocks and discard cached records after the file changes', t => {
  const file = fixture(t), indexed = new EventFile(file);
  const rows = Array.from({ length: 900 }, (_, n) => ({ seq: n + 1, type: 'item.delta', text: '日本語 😀 ' + n + 'x'.repeat(30) }));
  writeFileSync(file, rows.map(line).join(''));
  indexed.refresh();
  const original = indexed.read;
  const read = t.mock.method(indexed, 'read', function(...args) { return original.apply(this, args); });
  const view = indexed.view();
  for (let n = 850; n >= 650; n--) assert.deepEqual(view.at(n), rows[n]);
  assert.ok(read.mock.callCount() < 8, `used ${read.mock.callCount()} reads for 201 records`);
  const count = read.mock.callCount();
  assert.deepEqual(view.at(650), rows[650]);
  assert.equal(read.mock.callCount(), count, 'a repeated record uses its parsed value');
  rows[650].text = 'Replacement text that changes the byte positions';
  writeFileSync(file + '.new', rows.map(line).join(''));
  renameSync(file + '.new', file);
  indexed.refresh();
  assert.equal(view.at(650).text, rows[650].text, 'a retained view drops its old block and parsed values');
  assert.ok(read.mock.callCount() > count);
});
