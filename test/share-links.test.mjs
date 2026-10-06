import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * `helm share`: https://<name>.<hub host> carried to a port on a machine.
 *
 * A real hub and a real app server; the machine is a stand-in holding an env
 * slot that answers `share.list` and terminates tunnels the way agent.js
 * does, only to the ports it shared. Requests go to the hub with the share's
 * Host header, which is all Caddy adds in front of it.
 */

const base = mkdtempSync(join(tmpdir(), 'helm-share-'));
process.env.HELM_DIR = join(base, 'helm');
process.env.HELM_DB = join(base, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_SHARE_DOMAIN = 'links.test';
delete process.env.INVOCATION_ID;

const N = await import('@helm/protocol/network');
const { mintToken } = await import('@helm/protocol/identity');
const { M, T } = await import('@helm/protocol');
const { hashSharePassword } = await import('@helm/protocol/share');
const { startRelay } = await import('@helm/relay');
const { Daemon } = await import('../packages/connect/src/agent.js');
const shares = await import('../packages/connect/src/shares.js');

const PORT = 18793;
const net = N.createNetwork({ name: 'sharebox', port: PORT });
N.saveNetwork(net);
const hub = await startRelay({ port: PORT, dbFile: process.env.HELM_DB, host: '127.0.0.1' });

// The app being shared: says what it saw, and echoes over a websocket.
const app = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-app': 'yes' });
    res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, fwd: req.headers['x-forwarded-host'], cookie: req.headers.cookie ?? null, body }));
  });
});
new WebSocketServer({ server: app }).on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const APP = app.address().port;
const LOCK = hashSharePassword('open sesame');

const machine = await fakeMachine('aa11bb22cc33', [
  { name: 'app', port: APP },
  { name: 'locked', port: APP, lock: LOCK },
  { name: 'gone', port: 1 }, // shared, but nothing listens there
]);

test.after(() => { machine.close(); app.close(); hub.stop(); rmSync(base, { recursive: true, force: true }); });

