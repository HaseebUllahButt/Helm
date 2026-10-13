import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { connect as tcpConnect, createServer } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * Private links (`helm share --private`) and `helm forward`.
 *
 * A real hub and a real app server; the machine is a stand-in holding an env
 * slot that answers `share.list` and terminates tunnels only to the ports it
 * shared, as agent.js does. The browser's trip through the Helm app is
 * played by hand: ask the hub for a pass with a device's token, post it to
 * the link, use the cookie that comes back.
 */

const base = mkdtempSync(join(tmpdir(), 'helm-share-private-'));
process.env.HELM_DIR = join(base, 'helm');
process.env.HELM_DB = join(base, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(base, 'ssh');
process.env.HELM_NO_SERVICE = '1';
delete process.env.HELM_SHARE_DOMAIN;
delete process.env.INVOCATION_ID;

const N = await import('@helm/protocol/network');
const { mintToken } = await import('@helm/protocol/identity');
const { M, T } = await import('@helm/protocol');
const S = await import('@helm/protocol/share');
const { startRelay } = await import('@helm/relay');
const { Daemon } = await import('../packages/connect/src/agent.js');
const shares = await import('../packages/connect/src/shares.js');
const { startForward } = await import('../packages/connect/src/forward.js');
const { bridge } = await import('../packages/connect/src/proxy.js');

const PORT = 18795;
const HOST = 'home.test';
let net = N.createNetwork({ name: 'privatebox', port: PORT });
// The public home: links are <name>.home.test, the app is on home.test.
N.advertise(net, [`https://${HOST}`]);
net = N.loadNetwork();
const phone = N.issueDevice(net, 'phone');
const laptop = N.issueDevice(net, 'laptop');
const hub = await startRelay({ port: PORT, dbFile: process.env.HELM_DB, host: '127.0.0.1' });

const app = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'x-app': 'yes' });
  res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null }));
});
new WebSocketServer({ server: app }).on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const APP = app.address().port;

const MACHINE = 'dd11ee22ff33';
const machine = await fakeMachine(MACHINE, [
  { name: 'secret', port: APP, private: true },
  { name: 'open', port: APP },
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

/** What the Helm app does for a signed-in device: ask for a pass. */
async function grant(token, params) {
  const r = await request('127.0.0.1', '/api/share/grant', {
    method: 'POST', body: JSON.stringify(params),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: r.status, body: JSON.parse(r.text) };
}

/** ...and post it to the link, as the app's form does. */
const enter = (pass, host = `secret.${HOST}`) => request(host, '/.helm-share/enter', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant: pass.grant, next: pass.next }).toString(),
});

const cookieOf = (r, name) => r.headers['set-cookie']?.find((c) => c.startsWith(`${name}=`))?.split(';')[0];

test('a stranger sees a plain private page, and scripts a plain refusal', async () => {
  const r = await request(`secret.${HOST}`, '/inside?a=1', { headers: { accept: 'text/html' } });
  assert.equal(r.status, 401);
  assert.match(r.text, /Private to your Helm/);
  // The way in goes to the Helm app, on the hub's own address, with nothing
  // secret in it.
  const hop = /href="([^"]+)"/.exec(r.text)[1].replace(/&amp;/g, '&');
  const u = new URL(hop);
  assert.equal(u.origin, `https://${HOST}`);
  const p = new URLSearchParams(u.hash.slice(1));
  assert.deepEqual([p.get('share'), p.get('host'), p.get('next')], ['secret', HOST, '/inside?a=1']);
  assert.ok(!r.headers['set-cookie']);

  const script = await request(`secret.${HOST}`, '/api', { headers: { accept: 'application/json' } });
  assert.equal(script.status, 401);
  assert.equal(script.text, 'private to its Helm');

  // A password page's answer is not membership: there is no password to try.
  const unlock = await request(`secret.${HOST}`, '/.helm-share/unlock', { method: 'POST', body: 'password=x' });
  assert.equal(unlock.status, 401);
  assert.ok(!unlock.headers['set-cookie']);
});

