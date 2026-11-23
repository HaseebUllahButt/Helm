import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-wake-state-'));
process.env.HELM_DIR = join(root, 'helm');
const { createNetwork, rosterHash, checkMachineRecord } = await import('@helm/protocol/network');
const { proofBody } = await import('../packages/protocol/proof.js');
const { WakeState, possibleWakers, wakeHash } = await import('@helm/protocol/wake-state');
test.after(() => rmSync(root, { recursive: true, force: true }));

const target = 'aa11bb22cc33';
const other = 'bb11cc22dd33';
const same = { network: '192.168.1.0', prefix: 24, router: '12:34:56:78:90:ab', mac: 'aa:bb:cc:dd:ee:ff' };

test('wake details survive restart, keep the last wired link, and leave ordinary roster signatures intact', () => {
  const net = createNetwork({ name: 'Waker' });
  const file = join(root, 'remembered');
  const state = new WakeState(file);
  const before = rosterHash(net);
  const announced = state.publish(net, [same]);
  assert.equal(state.publish(net, [same]), null);
  const restarted = new WakeState(file);
  assert.deepEqual(restarted.records(net)[net.self], announced);

  const linkDown = restarted.publish(net, []);
  assert.deepEqual(linkDown.links, []);
  assert.deepEqual(linkDown.receivers, [same]);
  const roam = { ...same, router: '12:34:56:78:90:ad' };
  const moved = restarted.publish(net, [roam]);
  assert.deepEqual(moved.receivers, [roam]);
  assert.equal(rosterHash(net), before);
  assert.ok(checkMachineRecord(net, net.machines[net.self]));
});

test('merge accepts the target signature, ignores stale data, and rejects copies with changed links', () => {
  const net = createNetwork({ name: 'Waker' });
  const pair = generateKeyPairSync('ed25519');
  net.machines[target] = { id: target, codeSignPubkey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
  const store = new WakeState(join(root, 'learned'));
  const remote = (at, links, receivers) => {
    const value = { issuer: target, at, links, receivers };
    return { ...value, signature: sign(null, proofBody(net.id, 'machine-wake', value), pair.privateKey).toString('base64url') };
  };
  const current = remote(Date.now(), [same], [same]);
  assert.equal(store.merge(net, [ { ...current, receivers: [] } ]), false);
  assert.equal(store.merge(net, [remote(Date.now(), [{ ...same, network: '192.168.1.5' }], [])]), false);
  assert.equal(store.merge(net, [current]), true);
  assert.equal(store.merge(net, [current, remote(current.at - 1, [], [])]), false);
  assert.deepEqual(store.records(net)[target], current);
  const hash = wakeHash(store.records(net));
  assert.equal(wakeHash({ [target]: current }), hash);
  net.revoked[target] = Date.now();
  assert.deepEqual(store.records(net), {});
});

test('waker candidates share a router and subnet and prefer this machine', () => {
  const wifi = { ...same, mac: null };
  const records = {
    [target]: { receivers: [same], links: [] },
    [other]: { links: [wifi] },
    self: { links: [wifi] },
    otherRouter: { links: [{ ...wifi, router: '12:34:56:78:90:cd' }] },
    otherSubnet: { links: [{ ...wifi, network: '192.168.2.0' }] },
    unknown: { links: [{ ...wifi, router: null }] },
    disconnected: { links: [], receivers: [same] },
  };
  assert.deepEqual(possibleWakers(records, target, 'self'), ['self', other]);
  assert.deepEqual(possibleWakers(records, 'missing', 'self'), []);
});
