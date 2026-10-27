import test from 'node:test';
import assert from 'node:assert/strict';
import { Driver, COALESCE_MS } from '../packages/connect/src/drivers/index.js';

// The first piece of a reply goes out at once; the ones right behind it are
// still merged, so a fast stream costs one frame per COALESCE_MS.
test('the first text after a pause leaves at once, and the rest is merged', async () => {
  const driver = new Driver({ engine: 'fake', cmd: 'fake' });
  const seen = [];
  driver.on('event', (event) => seen.push(event));
  driver.push('item.delta', { id: 'm', text: 'Hello' });
  assert.deepEqual(seen, [{ type: 'item.delta', id: 'm', text: 'Hello' }]);
  driver.push('item.delta', { id: 'm', text: ' there' });
  driver.push('item.delta', { id: 'm', text: ', friend' });
  assert.equal(seen.length, 1, 'text right behind the first waits for the batch');
  await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 20));
  assert.deepEqual(seen.at(-1), { type: 'item.delta', id: 'm', text: ' there, friend' });
  await new Promise((resolve) => setTimeout(resolve, COALESCE_MS + 20));
  driver.push('item.delta', { id: 'm', text: '!' });
  assert.deepEqual(seen.at(-1), { type: 'item.delta', id: 'm', text: '!' }, 'after a pause the next piece is instant again');
  driver.push('item.done', { id: 'm' });
  assert.equal(seen.at(-1).type, 'item.done');
});
