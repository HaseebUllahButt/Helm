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

test('pending permissions are derived from the log', () => {
  const log = new EventLog(mkdtempSync(join(tmpdir(), 'helm-events-')));
  log.append('s', { type: 'permission.request', requestId: 'r1', kind: 'command' });
  log.append('s', { type: 'permission.request', requestId: 'r2', kind: 'edit' });
  log.append('s', { type: 'permission.resolved', requestId: 'r1', decision: 'allow' });
  assert.deepEqual(log.pending('s').map((e) => e.requestId), ['r2']);
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
