import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryState } from '../packages/connect/src/delivery-state.js';

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
