import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const root = mkdtempSync(join(tmpdir(), 'helm-http-read-'));
process.env.HELM_DIR = join(root, 'home');
process.env.HELM_DB = join(root, 'hub.sqlite');
for (const [key, name] of Object.entries({ HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(root, name);
const N = await import('@helm/protocol/network');
const { startRelay } = await import('../apps/relay/src/server.js');
const net = N.createNetwork({ name: 'read-test', port: 8787 });
const phone = N.issueDevice(net, 'phone');
const hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB, openLogin: false });
const base = `http://127.0.0.1:${hub.server.address().port}`;
const calls = [];
const daemon = new WebSocket(base.replace('http:', 'ws:') + '/ws?role=self', {
  headers: { authorization: `Bearer ${N.machineToken(N.loadNetwork())}` },
});
daemon.on('message', raw => {
  const msg = JSON.parse(raw);
  if (msg.t !== 'rpc') return;
  calls.push(msg);
  const result = msg.method === 'session.events'
    ? { events: [{ seq: 41 }], last: 41, pending: [], session: { status: 'working' } }
    : { method: msg.method, params: msg.params };
  daemon.send(JSON.stringify({ t: 'rpcResult', id: msg.id, ok: true, result }));
});
await new Promise((resolve, reject) => { daemon.once('message', resolve); daemon.once('error', reject); });
test.after(() => { daemon.terminate(); hub.stop(); rmSync(root, { recursive: true, force: true }); });
const read = (method, params = {}, token = phone.token, extra = {}) => fetch(base + '/api/read', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ env: net.self, method, params, ...extra }),
});

test('the visual host has its own restrictive policy without weakening app responses', async () => {
  for (const path of ['/visual-frame', '/helm/visual-frame']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const policy = response.headers.get('content-security-policy');
    assert.match(policy, /script-src 'unsafe-inline'/);
    assert.match(policy, /sandbox allow-scripts/);
    assert.match(policy, /connect-src 'none'/);
    assert.match(policy, /frame-ancestors 'self'/);
    assert.doesNotMatch(policy, /allow-same-origin/);
    assert.match(await response.text(), /helm\.visual\.load/);
    const head = await fetch(base + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 405);
  }
  const health = await fetch(base + '/api/health');
  assert.match(health.headers.get('content-security-policy'), /script-src 'self';/);
  assert.doesNotMatch(health.headers.get('content-security-policy'), /script-src 'unsafe-inline'/);
});

test('authenticated HTTP snapshots cross the real hub RPC router and are never browser cached', async () => {
  for (const method of ['session.events', 'session.messages', 'session.visual', 'session.list', 'model.list', 'session.commands', 'env.info', 'project.list', 'net.routes']) {
    const response = await read(method, { id: 'chat' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.json()).result);
    assert.equal(calls.at(-1).method, method);
  }
});

test('HTTP watch polls the cursor without installing a leaked subscription', async () => {
  const response = await read('session.watch', { id: 'chat', watchId: 'view' });
  assert.deepEqual(await response.json(), { result: { ok: true, last: 41, status: 'working' } });
  assert.equal(calls.at(-1).method, 'session.events');
  assert.deepEqual(calls.at(-1).params, { id: 'chat', tail: 1 });
  const before = calls.length;
  assert.equal((await read('session.unwatch')).status, 200);
  assert.equal(calls.length, before);
});

test('invalid credentials, revoked devices, mutations and malformed reads never reach the daemon', async () => {
  const before = calls.length;
  assert.equal((await read('session.list', {}, 'invalid')).status, 401);
  const revoked = N.issueDevice(N.loadNetwork(), 'revoked');
  N.revoke(N.loadNetwork(), revoked.id);
  assert.equal((await read('session.list', {}, revoked.token)).status, 401);
  for (const method of ['session.input', 'session.answer', 'session.start', 'session.archive', 'env.update', 'profile.defaults', 'project.save', 'project.remove']) {
    assert.equal((await read(method)).status, 403, method);
  }
  for (const extra of [{ env: 'unknown' }, { params: null }, { params: [] }, { params: 'x' }]) {
    assert.equal((await read('session.events', {}, phone.token, extra)).status, 400);
  }
  assert.equal((await read('session.events', { id: 'x'.repeat(17000) })).status, 400);
  assert.equal(calls.length, before);
});

test('an unavailable machine gives an explicit retryable answer', async () => {
  const current = N.loadNetwork();
  current.machines.aabbccddeeff = { id: 'aabbccddeeff', name: 'offline', endpoints: [], addedAt: Date.now(), updatedAt: Date.now() };
  N.saveNetwork(current);
  const response = await read('session.list', {}, phone.token, { env: 'aabbccddeeff' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not connected/);
});

test('a large read answer is compressed for a client that accepts it', async () => {
  const text = 'history '.repeat(1500);
  const response = await read('session.list', { text });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal((await response.json()).result.params.text, text);
  const small = await read('session.list', {});
  assert.equal(small.headers.get('content-encoding'), null);
});


test('ordinary action requests keep sender identity and reject untracked writes', async () => {
  const action = (method, params, token = phone.token) => fetch(base + '/api/action', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ env: net.self, method, params }),
  });
  for (const method of ['session.deliver', 'session.answer-deliver', 'session.action-status']) {
    const response = await action(method, { actionId: 'a'.repeat(32) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(calls.at(-1).method, method);
    assert.equal(calls.at(-1).sub, phone.id);
  }
  const before = calls.length;
  for (const method of ['session.input', 'session.answer', 'session.start', 'env.update']) {
    assert.equal((await action(method, {})).status, 403);
  }
  assert.equal((await action('session.deliver', {}, 'bad')).status, 401);
  assert.equal(calls.length, before);
});
