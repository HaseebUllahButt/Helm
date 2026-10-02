import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';

const root = mkdtempSync(join(tmpdir(), 'helm-onboarding-'));
process.env.HELM_DIR = root;
process.env.HELM_DB = join(root, 'hub.sqlite');
const N = await import('@helm/protocol/network');
const { startRelay } = await import('@helm/relay');
const hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB });
const base = `http://127.0.0.1:${hub.server.address().port}`;
test.after(() => { hub.stop(); rmSync(root, { recursive: true, force: true }); });

const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

test('public and installed apps inherit only the same network on this computer', async () => {
  const net = N.createNetwork({ name: 'joined computer' });
  N.describeSelf(net, { endpoints: ['https://home.example'] });
  const headers = { origin: 'https://home.example', 'sec-fetch-site': 'cross-site' };
  const first = await post('/api/auth/desktop', { network: net.id }, headers);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('access-control-allow-origin'), headers.origin);
  const auth = await first.json();
  assert.ok(auth.token);
  assert.equal(auth.network, net.id);
  assert.equal(auth.local, true);
  assert.equal(N.authenticate(N.loadNetwork(), auth.token).sub, auth.deviceId);
  const reopened = await (await post('/api/auth/desktop', { network: net.id }, headers)).json();
  assert.equal(reopened.deviceId, auth.deviceId, 'install/reopen does not create another pairing');
  assert.equal((await post('/api/auth/desktop', { network: 'another-network' }, headers)).status, 409);

  for (const origin of ['https://evil.example', 'http://home.example', 'https://home.example:444', 'null']) {
    const denied = await post('/api/auth/desktop', { network: net.id }, { origin });
    assert.equal(denied.status, 403, origin);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.equal((await denied.json()).token, undefined);
  }
  // Caddy forwarding remote traffic over loopback is not a local browser.
  for (const host of ['home.example', 'localhost.evil.example']) {
    const status = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/auth/desktop`, { method: 'POST',
        headers: { ...headers, host, 'content-type': 'application/json' } }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ network: net.id }));
    });
    assert.equal(status, 403, host);
  }

  const options = await fetch(`${base}/api/auth/desktop`, {
    method: 'OPTIONS', headers: { ...headers,
      'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-private-network'), 'true');
  assert.equal(options.headers.get('access-control-allow-origin'), headers.origin);
  assert.equal((await post('/api/auth/local', {}, headers)).status, 403, 'local key stays private');
});

test('the first join replaces only the temporary install network and clears its invitations', async (t) => {
  const { newNetworkId, newNetworkKey } = await import('@helm/protocol/identity');
  const remote = { id: newNetworkId(), key: newNetworkKey(), machines: {}, devices: {}, revoked: {}, role: 'pc' };
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/api/join' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(remote));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const at = `http://127.0.0.1:${server.address().port}`;
  const starter = N.createNetwork({ name: 'new install' });
  starter.provisional = true;
  N.saveNetwork(starter);
  const { db, q } = await import('@helm/relay/db');
  q.inviteInsert.run('ABCD-2345', Date.now() + 600_000, 'pc');
  const { join: joinNet } = await import('../packages/connect/src/serve.js');
  const joined = await joinNet({ code: 'WXYZ-6789', at, name: 'laptop', port: 9876 });
  assert.equal(joined.id, remote.id);
  assert.equal(joined.port, 9876);
  assert.equal(joined.provisional, undefined);
  assert.equal(joined.role, 'pc');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 0);
  await assert.rejects(joinNet({ code: 'WXYZ-6789', at }), /already in a network/);
  assert.equal(N.loadNetwork().id, remote.id, 'a real network is never silently replaced');
});

test('a failed first join keeps the temporary network usable', async () => {
  const starter = N.createNetwork({ name: 'new install' });
  starter.provisional = true;
  N.saveNetwork(starter);
  const { join: joinNet } = await import('../packages/connect/src/serve.js');
  await assert.rejects(joinNet({ code: 'NOPE-2345', at: base }), /unknown or expired invite/);
  assert.equal(N.loadNetwork().id, starter.id);
  assert.equal(N.loadNetwork().provisional, true);
});
