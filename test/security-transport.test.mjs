import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import WebSocket from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'helm-secure-'));
process.env.HELM_DIR = dir;
process.env.HELM_DB = join(dir, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';
const N = await import('@helm/protocol/network');
const { mintToken, verifyToken } = await import('@helm/protocol/identity');
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a stolen shared key cannot create machine or browser credentials', () => {
  const net = N.createNetwork();
  const phone = N.issueDevice(net);
  assert.ok(N.authenticate(net, N.machineToken(net)));
  assert.ok(N.authenticate(net, phone.token));
  for (const [sub, role] of [[net.self, 'machine'], ['aabbccddeeff', 'machine'], [phone.id, 'device']]) {
    assert.equal(N.authenticate(net, mintToken(net.key, { net: net.id, sub, role })), null);
  }
  const claims = verifyToken(net.key, phone.token);
  assert.equal(N.authenticate(net, mintToken(net.key, { ...claims, exp: claims.exp + 1 })), null);
  const revoked = structuredClone(net);
  revoked.revoked[net.self] = Date.now();
  delete revoked.machines[net.self];
  assert.equal(N.authenticate(revoked, phone.token), null);
  assert.equal(N.authenticate(revoked, N.machineToken(net)), null);
});

test('a browser stays signed in until it is removed', () => {
  const net = N.createNetwork();
  const phone = N.issueDevice(net);
  // Older Helm still needs an expiry within seven days.
  const { exp } = verifyToken(net.key, phone.token);
  assert.ok(exp > Date.now() && exp <= Date.now() + 7 * 24 * 60 * 60_000);
  const now = Date.now;
  try {
    Date.now = () => now() + 90 * 24 * 60 * 60_000;
    assert.ok(N.authenticate(net, phone.token));
    N.revoke(net, phone.id);
    assert.equal(N.authenticate(net, phone.token), null);
  } finally { Date.now = now; }
});

test('remote HTTP is refused before a handshake sends anything', async () => {
  const net = N.createNetwork();
  for (const base of ['http://192.168.1.1:8787', 'http://example.com', 'https://name:secret@example.com']) {
    assert.equal(N.secureHubAddress(base), false);
    await assert.rejects(N.hubCredential(net, base), /Use HTTPS/);
  }
  assert.equal(N.secureHubAddress('https://home.example'), true);
  assert.equal(N.secureHubAddress('http://127.0.0.1:8787'), true);
});

test('a command skips remote HTTP addresses and waits while its hubs restart', async () => {
  // 2026-11-11: helm agents and helm ship stopped with "Use HTTPS to connect
  // to another machine." Loopback and the VM were restarting, so the next
  // hub in the list was a peer's home network address on plain http.
  const net = N.createNetwork();
  const { createServer } = await import('node:net');
  const closed = await new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  net.port = closed;
  net.machines.aabbccddeeff = { id: 'aabbccddeeff', name: 'home-pc', endpoints: ['http://192.168.10.64:8787', 'https://home.example.invalid'] };
  const { hubRpc, hubUrls } = await import('../packages/connect/src/hub-client.js');
  const { forwardHubs } = await import('../packages/connect/src/forward.js');
  const err = await hubRpc(net, 'aabbccddeeff', 'env.info', {}, { timeout: 3000, budget: 6000 }).then(() => null, (e) => e);
  assert.equal(err?.code, 'unreachable', err?.message);
  assert.doesNotMatch(err.message, /Use HTTPS/);
  for (const urls of [hubUrls(net), hubUrls(net, 'aabbccddeeff'), forwardHubs(net), N.hubAddresses(net)]) {
    assert.deepEqual(urls.filter((url) => !N.secureHubAddress(url)), []);
    assert.ok(urls.includes(`http://127.0.0.1:${closed}`) && urls.includes('https://home.example.invalid'));
  }
});

test('HTTP and WebSocket ingress refuse nonlocal sockets and forged proxy headers', async t => {
  N.createNetwork();
  const { startRelay } = await import('@helm/relay');
  const hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => hub.stop());
  const port = hub.server.address().port;
  const response = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/health', localAddress: '127.0.0.2',
      headers: { 'x-forwarded-proto': 'https' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(response, 426);
  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { localAddress: '127.0.0.2' });
    ws.on('unexpected-response', (req, res) => { res.resume(); req.destroy(); resolve(res.statusCode); });
    ws.on('error', reject);
  });
  assert.equal(result, 426);
});

test('an invite registers a joining key before authentication and cannot be reused', async t => {
  const net = N.createNetwork();
  const { startRelay } = await import('@helm/relay');
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => hub.stop());
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${N.machineToken(net)}` };
  const invite = await (await fetch(`${base}/api/invite`, { method: 'POST', headers, body: '{}' })).json();
  const pair = generateKeyPairSync('ed25519');
  const self = '123456789abc';
  const body = JSON.stringify({ code: invite.code, self, name: 'joined',
    codeSignPubkey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') });
  const response = await fetch(`${base}/api/join`, { method: 'POST', headers, body });
  assert.equal(response.status, 200);
  const current = N.loadNetwork();
  assert.equal(current.machines[self].name, 'joined');
  const claims = { net: net.id, sub: self, issuer: self, role: 'machine' };
  claims.signature = sign(null, Buffer.from('helm-credential-v2:' + JSON.stringify([
    claims.net, self, 'machine', self, null, null,
  ])), pair.privateKey).toString('base64url');
  const credential = mintToken(net.key, claims);
  assert.ok(N.authenticate(current, credential));
  assert.equal((await fetch(`${base}/api/join`, { method: 'POST', headers, body })).status, 409);
  current.revoked[self] = Date.now();
  delete current.machines[self];
  assert.equal(N.authenticate(current, credential), null);
  assert.equal(N.authenticate(current, mintToken(net.key, { ...claims, sub: net.self, issuer: net.self })), null);
});
