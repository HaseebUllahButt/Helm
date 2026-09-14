import { test } from 'node:test';
import assert from 'node:assert/strict';

// A client with a direct peer connection is still attached to a hub, so both
// paths reach it. Every push therefore has to carry an id the client can use
// to drop the second copy - without one, a terminal wrote each keystroke's
// echo twice.
test('the client ignores an event id it has already delivered', async () => {
  // The browser's guard, in the small: a bounded set of recent ids.
  const seen = new Set();
  const order = [];
  const delivered = [];
  const deliver = (kind, eid) => {
    if (eid) {
      if (seen.has(eid)) return;
      seen.add(eid);
      order.push(eid);
      if (order.length > 500) seen.delete(order.shift());
    }
    delivered.push(kind);
  };

  // The same push over the hub and over the peer channel.
  deliver('session.data', 'boot1:1');
  deliver('session.data', 'boot1:1');
  assert.deepEqual(delivered, ['session.data'], 'the second copy is dropped');

  deliver('session.data', 'boot1:2');
  assert.equal(delivered.length, 2);

  // A daemon that restarted starts its counter again; the boot half keeps
  // those ids from colliding with the ones already seen.
  deliver('session.data', 'boot2:1');
  assert.equal(delivered.length, 3);

  // An old daemon that stamps nothing is passed through, not swallowed.
  deliver('session.data', undefined);
  deliver('session.data', undefined);
  assert.equal(delivered.length, 5);

  // The memory is bounded.
  for (let i = 0; i < 600; i++) deliver('x', `boot1:${100 + i}`);
  assert.ok(seen.size <= 500, `kept ${seen.size} ids`);
});
