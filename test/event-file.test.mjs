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

test('a retained view reads the new file after an atomic swap, not stale records', t => {
  const file = fixture(t), indexed = new EventFile(file);
  const rows = Array.from({ length: 900 }, (_, n) => ({ seq: n + 1, type: 'item.delta', text: '日本語 😀 ' + n + 'x'.repeat(30) }));
  writeFileSync(file, rows.map(line).join(''));
  indexed.refresh();
  const view = indexed.view();
  for (let n = 850; n >= 650; n--) assert.deepEqual(view.at(n), rows[n]);
  rows[650].text = 'Replacement text that changes the byte positions';
  writeFileSync(file + '.new', rows.map(line).join(''));
  renameSync(file + '.new', file);
  indexed.refresh();
  assert.equal(view.at(650).text, rows[650].text, 'a retained view drops its old block and parsed values');
  assert.deepEqual(view.at(651), rows[651]);
});