test('a signed-in device gets a pass, the link swaps it for its own cookie, once', async () => {
  const { status, body: pass } = await grant(phone.token, { name: 'secret', host: HOST, next: '/inside' });
  assert.equal(status, 200);
  assert.equal(pass.action, `https://secret.${HOST}/.helm-share/enter`);
  assert.equal(pass.next, '/inside');

  const r = await enter(pass);
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/inside');
  const member = cookieOf(r, '__Host-helm-member');
  assert.ok(member);
  for (const c of r.headers['set-cookie']) assert.match(c, /HttpOnly; Secure; SameSite=Lax/);

  const inside = await request(`secret.${HOST}`, '/inside', { headers: { cookie: `${member}; __Host-helm-member-seen=1; theirs=1` } });
  assert.equal(inside.status, 200);
  assert.equal(inside.headers['x-app'], 'yes');
  assert.equal(JSON.parse(inside.text).cookie, 'theirs=1', 'the shared app never sees our cookies');

  const again = await enter(pass);
  assert.equal(again.status, 401, 'a pass is good once');
  assert.match(again.text, /already used/);
});

test('a pass is for one link, on one host, for a minute', async () => {
  const { body: pass } = await grant(phone.token, { name: 'other', host: HOST });
  assert.equal((await enter(pass)).status, 401, 'a pass for another name');

  const fresh = N.loadNetwork();
  const old = S.mintShareGrant(fresh, { name: 'secret', host: HOST, sub: phone.id, now: Date.now() - 61_000 });
  assert.equal((await enter({ grant: old, next: '/' })).status, 401, 'an expired pass');
  const forged = S.mintShareGrant({ ...fresh, key: N.loadNetwork().key.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) },
    { name: 'secret', host: HOST, sub: phone.id });
  assert.equal((await enter({ grant: forged, next: '/' })).status, 401, 'a pass signed with another key');

  // The hub decides where a pass may go: never to an address someone named.
  assert.equal((await grant(phone.token, { name: 'secret', host: 'evil.test' })).status, 400);
  assert.equal((await grant(null, { name: 'secret', host: HOST })).status, 401);
  // A next that leaves the link is the front page instead.
  assert.equal((await grant(phone.token, { name: 'secret', host: HOST, next: '//evil.test' })).body.next, '/');
});

test('a member who has been in before goes straight to the app for a new pass', async () => {
  const r = await request(`secret.${HOST}`, '/page', { headers: { accept: 'text/html', cookie: '__Host-helm-member-seen=1' } });
  assert.equal(r.status, 303);
  assert.match(r.headers.location, new RegExp(`^https://${HOST.replace('.', '\\.')}/#share=secret&host=`));
});

test('a removed device loses the link at once', async () => {
  const { body: pass } = await grant(laptop.token, { name: 'secret', host: HOST });
  const member = cookieOf(await enter(pass), '__Host-helm-member');
  assert.equal((await request(`secret.${HOST}`, '/', { headers: { cookie: member } })).status, 200);
  N.revoke(N.loadNetwork(), laptop.id);
  assert.equal((await request(`secret.${HOST}`, '/', { headers: { cookie: member } })).status, 401);
  assert.equal((await grant(laptop.token, { name: 'secret', host: HOST })).status, 401);
});

