import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A helm-answered turn (`local: true` on turn.start - a sideband command
 * like /usage) is complete on arrival, but it can land while another turn
 * is still streaming. Appended like an ordinary turn it sat after the live
 * one, so everything that turn still had to say rendered *above* it: the
 * answer pinned to the bottom of the chat while work piled up over it.
 * insideOf/insideAt record the seam it landed at so the chat hosts it
 * there and the running turn's later output flows below it.
 */
const { apply, emptyLog } = await import('../apps/web/src/session/types.ts');

test('a helm answer mid-turn records the seam it landed at inside the live turn', () => {
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { ...e, seq: ++seq });
  ev({ type: 'turn.start', turnId: 't1', text: 'a long job' });
  ev({ type: 'item.start', id: 'i1', kind: 'text', turnId: 't1' });
  ev({ type: 'item.delta', id: 'i1', text: 'halfway…' });
  // The /usage exchange, verbatim what the driver emits.
  ev({ type: 'turn.start', turnId: 'command-c1', text: '/usage', local: true });
  ev({ type: 'item.start', id: 'u1', kind: 'text', turnId: 'command-c1' });
  ev({ type: 'item.delta', id: 'u1', text: '### Usage\n…' });
  ev({ type: 'item.done', id: 'u1', status: 'ok' });
  ev({ type: 'turn.done', turnId: 'command-c1', status: 'ok' });
  // The running turn keeps going underneath it.
  ev({ type: 'item.start', id: 'i2', kind: 'text', turnId: 't1' });
  ev({ type: 'item.delta', id: 'i2', text: '…the rest' });
  ev({ type: 'turn.done', turnId: 't1', status: 'ok' });

  const [host, answer] = log.turns;
  assert.equal(answer.insideOf, 't1', 'the answer landed inside the live turn');
  assert.equal(answer.insideAt, 1, 'at the seam it arrived - after the one item that existed');
  assert.equal(answer.local, true);
  assert.deepEqual(host.items.map((i) => i.id), ['i1', 'i2'],
    'the running turn kept its later output - which renders below the answer');
});

test('a helm answer on an idle chat is just the latest turn', () => {
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { ...e, seq: ++seq });
  ev({ type: 'turn.start', turnId: 't1', text: 'first' });
  ev({ type: 'turn.done', turnId: 't1', status: 'ok' });
  ev({ type: 'turn.start', turnId: 'command-c1', text: '/usage', local: true });
  ev({ type: 'turn.done', turnId: 'command-c1', status: 'ok' });
  const answer = log.turns.at(-1);
  assert.equal(answer.insideOf, undefined, 'nothing still open means nothing to land inside');
  assert.equal(answer.local, true);
});

test('a queued ticket is a composer row, never a host', () => {
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { ...e, seq: ++seq });
  ev({ type: 'turn.start', turnId: 't1', text: 'first' });
  ev({ type: 'turn.done', turnId: 't1', status: 'ok' });
  ev({ type: 'turn.start', turnId: 'local-1', text: 'next', queued: true });
  ev({ type: 'turn.start', turnId: 'command-c1', text: '/usage', local: true });
  const answer = log.turns.at(-1);
  assert.equal(answer.insideOf, undefined, 'no open transcript turn to land inside');
});

test('the optimistic bubble hands the seam to the echo that adopts it', () => {
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { ...e, seq: ++seq });
  ev({ type: 'turn.start', turnId: 't1', text: 'a long job' });
  ev({ type: 'item.start', id: 'i1', kind: 'text', turnId: 't1' });
  // helm posts the sideband bubble the moment it is sent (local-), then the
  // driver echoes it under its own id once the answer is fetched - by which
  // point the live turn has streamed one more item.
  ev({ type: 'turn.start', turnId: 'local-7', text: '/usage', local: true });
  ev({ type: 'item.start', id: 'i2', kind: 'text', turnId: 't1' });
  ev({ type: 'turn.start', turnId: 'command-c1', text: '/usage', local: true });
  const answer = log.turns.find((t) => t.id === 'command-c1');
  assert.ok(answer, 'the echo adopted the optimistic turn rather than duplicating it');
  assert.equal(log.turns.length, 2);
  assert.equal(answer.insideOf, 't1');
  assert.equal(answer.insideAt, 2, 'the seam is where the answer landed, not where it was typed');
});

test('two answers at one seam stack in the order they landed', () => {
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { ...e, seq: ++seq });
  ev({ type: 'turn.start', turnId: 't1', text: 'a long job' });
  ev({ type: 'item.start', id: 'i1', kind: 'text', turnId: 't1' });
  for (const id of ['command-c1', 'command-c2']) {
    ev({ type: 'turn.start', turnId: id, text: '/usage', local: true });
    ev({ type: 'turn.done', turnId: id, status: 'ok' });
  }
  const [, a, b] = log.turns;
  assert.equal(a.insideOf, 't1');
  assert.equal(b.insideOf, 't1');
  assert.equal(a.insideAt, b.insideAt, 'both landed at the same seam');
  assert.ok(log.turns.indexOf(a) < log.turns.indexOf(b), 'and stay in landing order');
});

test('an ordinary turn mid-stream is not mistaken for a helm answer', () => {
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { ...e, seq: ++seq });
  ev({ type: 'turn.start', turnId: 't1', text: 'a long job' });
  ev({ type: 'turn.start', turnId: 't2', text: 'a real second turn' });
  const second = log.turns.at(-1);
  assert.equal(second.insideOf, undefined, 'without local it stays a sibling, not a guest');
});
