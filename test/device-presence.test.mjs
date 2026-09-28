import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The parts of the Devices screen that answer "is this one still mine?".
 *
 * A list of labels and pairing dates cannot tell a phone in the owner's pocket
 * from one they lost in March, and a green dot that only ever lit for "this
 * device" said nothing about anyone else. Presence is answered by the hub from
 * its own sockets - never gossiped - and a pairing link can be closed the
 * moment it has done its job instead of lingering for the rest of its window.
 */

const dir = mkdtempSync(join(tmpdir(), 'helm-presence-'));
process.env.HELM_DIR = dir;
process.env.HELM_DB = join(dir, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';

const PORT = 18972;
const BASE = `http://127.0.0.1:${PORT}`;

const { createNetwork, loadNetwork } = await import('@helm/protocol/network');
const { startRelay } = await import('@helm/relay');
const { default: WebSocket } = await import('ws');

createNetwork({ name: 'test', port: PORT });
const hub = await startRelay({ port: PORT, host: '127.0.0.1', dbFile: process.env.HELM_DB });
test.after(() => { hub.stop(); rmSync(dir, { recursive: true, force: true }); });

const call = (path, { token, method = 'GET', body } = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const pair = (password, label) =>
  call('/api/auth/login', { method: 'POST', body: { password, label } }).then((r) => r.json());
const listed = async (token, id) =>
  (await (await call('/api/devices', { token })).json()).devices.find((d) => d.id === id);
const until = async (fn, what) => {
  for (let i = 0; i < 60; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const owner = await pair(hub.password, 'owner phone');

test('a device that just paired has been seen, and is not online until it connects', async () => {
  const before = Date.now();
  const d = await listed(owner.token, owner.deviceId);
  assert.equal(d.online, false, 'a login is not a socket');
  assert.ok(d.lastSeen >= before - 5_000, 'pairing counts as the first sighting');
});

test('an open socket is online now, and closing it leaves the time it left', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['helm', owner.token]);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

  const on = await until(async () => {
    const d = await listed(owner.token, owner.deviceId);
    return d.online ? d : null;
  }, 'the device to show online');
  assert.ok(on.lastSeen > 0);

  const left = Date.now();
  ws.close();
  const off = await until(async () => {
    const d = await listed(owner.token, owner.deviceId);
    return d.online ? null : d;
  }, 'the device to show offline');
  assert.ok(off.lastSeen >= left - 1_000, 'lastSeen is when it disconnected, not when it paired');
});

test('presence is not written into the roster that gossips', async () => {
  const stored = Object.values(loadNetwork().devices).find((d) => d.id === owner.deviceId);
  assert.equal('lastSeen' in stored, false);
  assert.equal('online' in stored, false);
});

test('closing the pairing window stops the link working, and paired devices keep theirs', async () => {
  const window = await (await call('/api/auth/rotate', { token: owner.token, method: 'POST', body: {} })).json();
  assert.ok(window.password);

  const res = await call('/api/auth/close', { token: owner.token, method: 'POST' });
  assert.equal(res.status, 200);

  const late = await call('/api/auth/login', { method: 'POST', body: { password: window.password, label: 'late' } });
  assert.equal(late.status, 403, 'the link is dead as soon as it is closed');
  assert.equal((await call('/api/devices', { token: owner.token })).status, 200, 'the owner is still in');
});

test('only a paired device can close the window', async () => {
  const res = await call('/api/auth/close', { method: 'POST' });
  assert.equal(res.status, 401);
});

test('a removed device leaves no presence behind, even though its socket closed after', async () => {
  const w = await (await call('/api/auth/rotate', { token: owner.token, method: 'POST', body: {} })).json();
  const other = await pair(w.password, 'lost tablet');

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['helm', other.token]);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await until(async () => (await listed(owner.token, other.deviceId))?.online, 'the tablet to show online');

  const closed = new Promise((resolve) => ws.once('close', resolve));
  const del = await call(`/api/devices/${other.deviceId}`, { token: owner.token, method: 'DELETE' });
  assert.equal(del.status, 200);
  await closed;

  assert.equal(await listed(owner.token, other.deviceId), undefined, 'it is gone from the list');
  // Ask the database, not the API: the list is built from the roster and would
  // hide an orphan row either way.
  const { q } = await import('../apps/relay/src/db.js');
  assert.equal(q.seenAll.all().some((r) => r.device_id === other.deviceId), false);
});

// ------------------------------------------------------------ pairing alert

test('pairing a new device tells the devices already paired; the local sign-in does not', async () => {
  const { createServer } = await import('node:http');
  const { createECDH, randomBytes } = await import('node:crypto');

  // A stand-in push service: it records that it was asked, and says yes.
  const hits = [];
  const service = createServer((req, res) => {
    req.resume();
    req.on('end', () => { hits.push(req.url); res.writeHead(201).end(); });
  });
  await new Promise((r) => service.listen(0, '127.0.0.1', r));
  test.after(() => service.close());

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // Straight into the table: the route only accepts the https endpoints real
  // push services use, which is a guard worth keeping and not one to loosen
  // for a test.
  const { q } = await import('../apps/relay/src/db.js');
  q.pushSet.run(
    `http://127.0.0.1:${service.address().port}/push/owner`, owner.deviceId,
    ecdh.getPublicKey().toString('base64url'), randomBytes(16).toString('base64url'),
    'owner phone', Date.now(),
  );

  const w = await (await call('/api/auth/rotate', { token: owner.token, method: 'POST', body: {} })).json();
  const paired = await pair(w.password, 'someone else');
  assert.ok(paired.token);
  await until(() => hits.length >= 1, 'the alert to reach the push service');
  assert.deepEqual(hits, ['/push/owner']);

  // `helm open` on the machine itself is the owner arriving, not a new device.
  const { localKey } = await import('@helm/protocol/network');
  const before = hits.length;
  const local = await call('/api/auth/login', { method: 'POST', body: { local: localKey(), label: 'this machine' } });
  assert.equal(local.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(hits.length, before, 'no alert for the machine signing itself in');
});
