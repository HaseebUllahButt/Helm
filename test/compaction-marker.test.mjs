import test from 'node:test';
import assert from 'node:assert/strict';

const { apply, emptyLog } = await import('../apps/web/src/session/types.ts');

test('a compaction left open by a restart stops once a newer one starts or ends', () => {
  const log = emptyLog();
  apply(log, { type: 'turn.start', turnId: 't1', text: '', at: 1, seq: 1 });
  // Helm restarted mid-compaction: the old marker never got its end.
  apply(log, { type: 'item.start', id: 'c-old', kind: 'tool', name: 'compact', turnId: 't1', input: {}, at: 2, seq: 2 });
  apply(log, { type: 'item.start', id: 'c-new', kind: 'tool', name: 'compact', turnId: 't1', input: {}, at: 3, seq: 3 });
  const item = (id) => log.turns[0].items.find((i) => i.id === id);
  assert.equal(item('c-old').status, 'ok');
  assert.equal(item('c-new').status, 'streaming');
  apply(log, { type: 'item.done', id: 'c-new', status: 'ok', at: 4, seq: 4 });
  assert.equal(item('c-new').status, 'ok');
  assert.equal(log.turns[0].done, undefined, 'the turn itself keeps going');
});

test('other running steps are left alone', () => {
  const log = emptyLog();
  apply(log, { type: 'turn.start', turnId: 't1', text: '', at: 1, seq: 1 });
  apply(log, { type: 'item.start', id: 'b1', kind: 'tool', name: 'Bash', turnId: 't1', input: {}, at: 2, seq: 2 });
  apply(log, { type: 'item.start', id: 'c1', kind: 'tool', name: 'compact', turnId: 't1', input: {}, at: 3, seq: 3 });
  apply(log, { type: 'item.done', id: 'c1', status: 'ok', at: 4, seq: 4 });
  assert.equal(log.turns[0].items.find((i) => i.id === 'b1').status, 'streaming');
});
