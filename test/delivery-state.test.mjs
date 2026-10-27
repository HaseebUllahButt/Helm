import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryState } from '../packages/connect/src/delivery-state.js';

test('queue tickets are copied on add and on snapshot', () => {
  const state = new DeliveryState();
  const item = { turnId: 'retry-1', text: 'hello', attachments: [{ name: 'a' }] };
  state.addTicket('chat', item);
  item.text = 'changed';
  const snapshot = state.queue('chat');
  snapshot[0].text = 'changed again';
  snapshot[0].attachments[0].name = 'changed';
  assert.deepEqual(state.queue('chat'), [{ turnId: 'retry-1', text: 'hello', attachments: [{ name: 'a' }] }]);
});

test('tickets can be removed, restored and inspected', () => {
  const state = new DeliveryState();
  state.addTicket('chat', { turnId: 'a' });
  assert.equal(state.hasTicket('chat', 'a'), true);
  assert.deepEqual(state.removeTicket('chat', 'a'), { turnId: 'a' });
  assert.equal(state.hasQueue('chat'), false);
  state.restoreQueue('chat', [{ turnId: 'b' }]);
  assert.deepEqual(state.ticket('chat', 'b'), { turnId: 'b' });
});

test('reply markers and steps stay private behind snapshots and operations', () => {
  const state = new DeliveryState();
  state.addAwaitingEcho('chat', { turnId: 'echo', text: 'hello' });
  const echoes = state.awaitingEcho('chat');
  echoes[0].text = 'changed';
  assert.deepEqual(state.awaitingEcho('chat'), [{ turnId: 'echo', text: 'hello' }]);
  state.addSteered('chat', { turnId: 'steer', text: 'next' });
  assert.deepEqual(state.removeSteered('chat', 'steer'), { turnId: 'steer', text: 'next' });
  state.addStep('chat', 'tool');
  assert.deepEqual(state.steps('chat'), ['tool']);
  state.clear('chat');
  assert.equal(state.hasQueue('chat'), false);
  assert.deepEqual(state.awaitingEcho('chat'), []);
});

test('closed replies read saved history only once per chat', () => {
  const state = new DeliveryState();
  let reads = 0;
  const load = () => { reads++; return ['saved']; };
  state.seedClosedTurns('chat', load);
  assert.equal(state.closeTurn('chat', 'saved'), false);
  state.seedClosedTurns('chat', load);
  assert.equal(state.closeTurn('chat', 'new'), true);
  assert.equal(reads, 1);
  state.clear('chat');
  state.seedClosedTurns('chat', load);
  assert.equal(reads, 2);
});

test('a failed send removes its echo marker by ticket and driver', () => {
  const state = new DeliveryState();
  const firstDriver = { send() {} };
  const secondDriver = { send() {} };
  state.addAwaitingEcho('chat', { turnId: 'retry', text: 'same text', driver: firstDriver });
  state.addAwaitingEcho('chat', { turnId: 'retry', text: 'same text', driver: secondDriver });

  // The send error handler removes the marker it created, even though reads
  // return copies and another driver has a marker with the same ticket id.
  assert.equal(state.awaitingEcho('chat')[0].driver, firstDriver);
  assert.equal(state.removeAwaitingEcho('chat', 'retry', firstDriver).driver, firstDriver);
  assert.deepEqual(state.awaitingEcho('chat').map((item) => item.driver), [secondDriver]);
});

test('failed steering does not restore a ticket consumed while steering waited', () => {
  const state = new DeliveryState();
  const ticket = { turnId: 'steer-1', text: 'next' };
  state.addTicket('chat', ticket);
  const held = state.removeTicket('chat', ticket.turnId);
  state.addSteered('chat', { turnId: ticket.turnId, text: ticket.text, item: held });

  // A consumed event can arrive while the driver call is still pending.
  assert.ok(state.removeSteered('chat', ticket.turnId));
  // The later failed-call handler removes only a current marker. No marker
  // means it must not put the already-consumed ticket back in the queue.
  assert.equal(state.removeSteered('chat', ticket.turnId), null);
  assert.deepEqual(state.queue('chat'), []);
});
