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

async function fixture(t, handler, extra = {}, remoteAddress, otherShares = [], onLookup = () => {}) {
  const sockets = new Set();
  let opened = 0;
  const app = http.createServer(handler);
  app.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const share = { name: 'app', port: app.address().port, ...extra };
  const route = createShareRoute({ online: new Map([['machine', {}], ...(otherShares.length ? [['other', {}]] : [])]),
    callEnv: async env => {
      const shares = structuredClone(env === 'machine' ? [share] : otherShares);
      await onLookup(env); return { shares };
    },
    openTcp: () => new Promise((resolve, reject) => {
      opened++;
      const socket = connect(share.port, '127.0.0.1');
      // openTcp returns a Duplex whose setTimeout is deliberately a no-op.
      // A real net.Socket would hide a missing idle timer in the share pool.
      socket.setTimeout = () => socket;
      socket.once('connect', () => resolve(socket)); socket.once('error', reject);
    }) });
  const hub = http.createServer((req, res) => {
    if (remoteAddress) Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
    route.route(req, res).catch(error => res.destroy(error));
  });
  hub.listen(0, '127.0.0.1'); await once(hub, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    hub.closeAllConnections();
    await Promise.all([new Promise(r => app.close(r)), new Promise(r => hub.close(r))]);
  });
  const request = (options = {}) => http.request({ host: '127.0.0.1', port: hub.address().port,
    headers: { host: 'app.recovery.test' }, ...options });
  return { request, share, sockets, hub, get opened() { return opened; } };
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


test('a changed Spin password applies before the first request after cache expiry', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.end('shared'); });
  const first = f.request(); first.end();
  const [warm] = await once(first, 'response');
  warm.resume(); await once(warm, 'end');
  f.share.lock = hashSharePassword('new password');
  now += 5001;
  const next = f.request(); next.end();
  const [answer] = await once(next, 'response');
  answer.resume(); await once(answer, 'end');
  assert.equal(answer.statusCode, 401);
  assert.equal(calls, 1, 'the warm tunnel must not bypass the changed password');
});

test('unfinished password requests each count toward the attempt limit', async t => {
  const f = await fixture(t, (_req, res) => res.end('shared'), { lock: hashSharePassword('secret') });
  const pending = [];
  for (let i = 0; i < 8; i++) {
    const arrived = once(f.hub, 'request');
    const req = f.request({ method: 'POST', path: '/.helm-share/unlock' });
    req.on('error', () => {});
    req.flushHeaders();
    await arrived;
    // Cross the request event and its lookup continuation before the next request.
    await new Promise(resolve => setImmediate(resolve));
    pending.push(req);
  }
  t.after(() => { for (const req of pending) req.destroy(); });
  const next = f.request({ method: 'POST', path: '/.helm-share/unlock' });
  next.end('password=wrong');
  const [answer] = await once(next, 'response');
  answer.resume(); await once(answer, 'end');
  assert.equal(answer.statusCode, 429);
});


test('direct Spin visitors cannot change their address to reset password attempts', async t => {
  const f = await fixture(t, (_req, res) => res.end('shared'),
    { lock: hashSharePassword('secret') }, '192.0.2.1');
  for (let i = 0; i < 9; i++) {
    const req = f.request({ method: 'POST', path: '/.helm-share/unlock',
      headers: { host: 'app.recovery.test', 'x-forwarded-for': `198.51.100.${i}` } });
    req.end('password=wrong');
    const [answer] = await once(req, 'response');
    answer.resume(); await once(answer, 'end');
    assert.equal(answer.statusCode, i < 8 ? 401 : 429);
  }
});

test('Spin apps receive the direct address or the last local proxy address', async t => {
  for (const [address, expected] of [['192.0.2.1', '192.0.2.1'], ['127.0.0.1', '198.51.100.2']]) {
    const f = await fixture(t, (req, res) => res.end(req.headers['x-forwarded-for']), {}, address);
    const req = f.request({ headers: { host: 'app.recovery.test', 'x-forwarded-for': 'fake, 198.51.100.2' } });
    req.end();
    const [answer] = await once(req, 'response');
    let body = ''; for await (const part of answer) body += part;
    assert.equal(body, expected);
  }
});


test('a known Spin refresh checks only its source machine', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const calls = [];
  const f = await fixture(t, (_req, res) => res.end('shared'), {}, undefined,
    [{ name: 'another', port: 9 }], env => calls.push(env));
  const first = f.request(); first.end();
  const [warm] = await once(first, 'response'); warm.resume(); await once(warm, 'end');
  assert.deepEqual(calls.sort(), ['machine', 'other']);
  calls.length = 0; now += 5001;
  const next = f.request(); next.end();
  const [answer] = await once(next, 'response'); answer.resume(); await once(answer, 'end');
  assert.equal(answer.statusCode, 200);
  assert.equal(calls[0], 'machine');
});

test('duplicate Spin names refuse access instead of choosing a machine', async t => {
  let calls = 0;
  const otherShares = [{ name: 'app', port: 9 }];
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, (_req, res) => { calls++; res.end('shared'); }, {}, undefined, otherShares);
  const req = f.request(); req.end();
  const [answer] = await once(req, 'response');
  let body = ''; for await (const part of answer) body += part;
  assert.equal(answer.statusCode, 409);
  assert.match(body, /Two machines use this link name/);
  assert.equal(calls, 0);
  otherShares.length = 0; now += 5001;
  const next = f.request(); next.end();
  const [resolved] = await once(next, 'response'); resolved.resume(); await once(resolved, 'end');
  assert.equal(resolved.statusCode, 200);
});


test('an older discovery answer cannot restore public access after a newer source check', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let held = false, release, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  t.after(release);
  const f = await fixture(t, (_req, res) => res.end('shared'), {}, undefined,
    [{ name: 'another', port: 9 }], async env => { if (held && env === 'other') { entered(); await pause; } });
  const request = async (host = 'app.recovery.test') => {
    const req = f.request({ headers: { host } }); req.end();
    const [res] = await once(req, 'response'); res.resume(); await once(res, 'end'); return res.statusCode;
  };
  assert.equal(await request(), 200);
  now += 5500; held = true;
  const discovery = request('missing.recovery.test');
  await blocked;
  f.share.private = true;
  assert.equal(await request(), 401);
  release(); await discovery;
  assert.equal(await request(), 401);
});

test('a warm Spin discovers a later duplicate without an unknown-name visit', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let called, watch = false;
  const discovered = new Promise(resolve => { called = resolve; });
  const other = [{ name: 'another', port: 9 }];
  const f = await fixture(t, (_req, res) => res.end('shared'), {}, undefined, other,
    env => { if (watch && env === 'other') called(); });
  const request = async () => {
    const req = f.request(); req.end(); const [res] = await once(req, 'response');
    res.resume(); await once(res, 'end'); return res.statusCode;
  };
  assert.equal(await request(), 200);
  other[0].name = 'app'; now += 5500; watch = true;
  await request(); await discovered;
  assert.equal(await request(), 409);
});
