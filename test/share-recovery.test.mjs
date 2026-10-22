import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-share-recovery-'));
process.env.HELM_DIR = root;
process.env.HELM_SHARE_DOMAIN = 'recovery.test';
const { createShareRoute } = await import('../apps/relay/src/share.js');
const { hashSharePassword } = await import('@helm/protocol/share');
test.after(() => rmSync(root, { recursive: true, force: true }));

async function fixture(t, handler, extra = {}) {
  const sockets = new Set();
  let opened = 0;
  const app = http.createServer(handler);
  app.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const share = { name: 'app', port: app.address().port, ...extra };
  const route = createShareRoute({ online: new Map([['machine', {}]]),
    callEnv: async () => ({ shares: [share] }),
    openTcp: () => new Promise((resolve, reject) => {
      opened++;
      const socket = connect(share.port, '127.0.0.1');
      // openTcp returns a Duplex whose setTimeout is deliberately a no-op.
      // A real net.Socket would hide a missing idle timer in the share pool.
      socket.setTimeout = () => socket;
      socket.once('connect', () => resolve(socket)); socket.once('error', reject);
    }) });
  const hub = http.createServer((req, res) => route.route(req, res).catch(error => res.destroy(error)));
  hub.listen(0, '127.0.0.1'); await once(hub, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    hub.closeAllConnections();
    await Promise.all([new Promise(r => app.close(r)), new Promise(r => hub.close(r))]);
  });
  const request = (options = {}) => http.request({ host: '127.0.0.1', port: hub.address().port,
    headers: { host: 'app.recovery.test' }, ...options });
  return { request, share, sockets, get opened() { return opened; } };
}

test('the pool drops idle tunnels before the app keep-alive deadline', { timeout: 5000 }, async t => {
  const f = await fixture(t, (_req, res) => {
    res.setHeader('keep-alive', 'timeout=2');
    res.end('shared');
  });
  const req = f.request(); req.end();
  const [res] = await once(req, 'response');
  res.resume(); await once(res, 'end');
  assert.equal(f.sockets.size, 1);
  const deadline = Date.now() + 1500;
  while (f.sockets.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.sockets.size, 0, 'an idle tunnel must not wait for the remote close to cross the network');
  const next = f.request(); next.end();
  const [answer] = await once(next, 'response');
  answer.resume(); await once(answer, 'end');
  assert.equal(answer.statusCode, 200);
});

test('reusing a tunnel clears its idle timer while a response is active', { timeout: 5000 }, async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    res.setHeader('keep-alive', 'timeout=2');
    if (++calls === 1) res.end('warm');
    else setTimeout(() => res.end('slow answer'), 1300);
  });
  const first = f.request(); first.end();
  const [warm] = await once(first, 'response');
  warm.resume(); await once(warm, 'end');
  const next = f.request(); next.end();
  const [answer] = await once(next, 'response');
  let body = ''; for await (const part of answer) body += part;
  assert.equal(answer.statusCode, 200);
  assert.equal(body, 'slow answer');
  assert.equal(calls, 2);
  assert.equal(f.opened, 1, 'the slow request must use the same tunnel');
});

test('a cut-short public download closes the visitor and the next request recovers', { timeout: 5000 }, async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    if (++calls > 1) return res.end('recovered');
    res.writeHead(200, { 'content-length': '1000000' });
    res.write('first bytes');
    setTimeout(() => res.destroy(), 20);
  });
  const req = f.request(); req.end();
  const [res] = await once(req, 'response');
  res.on('error', () => {}); res.resume();
  await Promise.race([new Promise(resolve => res.once('close', resolve)),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('visitor hung after the download stopped')), 500); timer.unref(); })]);
  assert.equal(res.complete, false);
  const next = f.request(); next.end();
  const [answer] = await once(next, 'response');
  let text = ''; for await (const part of answer) text += part;
  assert.equal(text, 'recovered');
});

test('expiry rejects a new request even when its public tunnel is pooled', { timeout: 5000 }, async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.end('shared'); }, { expiresAt: Date.now() + 100 });
  const first = f.request(); first.end();
  const [response] = await once(first, 'response');
  response.resume(); await once(response, 'end');
  await new Promise(resolve => setTimeout(resolve, 110));
  const next = f.request(); next.end();
  const [expired] = await once(next, 'response');
  expired.resume(); await once(expired, 'end');
  assert.equal(expired.statusCode, 404);
  assert.equal(calls, 1, 'an expired link cannot borrow its warm tunnel');
});

test('leaving during an upload closes the shared app connection', { timeout: 5000 }, async t => {
  let arrived;
  const started = new Promise(resolve => { arrived = resolve; });
  const f = await fixture(t, req => { req.on('error', () => {}); req.resume(); arrived(); });
  const req = f.request({ method: 'POST', headers: { host: 'app.recovery.test', 'content-length': '1000000' } });
  req.on('error', () => {}); req.write('first bytes'); await started; req.destroy();
  const deadline = Date.now() + 500;
  while (f.sockets.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.sockets.size, 0, 'a cancelled upload must release its tunnel');
});

test('password sign-in keeps unsafe return paths out of its redirect', async t => {
  const f = await fixture(t, (_req, res) => res.end('shared'), { lock: hashSharePassword('test only') });
  for (const next of ['/\\elsewhere.test', '/\r\ninvalid', '//elsewhere.test']) {
    const req = f.request({ method: 'POST', path: '/.helm-share/unlock' });
    req.end(new URLSearchParams({ password: 'test only', next }).toString());
    const [res] = await once(req, 'response'); res.resume(); await once(res, 'end');
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/');
  }
});