test('websockets on a private link need the member cookie', async () => {
  const refused = new WebSocket(`ws://127.0.0.1:${PORT}/live`, { headers: { host: `secret.${HOST}` } });
  assert.equal(await new Promise((resolve) => refused.on('unexpected-response', (_q, res) => resolve(res.statusCode))), 401);

  const { body: pass } = await grant(phone.token, { name: 'secret', host: HOST });
  const member = cookieOf(await enter(pass), '__Host-helm-member');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`, { headers: { host: `secret.${HOST}`, cookie: member } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const reply = new Promise((resolve) => ws.once('message', (m) => resolve(String(m))));
  ws.send('hi');
  assert.equal(await reply, 'echo:hi');
  ws.close();
});

test('a member cookie for one link opens no other', async () => {
  const fresh = N.loadNetwork();
  const at = Date.now() + 60_000;
  const forOpen = S.memberCookie(fresh, { name: 'open', host: HOST, sub: phone.id, expiresAt: at });
  assert.equal(S.checkMemberCookie(fresh, forOpen, { name: 'secret', host: HOST }), null);
  assert.equal(S.checkMemberCookie(fresh, forOpen, { name: 'open', host: 'x.test' }), null);
  assert.equal(S.checkMemberCookie(fresh, forOpen, { name: 'open', host: HOST }), phone.id);
  // A pass is not a cookie, nor a cookie a pass: different labels.
  const pass = S.mintShareGrant(fresh, { name: 'open', host: HOST, sub: phone.id });
  assert.equal(S.checkMemberCookie(fresh, pass, { name: 'open', host: HOST }), null);
  assert.equal(S.checkShareGrant(fresh, forOpen, { name: 'open', host: HOST }), null);
  // Neither is a device token anywhere.
  assert.equal(N.authenticate(fresh, pass), null);
});

test('a machine shows private links only to hubs that keep them private', async (t) => {
  const d = new Daemon({ name: 'privatebox', port: PORT + 1, advertiseLan: false });
  t.after(() => d.stop());
  assert.throws(() => shares.addShare({ name: 'both', port: APP, password: 'pw', private: true }), /no password/);
  await d.dispatch(M.SHARE_ADD, { name: 'mine', port: APP, private: true });
  await d.dispatch(M.SHARE_ADD, { name: 'pub', port: APP });

  // An older hub asks without `members`: it would not know the flag.
  const old = await d.dispatch(M.SHARE_LIST, { forHub: true });
  assert.deepEqual(old.shares.map((s) => s.name), ['pub']);
  const current = await d.dispatch(M.SHARE_LIST, { forHub: true, members: true });
  assert.deepEqual(current.shares.map((s) => [s.name, !!s.private]), [['mine', true], ['pub', false]]);
  const member = await d.dispatch(M.SHARE_LIST, {}, 'phone-id');
  assert.ok(member.features.includes('private'));
  assert.equal(member.shares.find((s) => s.name === 'mine').private, true);

  // A private link's port is tunnel-able, like any shared one.
  const sent = [];
  await d.onFrame({ id: 'hub', send: (tt, extra) => sent.push({ t: tt, ...extra }) }, { t: T.TUNNEL_OPEN, sid: 'p1', port: APP });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(sent.some((f) => f.t === T.TUNNEL_READY));
  shares.removeShare('mine'); shares.removeShare('pub');
});

test('helm forward carries a local port to the machine, and only to shared ports', async (t) => {
  const hubs = [`http://127.0.0.1:${PORT}`];
  const fwd = await startForward(N.loadNetwork(), { target: MACHINE, port: APP, localPort: 0, hubs });
  t.after(() => fwd.close());
  for (let i = 0; i < 3; i++) {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: fwd.port, path: `/via-forward/${i}`, agent: false }, (res) => {
        let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    assert.equal(JSON.parse(body).url, `/via-forward/${i}`);
  }

  // A port the machine never shared: refused there, and said so here.
  let refused = null;
  const no = await startForward(N.loadNetwork(), { target: MACHINE, port: 1, localPort: 0, hubs, onRefused: (e) => { refused = e; } });
  t.after(() => no.close());
  const closed = await new Promise((resolve) => {
    const s = tcpConnect({ host: '127.0.0.1', port: no.port });
    s.on('close', () => resolve(true)); s.on('error', () => {});
    s.write('GET / HTTP/1.1\r\n\r\n');
  });
  assert.ok(closed);
  assert.match(refused?.message ?? '', /port not allowed/);
});