function request(host, path = '/', { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a shared port answers on its name, as a local visit', async () => {
  const r = await request('app.links.test', '/page?x=1', { headers: { accept: 'text/html', cookie: 'theirs=1' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-app'], 'yes');
  const seen = JSON.parse(r.text);
  assert.equal(seen.url, '/page?x=1');
  assert.equal(seen.host, `localhost:${APP}`, 'dev servers only trust a local Host');
  assert.equal(seen.fwd, 'app.links.test');
  assert.equal(seen.cookie, 'theirs=1');

  const posted = await request('app.links.test', '/form', { method: 'POST', body: 'a=1&b=2', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(JSON.parse(posted.text).body, 'a=1&b=2');
});

test('an unknown name, or a dead app, says so in words', async () => {
  const missing = await request('nope.links.test');
  assert.equal(missing.status, 404);
  assert.match(missing.text, /No link called/);
  const dead = await request('gone.links.test');
  assert.equal(dead.status, 502);
  assert.match(dead.text, /Nothing answered/);
  // helm itself is untouched on the bare host.
  assert.equal((await request('127.0.0.1', '/api/version')).headers['content-type'], 'application/json');
});

test('a password share asks first, remembers, and keeps its cookie to itself', async () => {
  const first = await request('locked.links.test', '/inside', { headers: { accept: 'text/html' } });
  assert.equal(first.status, 401);
  assert.match(first.text, /This link has a password/);
  assert.match(first.text, /name="next" value="\/inside"/);
  const script = await request('locked.links.test', '/api', { headers: { accept: 'application/json' } });
  assert.equal(script.status, 401);
  assert.equal(script.text, 'password required');

  const wrong = await request('locked.links.test', '/.helm-share/unlock', { method: 'POST', body: 'password=nope&next=%2Finside' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /not the password/);

  const right = await request('locked.links.test', '/.helm-share/unlock', { method: 'POST', body: 'password=open+sesame&next=%2Finside' });
  assert.equal(right.status, 303);
  assert.equal(right.headers.location, '/inside');
  const cookie = right.headers['set-cookie'][0].split(';')[0];
  assert.match(right.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax/);

  const inside = await request('locked.links.test', '/inside', { headers: { cookie: `${cookie}; theirs=2` } });
  assert.equal(inside.status, 200);
  assert.equal(JSON.parse(inside.text).cookie, 'theirs=2', 'the app never sees the share cookie');

  // A cookie for one share opens no other, and an open redirect is refused.
  const elsewhere = await request('locked.links.test', '/.helm-share/unlock', { method: 'POST', body: 'password=open+sesame&next=%2F%2Fevil.test' });
  assert.equal(elsewhere.headers.location, '/');
});

test('guessing is slowed down', async () => {
  let last;
  for (let i = 0; i < 9; i++) {
    last = await request('locked.links.test', '/.helm-share/unlock', { method: 'POST', body: 'password=x', headers: { 'x-forwarded-for': '203.0.113.9' } });
  }
  assert.equal(last.status, 429);
  const right = await request('locked.links.test', '/.helm-share/unlock', { method: 'POST', body: 'password=open+sesame', headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(right.status, 429, 'even the right password waits out the lockout');
});

test('websockets go through, and a locked one needs the cookie', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`, { headers: { host: 'app.links.test' } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const reply = new Promise((resolve) => ws.once('message', (m) => resolve(String(m))));
  ws.send('hi');
  assert.equal(await reply, 'echo:hi');
  ws.close();

  const locked = new WebSocket(`ws://127.0.0.1:${PORT}/live`, { headers: { host: 'locked.links.test' } });
  const status = await new Promise((resolve) => locked.on('unexpected-response', (_req, res) => resolve(res.statusCode)));
  assert.equal(status, 401);
});

test('Caddy only gets certificates for names that are shared', async () => {
  const ask = (domain) => request('127.0.0.1', `/api/share/ask?domain=${domain}`);
  assert.equal((await ask('app.links.test')).status, 200);
  assert.equal((await ask('nope.links.test')).status, 404);
  assert.equal((await ask('links.test')).status, 404);
  // Through Caddy (which adds X-Forwarded-For) the question is not answered.
  const outside = await request('127.0.0.1', '/api/share/ask?domain=app.links.test', { headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.notEqual(outside.text, 'ok');
});

test('a machine opens tunnels only to ports it shared, and hides hashes from members', async (t) => {
  const d = new Daemon({ name: 'sharebox', port: PORT + 1, advertiseLan: false });
  t.after(() => d.stop());
  const sent = [];
  const link = { id: 'hub', send: (tt, extra) => sent.push({ t: tt, ...extra }) };
  await d.onFrame(link, { t: T.TUNNEL_OPEN, sid: 's1', port: APP });
  assert.equal(sent.find((f) => f.t === T.TUNNEL_CLOSE)?.reason, 'port not allowed');

  await d.dispatch(M.SHARE_ADD, { name: 'mine', port: APP, password: 'pw' });
  await assert.rejects(() => d.dispatch(M.SHARE_ADD, { name: 'mine', port: 9 }), /already shared/);
  sent.length = 0;
  await d.onFrame(link, { t: T.TUNNEL_OPEN, sid: 's2', port: APP });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(sent.some((f) => f.t === T.TUNNEL_READY));

  const member = await d.dispatch(M.SHARE_LIST, { forHub: true }, 'phone-id');
  assert.deepEqual(Object.keys(member.shares[0]).sort(), ['createdAt', 'name', 'password', 'port', 'url']);
  const forHub = await d.dispatch(M.SHARE_LIST, { forHub: true });
  assert.ok(forHub.shares[0].lock.hash);

  await d.dispatch(M.SHARE_REMOVE, { name: 'mine' });
  sent.length = 0;
  await d.onFrame(link, { t: T.TUNNEL_OPEN, sid: 's3', port: APP });
  assert.equal(sent.find((f) => f.t === T.TUNNEL_CLOSE)?.reason, 'port not allowed');
  assert.deepEqual(shares.listShares(), []);
});

/** A machine on the hub: answers share.list, dials only its shared ports. */
async function fakeMachine(id, list) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/helm/ws?name=sharer`, {
    headers: { authorization: `Bearer ${mintToken(net.key, { net: net.id, sub: id, role: 'machine' })}` },
  });
  const tunnels = new Map();
  const send = (o) => ws.send(JSON.stringify(o));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === T.RPC) {
      send({ t: T.RPC_RESULT, id: msg.id, ok: true, result: msg.method === 'share.list' ? { shares: list } : {} });
    } else if (msg.t === T.TUNNEL_OPEN) {
      if (!list.some((s) => s.port === msg.port)) return send({ t: T.TUNNEL_CLOSE, sid: msg.sid, reason: 'port not allowed' });
      const sock = tcpConnect({ host: '127.0.0.1', port: msg.port });
      tunnels.set(msg.sid, sock);
      sock.on('connect', () => send({ t: T.TUNNEL_READY, sid: msg.sid }));
      sock.on('data', (c) => send({ t: T.TUNNEL_DATA, sid: msg.sid, data: c.toString('base64') }));
      const end = () => { if (tunnels.delete(msg.sid)) send({ t: T.TUNNEL_CLOSE, sid: msg.sid }); };
      sock.on('close', end);
      sock.on('error', end);
    } else if (msg.t === T.TUNNEL_DATA) {
      tunnels.get(msg.sid)?.write(Buffer.from(msg.data, 'base64'));
    } else if (msg.t === T.TUNNEL_CLOSE) {
      tunnels.get(msg.sid)?.destroy();
      tunnels.delete(msg.sid);
    }
  });
  const welcomed = new Promise((resolve) => {
    const onMsg = (raw) => { if (JSON.parse(raw).t === T.WELCOME) { ws.off('message', onMsg); resolve(); } };
    ws.on('message', onMsg);
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await welcomed;
  return ws;
}
