import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What a credential is allowed to do, as opposed to merely prove.
 *
 * Authentication here answers one question - does this token carry a valid
 * signature for this network - and for a long time every route took that as
 * the whole answer. It is not: a controller token is what a pairing link hands
 * a phone, and it must not be able to do the things a machine does. The three
 * that mattered were gossiping a roster (which writes the SSH keys every
 * machine trusts), opening a tunnel to any port (which reaches every
 * localhost-only service), and guessing at the login window forever.
 */

const root = mkdtempSync(join(tmpdir(), 'helm-authz-'));
process.env.HELM_DIR = root;
process.env.HELM_DB = join(root, 'hub.sqlite');

const PORT = 18788;
const BASE = `http://127.0.0.1:${PORT}`;

const N = await import('@helm/protocol/network');
const net = N.createNetwork({ name: 'laptop', port: PORT });
const { startRelay } = await import('@helm/relay');
const hub = await startRelay({ port: PORT, dbFile: join(root, 'hub.sqlite'), host: '127.0.0.1' });

const post = (path, body, token, extra = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });

const login = await (await post('/api/auth/login', { password: hub.password, label: 'phone' })).json();
const DEVICE = login.token;
const MACHINE = N.machineToken(net);

test.after(() => { hub.stop(); rmSync(root, { recursive: true, force: true }); });

const hostile = {
  id: 'deadbeefcafe',
  name: 'evil',
  pubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIATTACKER attacker@evil',
  sshUser: 'haseeb',
  sshPort: 22,
  endpoints: ['http://attacker.example:8787'],
  updatedAt: Date.now(),
  addedAt: Date.now(),
};
const asRoster = (machines = {}, revoked = {}) =>
  ({ id: net.id, machines, devices: {}, revoked });

test('a controller cannot gossip a roster', async () => {
  const res = await post('/api/roster', asRoster({ deadbeefcafe: hostile }), DEVICE);
  assert.equal(res.status, 403);
  assert.equal(N.loadNetwork().machines.deadbeefcafe, undefined);
});

test('a controller cannot revoke the network out from under itself', async () => {
  const res = await post('/api/roster', asRoster({}, { [net.self]: Date.now() }), DEVICE);
  assert.equal(res.status, 403);
  assert.ok(N.loadNetwork().machines[net.self], 'the machine is still a member');
  assert.equal(Object.keys(N.loadNetwork().revoked).length, 0);
});

test('a machine still gossips, and still reconciles both directions', async () => {
  const res = await post('/api/roster', asRoster({ deadbeefcafe: hostile }), MACHINE);
  assert.equal(res.status, 200);
  const back = await res.json();
  assert.equal(back.id, net.id, 'the answer carries our roster back');
  assert.ok(N.loadNetwork().machines.deadbeefcafe, 'a machine may introduce a machine');
});

test('a controller can still read the network and add a computer', async () => {
  // The product surface a phone actually has. Gating gossip must not touch it.
  const network = await (await fetch(`${BASE}/api/network`, {
    headers: { authorization: `Bearer ${DEVICE}` },
  })).json();
  assert.equal(network.id, net.id);

  const invite = await (await post('/api/invite', {}, DEVICE)).json();
  assert.match(invite.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test('a page from anywhere else is not answered', async () => {
  const evil = await post('/api/auth/login', { password: 'x' }, null, { origin: 'https://evil.example' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  // Rebinding: the browser sends the attacker's own name as both Origin and
  // Host, so a hub that compared them to each other would agree and let it in.
  const rebound = await post('/api/auth/login', { password: 'x' }, null,
    { origin: 'http://evil.example', host: 'evil.example' });
  assert.equal(rebound.headers.get('access-control-allow-origin'), null);

  // A hub this network actually lives at still is.
  const mine = await post('/api/auth/login', { password: 'x' }, null, { origin: BASE });
  assert.equal(mine.headers.get('access-control-allow-origin'), BASE);

  // Nothing that skips CORS entirely is affected.
  const cli = await fetch(`${BASE}/api/health`);
  assert.equal(cli.status, 200);
  assert.equal((await cli.json()).network, net.id);
});

test('a device paired at one hub can still probe the others', async () => {
  // The reason `*` was there: a phone keeps the origin of whichever hub served
  // it, and probes every other address in the network from that page. Those
  // are cross-origin, and they have to work or the app cannot fail over.
  N.describeSelf(N.loadNetwork(), { endpoints: ['https://1-2-3-4.sslip.io'] });

  const probed = await fetch(`${BASE}/api/network`, {
    headers: { authorization: `Bearer ${DEVICE}`, origin: 'https://1-2-3-4.sslip.io' },
  });
  assert.equal(probed.status, 200);
  assert.equal(probed.headers.get('access-control-allow-origin'), 'https://1-2-3-4.sslip.io');
  assert.equal(probed.headers.get('vary'), 'Origin');

  // A near-miss on that name is still a stranger.
  const near = await fetch(`${BASE}/api/network`, {
    headers: { authorization: `Bearer ${DEVICE}`, origin: 'https://1-2-3-4.sslip.io.evil.example' },
  });
  assert.equal(near.headers.get('access-control-allow-origin'), null);
});

test('the login window is burned once it is being guessed at', async () => {
  const { password } = await (await post('/api/auth/rotate', {}, MACHINE)).json();

  // Nine wrong guesses leave it usable; the tenth kills it.
  for (let i = 0; i < 9; i++) {
    assert.equal((await post('/api/auth/login', { password: 'wrong' })).status, 401, `guess ${i}`);
  }
  assert.equal((await post('/api/auth/login', { password: 'wrong' })).status, 403);
  assert.equal((await post('/api/auth/login', { password })).status, 403,
    'the real password does not revive a burned window');

  // And the owner can always open a new one.
  const fresh = await (await post('/api/auth/rotate', {}, MACHINE)).json();
  const ok = await post('/api/auth/login', { password: fresh.password, label: 'phone 2' });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token);
});

test('devices already paired are undisturbed by any of it', async () => {
  const res = await fetch(`${BASE}/api/network`, { headers: { authorization: `Bearer ${DEVICE}` } });
  assert.equal(res.status, 200);
});
