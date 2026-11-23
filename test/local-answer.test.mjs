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

test('a message the CLI took mid-turn sits where it was used; the turn goes on below it', () => {
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { ...e, seq: ++seq });
  ev({ type: 'turn.start', turnId: 't1', text: 'a long job' });
  ev({ type: 'item.start', id: 'c1', kind: 'command', turnId: 't1' });
  ev({ type: 'turn.start', turnId: 'local-9', text: 'also the docs', queued: true });
  ev({ type: 'turn.deliver', turnId: 'local-9' });
  const msg = log.turns.find((t) => t.id === 'local-9');
  assert.equal(msg.queued, true);
  assert.equal(msg.delivered, true);
  ev({ type: 'item.done', id: 'c1', status: 'ok' });
  ev({ type: 'turn.accept', turnId: 'local-9' });
  assert.equal(msg.queued, false);
  assert.equal(msg.insideOf, 't1');
  assert.equal(msg.insideAt, 1, 'after the step that was running when the CLI read it');
  ev({ type: 'item.start', id: 'c2', kind: 'command', turnId: 't1' });
  assert.equal(log.turns.find((t) => t.id === 't1').items.length, 2, 'later work stays in the running turn');
  // An echo of the same words later is a new turn, not this bubble.
  ev({ type: 'turn.done', turnId: 't1', status: 'ok' });
  ev({ type: 'turn.start', turnId: 't2', text: 'also the docs' });
  assert.ok(log.turns.some((t) => t.id === 't2'));
  assert.equal(msg.id, 'local-9');
});

test('closing the ticket of a message the agent already took up leaves the running reply open', () => {
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { ...e, seq: ++seq });
  ev({ type: 'turn.start', turnId: 'local-a', text: 'add a status bar', queued: false });
  ev({ type: 'turn.start', turnId: 'r1', text: 'add a status bar', inputId: 'local-a' });
  ev({ type: 'item.start', id: 'i1', kind: 'tool', turnId: 'r1', name: 'Bash' });
  // helm closes its ticket while the reply r1 is still running.
  ev({ type: 'turn.done', turnId: 'local-a', status: 'ok' });
  assert.equal(log.turns.find((t) => t.id === 'r1').done, undefined, 'the running reply is not finished');
  // A message typed mid-reply is taken up and sits inside r1, at that point.
  ev({ type: 'turn.start', turnId: 'local-b', text: 'also do this', queued: true });
  ev({ type: 'turn.deliver', turnId: 'local-b' });
  ev({ type: 'turn.accept', turnId: 'local-b' });
  const b = log.turns.find((t) => t.id === 'local-b');
  assert.equal(b.insideOf, 'r1');
  assert.equal(b.insideAt, 1);
});

// A compaction marker Helm left open across a restart.
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

test('a compaction left open by a restart stops once the agent takes its next step', () => {
  const log = emptyLog();
  apply(log, { type: 'turn.start', turnId: 't1', text: '', at: 1, seq: 1 });
  apply(log, { type: 'item.start', id: 'c1', kind: 'tool', name: 'compact', turnId: 't1', input: {}, at: 2, seq: 2 });
  // A helper's own step runs beside the compaction and says nothing about it.
  apply(log, { type: 'item.start', id: 'h1', kind: 'tool', name: 'Bash', turnId: 't1', parentId: 'agent', input: {}, at: 3, seq: 3 });
  const item = (id) => log.turns[0].items.find((i) => i.id === id);
  assert.equal(item('c1').status, 'streaming');
  apply(log, { type: 'item.start', id: 'b1', kind: 'tool', name: 'Bash', turnId: 't1', input: {}, at: 4, seq: 4 });
  assert.equal(item('c1').status, 'ok');
  assert.equal(item('c1').doneAt, 4);
  assert.equal(item('b1').status, 'streaming');
});
