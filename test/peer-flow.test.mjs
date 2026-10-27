import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { DeflateLink } from '../packages/connect/src/peer.js';

for (const wake of ['bufferedamountlow', 'close', 'fallback']) test(`compressed replies release their wait after ${wake}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channel = Object.assign(new EventTarget(), { readyState: 'open', bufferedAmount: 1024 * 1024, send() {} });
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const add = channel.addEventListener.bind(channel);
  channel.addEventListener = (name, listener) => { add(name, listener); if (name === 'bufferedamountlow') entered(); };
  const zip = new DeflateLink(channel); t.after(() => zip.close());
  const sent = zip.send('test');
  await waiting;
  channel.bufferedAmount = 0;
  if (wake === 'close') channel.readyState = 'closed';
  if (wake === 'fallback') t.mock.timers.tick(250);
  else channel.dispatchEvent(new Event(wake));
  assert.equal(await sent, wake !== 'close');
  for (const name of ['bufferedamountlow', 'close', 'error']) assert.equal(getEventListeners(channel, name).length, 0);
});
