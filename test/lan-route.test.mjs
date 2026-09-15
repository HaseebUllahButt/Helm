import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses, lanIsRoutable } from '../packages/connect/src/net-addr.js';

/**
 * The check that would have found, in one command, why a phone on the same
 * wifi was relaying everything through a hub on another continent: the
 * laptop's LAN address was still on the interface and still advertised, but
 * a full-tunnel VPN had taken the route for that subnet, so nothing on the
 * wifi could get an answer back.
 */
test('lan addresses skip the interfaces nothing can route to', () => {
  for (const a of lanAddresses()) {
    assert.doesNotMatch(a.name, /^(docker|br-|veth|virbr|tun|tap)/);
    assert.match(a.address, /^\d+\.\d+\.\d+\.\d+$/);
  }
});

test('the routability check answers about this machine, or has no opinion', async () => {
  const r = await lanIsRoutable();
  // null is a legitimate answer: no private address, or no `ip` to ask.
  if (r === null) return;
  assert.match(r.address, /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
  assert.equal(typeof r.via, 'string');
  assert.equal(typeof r.expected, 'string');
  assert.equal(r.ok, r.via === r.expected);
});

test('it never throws, whatever the machine looks like', async () => {
  await assert.doesNotReject(() => lanIsRoutable());
});