test('helm forward lets a tunnel go when the browser gives up early, and when it stops', async (t) => {
  // A machine slow to answer: the browser has gone before the tunnel is up.
  const SLOW = 'ee44ff55aa66';
  const slow = await fakeMachine(SLOW, [{ name: 'slow', port: APP }], { readyDelay: 150 });
  t.after(() => slow.close());
  const hubs = [`http://127.0.0.1:${PORT}`];
  const fwd = await startForward(N.loadNetwork(), { target: SLOW, port: APP, localPort: 0, hubs });
  const dial = () => new Promise((resolve) => { const s = tcpConnect({ host: '127.0.0.1', port: fwd.port }); s.on('error', () => {}); s.on('connect', () => resolve(s)); });
  for (let i = 0; i < 3; i++) (await dial()).destroy();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(slow.tunnels.size, 0, 'tunnels left open by browsers that gave up');

  // A live one is cut when the forward stops (Ctrl+C), not left to the far app.
  const s = await dial();
  s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  await new Promise((r) => s.once('data', r));
  assert.equal(slow.tunnels.size, 1);
  await fwd.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(slow.tunnels.size, 0, 'tunnel left open after close');
});

test('helm forward lets each tunnel go when the browser finishes first', async (t) => {
  // The app keeps its connection open (HTTP/1.1); the browser is the one to
  // close once it has the page. Nobody answers that close, so a bridge that
  // waited for one held a hub socket open per page load, forever.
  let open = 0;
  const counted = (...args) => { open++; return bridge(...args).finally(() => { open--; }); };
  const fwd = await startForward(N.loadNetwork(), { target: MACHINE, port: APP, localPort: 0, hubs: [`http://127.0.0.1:${PORT}`], open: counted });
  t.after(() => fwd.close());
  for (let i = 0; i < 3; i++) {
    const s = tcpConnect({ host: '127.0.0.1', port: fwd.port });
    s.on('error', () => {});
    s.write(`GET /first-${i} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await new Promise((r) => s.once('data', r));
    s.end();
  }
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(open, 0, 'tunnels still open after the browser finished');
});

test('a landing path never carries what a Location header cannot', () => {
  assert.equal(S.safeSharePath('/inside?a=1'), '/inside?a=1');
  for (const bad of ['//evil', '/\\evil', '/x\r\nSet-Cookie: a=b', '/x\u0001y', 'https://evil', '']) assert.equal(S.safeSharePath(bad), '/');
});

test('helm forward takes the next free port unless one was asked for', async (t) => {
  const busy = createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  t.after(() => busy.close());
  const taken = busy.address().port;
  const fwd = await startForward(N.loadNetwork(), { target: MACHINE, port: APP, localPort: taken, hubs: [], open: bridge });
  t.after(() => fwd.close());
  assert.ok(fwd.port > taken && fwd.port <= taken + 20);
  await assert.rejects(() => startForward(N.loadNetwork(), { target: MACHINE, port: APP, localPort: taken, exact: true, hubs: [] }), { code: 'EADDRINUSE' });
});

/** A machine on the hub: answers share.list, dials only its shared ports. */
async function fakeMachine(id, list, { readyDelay = 0 } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/helm/ws?name=sharer`, {
    headers: { authorization: `Bearer ${mintToken(net.key, { net: net.id, sub: id, role: 'machine' })}` },
  });
  const tunnels = new Map();
  const send = (o) => ws.send(JSON.stringify(o));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === T.RPC) {
      const visible = msg.method === 'share.list' && msg.params?.members ? list : list.filter((s) => !s.private);
      send({ t: T.RPC_RESULT, id: msg.id, ok: true, result: msg.method === 'share.list' ? { shares: visible } : {} });
    } else if (msg.t === T.TUNNEL_OPEN) {
      if (!list.some((s) => s.port === msg.port)) return send({ t: T.TUNNEL_CLOSE, sid: msg.sid, reason: 'port not allowed' });
      const sock = tcpConnect({ host: '127.0.0.1', port: msg.port });
      tunnels.set(msg.sid, sock);
      sock.on('connect', () => setTimeout(() => send({ t: T.TUNNEL_READY, sid: msg.sid }), readyDelay));
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
  ws.tunnels = tunnels;
  return ws;
}
