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
