import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

// A machine dials every address in the roster, most of them plain http on
// some LAN, and whoever answers at one of those addresses used to be handed
// the machine's durable token. The hub now proves it holds the network key
// first, and what the machine sends back is spent on first use.
const dir = mkdtempSync(join(tmpdir(), 'helm-handshake-'));
process.env.HELM_DIR = dir;
process.env.HELM_DB = join(dir, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';

const PORT = 18983;
const IMPOSTOR = 18984;

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a hub proves itself, and its credential is good once', async (t) => {
  const N = await import('@helm/protocol/network');
  const { startRelay } = await import('@helm/relay');

  N.createNetwork({ name: 'vm', port: PORT });
  const hub = await startRelay({ port: PORT, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => hub.stop());
  const net = N.loadNetwork();
  const base = `http://127.0.0.1:${PORT}`;
  const ask = (token) => fetch(`${base}/api/network`, { headers: { authorization: `Bearer ${token}` } });

  const credential = await N.hubCredential(net, base);
  assert.equal((await ask(credential)).status, 200, 'the handshake credential works');
  assert.equal((await ask(credential)).status, 401, 'and only once: a sniffed copy is already spent');

  // Right key, but a challenge this hub never issued.
  assert.equal((await ask(N.oneTimeToken(net, 'made-up-challenge'))).status, 401);

  // An expired one-time token is refused even with a live challenge.
  const { mintToken, ROLE } = await import('@helm/protocol/identity');
  const hello = await (await fetch(`${base}${N.HELLO_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: 'n'.repeat(24) }),
  })).json();
  const stale = mintToken(net.key, { net: net.id, sub: net.self, role: ROLE.MACHINE, ch: hello.challenge, exp: Date.now() - 1 });
  assert.equal((await ask(stale)).status, 401);

  // A nonce that is not one is refused rather than MAC'd.
  const bad = await fetch(`${base}${N.HELLO_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: 'x' }),
  });
  assert.equal(bad.status, 400);
});

test('an address that cannot prove itself is sent nothing', async (t) => {
  const N = await import('@helm/protocol/network');
  const net = N.loadNetwork();
  const seen = [];
  let answer = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ net: net.id, proof: 'forged', challenge: 'c' })); };
  const impostor = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    answer(res);
  });
  await new Promise((r) => impostor.listen(IMPOSTOR, '127.0.0.1', r));
  t.after(() => impostor.close());
  const base = `http://127.0.0.1:${IMPOSTOR}`;

  await assert.rejects(N.hubCredential(net, base), (err) => err.untrusted);
  // An older helm, or anything else without the route: no fallback.
  answer = (res) => { res.writeHead(404); res.end(); };
  await assert.rejects(N.hubCredential(net, base), (err) => err.untrusted);

  assert.deepEqual(seen, [null, null], 'no credential of any kind reached the impostor');
});

test('an RPC lookup budget bounds a stalled hub handshake across fallback routes', async (t) => {
  const N = await import('@helm/protocol/network');
  const { hubRpc } = await import('../packages/connect/src/hub-client.js');
  let attempts = 0;
  const server = createServer(() => { attempts++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const net = { ...N.loadNetwork(), port };
  net.machines = { other: { endpoints: [`http://127.0.0.1:${port}`] } };
  const started = Date.now();
  await assert.rejects(hubRpc(net, 'offline', 'session.list', {}, { timeout: 5000, budget: 200 }), /could not reach/);
  assert.ok(Date.now() - started < 2000, 'the overall budget includes authentication');
  assert.equal(attempts, 1, 'an exhausted budget cannot start another fallback handshake');
});

test('an RPC lookup budget also bounds a hub that accepts but never answers', async (t) => {
  const N = await import('@helm/protocol/network');
  const { hubRpc } = await import('../packages/connect/src/hub-client.js');
  const net = { ...N.loadNetwork() };
  let attempts = 0, calls = 0;
  const server = createServer(async (req, res) => {
    attempts++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { nonce } = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ net: net.id, challenge: 'lookup-test', proof: N.hubProof(net, nonce) }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', ws => ws.on('message', () => { calls++; }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const ws of sockets.clients) ws.terminate();
    sockets.close(); server.closeAllConnections(); server.close();
  });
  net.port = server.address().port;
  net.machines = { other: { endpoints: [`http://127.0.0.1:${net.port}`] } };
  const started = Date.now();
  await assert.rejects(hubRpc(net, 'offline', 'session.list', {}, { timeout: 5000, budget: 200 }), /timed out/);
  assert.ok(Date.now() - started < 2000, 'the overall budget includes the RPC response');
  assert.equal(attempts, 1);
  assert.equal(calls, 1);
});

test('a refused connection falls back to a reachable hub instead of aborting on fetch failed', async (t) => {
  const N = await import('@helm/protocol/network');
  const { hubRpc } = await import('../packages/connect/src/hub-client.js');
  const net = { ...N.loadNetwork() };
  const closed = createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  net.port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { nonce } = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ net: net.id, challenge: 'fallback', proof: N.hubProof(net, nonce) }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', ws => ws.on('message', raw => {
    const { id } = JSON.parse(raw);
    ws.send(JSON.stringify({ t: 'rpcResult', id, ok: true, result: { reached: true } }));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  net.machines = { peer: { endpoints: [`http://127.0.0.1:${server.address().port}`] } };
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.closeAllConnections(); server.close(); });
  assert.deepEqual(await hubRpc(net, 'peer', 'env.info', {}, { timeout: 2000, budget: 5000 }), { reached: true });
});
