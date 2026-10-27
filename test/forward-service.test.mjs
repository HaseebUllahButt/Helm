import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { WebSocket } from 'ws';

/**
 * `helm forward`, kept by the Helm service (src/forwards.js).
 *
 * A real hub, a real app that refuses any host that is not local (like the
 * owner's Express dev server), and a stand-in source machine on the hub that
 * terminates tunnels only to the ports it forwards, as agent.js does. The
 * `in` half runs here for real: listeners, 502 pages, restarts, expiry and
 * the note to the other machine.
 */

const base = mkdtempSync(join(tmpdir(), 'helm-forward-'));
process.env.HELM_DIR = join(base, 'helm');
process.env.HELM_DB = join(base, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(base, 'ssh');
process.env.HELM_NO_SERVICE = '1';
delete process.env.INVOCATION_ID;

const N = await import('@helm/protocol/network');
const { mintToken } = await import('@helm/protocol/identity');
const { M, T } = await import('@helm/protocol');
const { ownerSeenAt, resetOwnerSeen } = await import('@helm/protocol/owner-seen');
const { startRelay } = await import('@helm/relay');
const { Daemon } = await import('../packages/connect/src/agent.js');
const { Forwards, forwardedPorts } = await import('../packages/connect/src/forwards.js');

const PORT = 18797;
const HUB = `http://127.0.0.1:${PORT}`;
const SOURCE = 'ab12cd34ef56';
let net = N.createNetwork({ name: 'here', port: PORT });
net.machines[SOURCE] = { id: SOURCE, name: 'Laptop', endpoints: [], addedAt: 1, updatedAt: 1 };
N.saveNetwork(net);
net = N.loadNetwork();
const hub = await startRelay({ port: PORT, dbFile: process.env.HELM_DB, host: '127.0.0.1' });

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
let appPort = 0;
/** The owner's kind of dev server: "Invalid host" for any other host. */
async function startApp(port = 0) {
  const app = http.createServer((req, res) => {
    const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
    if (!hosts.every((h) => LOCAL.test(h))) { res.writeHead(400); res.end('Invalid host'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`app saw ${req.url}`);
  });
  await new Promise((r) => app.listen(port, '127.0.0.1', r));
  appPort = app.address().port;
  return app;
}
let app = await startApp();
const APP = appPort;

/** The machine with the app: a forward's `out` half allows its port. */
const allowed = new Set([APP]);
const outHalves = new Set();
const source = await fakeMachine(SOURCE);

test.after(() => { source.close(); app.close(); hub.stop(); rmSync(base, { recursive: true, force: true }); });

const network = () => N.loadNetwork();
const told = [];
const rpc = async (env, method, params) => {
  told.push({ env, method, params });
  return { forwards: [...outHalves].map((id) => ({ id })) };
};
const make = (o = {}) => new Forwards({ network, rpc, ...o });

function get(port, path = '/', headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, agent: false, headers }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }).on('error', reject);
  });
}

/** Wait for a state, not a time. */
async function until(check, what = 'state') {
  for (let i = 0; i < 400; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const fileRows = () => existsSync(join(process.env.HELM_DIR, 'forwards.json'))
  ? JSON.parse(readFileSync(join(process.env.HELM_DIR, 'forwards.json'), 'utf8')).forwards : [];

test('a forward opens the app on localhost, as a local visit, without a share', async (t) => {
  const f = make();
  t.after(() => f.stop());
  outHalves.add('a1a1a1a1');
  const fwd = await f.add({ id: 'a1a1a1a1', side: 'in', peer: SOURCE, port: APP, localPort: 0 });
  assert.equal(fwd.listening, true);
  assert.equal(fwd.peerName, 'Laptop');
  const r = await get(fwd.localPort, '/page', { host: `localhost:${fwd.localPort}` });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.text, 'app saw /page');
  await f.remove('a1a1a1a1');
  outHalves.delete('a1a1a1a1');
});

test('a stopped app gives a clear 502 page, and the next load works once it is back', async (t) => {
  const f = make();
  t.after(() => f.stop());
  outHalves.add('b2b2b2b2');
  const { localPort } = await f.add({ id: 'b2b2b2b2', side: 'in', peer: SOURCE, port: APP, localPort: 0 });
  assert.equal((await get(localPort)).status, 200);

  await new Promise((r) => app.close(r));
  app.closeAllConnections?.();
  const down = await get(localPort, '/again');
  assert.equal(down.status, 502);
  assert.equal(down.headers['x-helm-forward'], 'app');
  assert.equal(down.headers.refresh, '3');
  assert.match(down.text, new RegExp(`Laptop, port ${APP}: not reachable`));
  assert.match(down.text, new RegExp(`Nothing runs on port ${APP} on Laptop`));

  app = await startApp(APP);
  const back = await get(localPort, '/back');
  assert.equal(back.status, 200);
  assert.equal(back.text, 'app saw /back');
  await f.remove('b2b2b2b2');
  outHalves.delete('b2b2b2b2');
});

test('a machine that cannot be reached gives a 502 page that names it, never an empty answer', async (t) => {
  const f = make();
  t.after(() => f.stop());
  const AWAY = 'ffee11223344';
  const n = N.loadNetwork();
  n.machines[AWAY] = { id: AWAY, name: 'Sleepy', endpoints: [], addedAt: 1, updatedAt: 1 };
  N.saveNetwork(n);
  const { localPort } = await f.add({ id: 'c3c3c3c3', side: 'in', peer: AWAY, port: 4321, localPort: 0 });
  const r = await get(localPort);
  assert.equal(r.status, 502);
  assert.equal(r.headers['x-helm-forward'], 'unreachable');
  assert.match(r.text, /Helm cannot reach Sleepy now/);

  // Not a browser: closed, with nothing made up.
  const closed = await new Promise((resolve) => {
    const s = tcpConnect({ host: '127.0.0.1', port: localPort });
    let got = '';
    s.on('data', (c) => { got += c; });
    s.on('close', () => resolve(got));
    s.on('error', () => {});
    s.write('\x16\x03\x01 not http\n');
  });
  assert.equal(closed, '');
  await f.remove('c3c3c3c3');
});

test('a forward stopped on the other machine goes here too, after a refusal', async (t) => {
  const f = make();
  t.after(() => f.stop());
  allowed.add(APP);
  const { localPort } = await f.add({ id: 'd4d4d4d4', side: 'in', peer: SOURCE, port: APP, localPort: 0 });
  // Laptop dropped its half while this machine was away.
  allowed.delete(APP);
  const r = await get(localPort);
  assert.equal(r.status, 502);
  assert.equal(r.headers['x-helm-forward'], 'refused');
  assert.match(r.text, /Laptop does not open port/);
  await until(() => !fileRows().some((x) => x.id === 'd4d4d4d4'), 'the half to go');
  await until(async () => (await get(localPort).then(() => false, (e) => e.code === 'ECONNREFUSED')), 'the listener to close');
  allowed.add(APP);
});

test('a forward comes back on the same port after Helm restarts', async () => {
  const first = make();
  outHalves.add('e5e5e5e5');
  const { localPort } = await first.add({ id: 'e5e5e5e5', side: 'in', peer: SOURCE, port: APP, localPort: 0 });
  await first.stop();
  await assert.rejects(get(localPort), { code: 'ECONNREFUSED' });

  const again = make();
  await again.begin();
  const [row] = again.list().filter((x) => x.id === 'e5e5e5e5');
  assert.equal(row.localPort, localPort);
  assert.equal(row.listening, true);
  assert.equal((await get(localPort, '/after-restart')).text, 'app saw /after-restart');
  await again.remove('e5e5e5e5');
  await again.stop();
  outHalves.delete('e5e5e5e5');
});

test('a forward ends at its time on its own; a kept one stays', async (t) => {
  const f = make();
  t.after(() => f.stop());
  const { localPort } = await f.add({ id: 'f6f6f6f6', side: 'in', peer: SOURCE, port: APP, localPort: 0, expiresAt: Date.now() + 300 });
  const kept = await f.add({ id: 'a7a7a7a7', side: 'in', peer: SOURCE, port: 9, localPort: 0 });
  assert.equal(kept.expiresAt, undefined);
  await until(() => !fileRows().some((x) => x.id === 'f6f6f6f6'), 'the forward to end');
  await assert.rejects(get(localPort), { code: 'ECONNREFUSED' });
  assert.ok(f.list().some((x) => x.id === 'a7a7a7a7'));
  await assert.rejects(() => f.add({ id: 'b8b8b8b8', side: 'in', peer: SOURCE, port: APP, expiresAt: Date.now() - 1 }), /already ended/);
  await f.remove('a7a7a7a7');
});

test('a stop tells the other machine, and keeps trying while it is away', async (t) => {
  let away = true;
  const calls = [];
  const f = make({
    retryMs: 50,
    rpc: async (env, method, params) => {
      calls.push({ env, method, params });
      if (away) throw new Error('could not reach that machine through any hub');
      return { removed: true };
    },
  });
  t.after(() => f.stop());
  await f.add({ id: 'c9c9c9c9', side: 'out', peer: SOURCE, port: APP });
  assert.ok(forwardedPorts().includes(APP));
  const r = await f.remove('c9c9c9c9', { notify: true });
  assert.equal(r.removed, true);
  assert.ok(!forwardedPorts().includes(APP), 'the port closes at once');
  await until(() => calls.length >= 2, 'a second try');
  away = false;
  await until(() => !JSON.parse(readFileSync(join(process.env.HELM_DIR, 'forwards.json'), 'utf8')).pending.length, 'the note to go');
  const last = calls.at(-1);
  assert.deepEqual([last.env, last.method, last.params], [SOURCE, M.FORWARD_REMOVE, { id: 'c9c9c9c9' }]);
});

test('the same port forwarded again replaces the old one and keeps its local port', async (t) => {
  const f = make();
  t.after(() => f.stop());
  outHalves.add('d0d0d0d0').add('e1e1e1e1');
  const one = await f.add({ id: 'd0d0d0d0', side: 'in', peer: SOURCE, port: APP, localPort: 0 });
  const two = await f.add({ id: 'e1e1e1e1', side: 'in', peer: SOURCE, port: APP });
  assert.equal(two.localPort, one.localPort);
  assert.deepEqual(f.list().map((x) => x.id), ['e1e1e1e1']);
  assert.equal((await get(two.localPort)).status, 200);
  await f.remove('e1e1e1e1');
});

test('the service lets forwarded ports through, lists forwards and says where the owner was', async (t) => {
  const d = new Daemon({ name: 'here', port: PORT + 1, advertiseLan: false });
  t.after(() => d.stop());
  await d.dispatch(M.FORWARD_ADD, { id: 'aa00aa00', side: 'out', peer: SOURCE, port: APP });
  const sent = [];
  await d.onFrame({ id: 'hub', send: (tt, extra) => sent.push({ t: tt, ...extra }) }, { t: T.TUNNEL_OPEN, sid: 'f1', port: APP });
  await until(() => sent.some((x) => x.t === T.TUNNEL_READY), 'the tunnel');
  const listed = await d.dispatch(M.FORWARD_LIST, {});
  assert.deepEqual(listed.forwards.map((x) => [x.id, x.side, x.peerName]), [['aa00aa00', 'out', 'Laptop']]);
  assert.ok(listed.features.includes('forward'));
  await d.dispatch(M.FORWARD_REMOVE, { id: 'aa00aa00' });
  const after = [];
  await d.onFrame({ id: 'hub', send: (tt, extra) => after.push({ t: tt, ...extra }) }, { t: T.TUNNEL_OPEN, sid: 'f2', port: APP });
  assert.deepEqual(after.map((x) => [x.t, x.reason]), [[T.TUNNEL_CLOSE, 'port not allowed']]);
  await assert.rejects(() => d.dispatch(M.FORWARD_ADD, { id: 'bb00bb00', side: 'in', peer: 'nobody', port: 80 }), /not in this network/);
});

test('the hub notes the owner only for the app on this machine, not agents or Caddy', async () => {
  resetOwnerSeen();
  const device = N.issueDevice(N.loadNetwork(), 'browser here');
  const machineToken = mintToken(net.key, { net: net.id, sub: net.self, role: 'machine' });
  const call = async (token, headers = {}, { asProtocol = true } = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/helm/ws${asProtocol ? '' : '?role=client'}`, asProtocol ? ['helm', token] : [], {
      headers: { ...headers, ...(asProtocol ? {} : { authorization: `Bearer ${token}` }) },
    });
    await new Promise((resolve, reject) => {
      ws.on('message', (raw) => { if (JSON.parse(raw).t === T.WELCOME) resolve(); });
      ws.on('error', reject);
      ws.on('unexpected-response', (_q, res) => reject(new Error(`hub answered ${res.statusCode}`)));
    });
    ws.send(JSON.stringify({ t: T.RPC, id: 'r1', env: SOURCE, method: 'session.input', params: { id: 'x', data: 'hi' } }));
    await new Promise((resolve) => ws.on('message', (raw) => { if (JSON.parse(raw).t === T.RPC_RESULT) resolve(); }));
    ws.close();
  };
  await call(machineToken, {}, { asProtocol: false });
  assert.equal(ownerSeenAt(), null, 'an agent on this machine is not the owner');
  await call(device.token, { host: 'home.example', 'x-forwarded-for': '1.2.3.4' });
  assert.equal(ownerSeenAt(), null, 'a visit through Caddy is not at this machine');
  const before = Date.now();
  await call(device.token);
  assert.ok(ownerSeenAt() >= before);
});

/** The source machine: forward.list, and tunnels only to allowed ports. */
async function fakeMachine(id) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/helm/ws?name=Laptop`, {
    headers: { authorization: `Bearer ${mintToken(net.key, { net: net.id, sub: id, role: 'machine' })}` },
  });
  const tunnels = new Map();
  const send = (o) => ws.send(JSON.stringify(o));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === T.RPC) {
      send({ t: T.RPC_RESULT, id: msg.id, ok: true, result: { forwards: [...outHalves].map((x) => ({ id: x })) } });
    } else if (msg.t === T.TUNNEL_OPEN) {
      if (!allowed.has(msg.port)) return send({ t: T.TUNNEL_CLOSE, sid: msg.sid, reason: 'port not allowed' });
      const sock = tcpConnect({ host: '127.0.0.1', port: msg.port });
      tunnels.set(msg.sid, sock);
      let ready = false;
      sock.on('connect', () => { ready = true; send({ t: T.TUNNEL_READY, sid: msg.sid }); });
      sock.on('data', (c) => send({ t: T.TUNNEL_DATA, sid: msg.sid, data: c.toString('base64') }));
      const end = (err) => {
        if (!tunnels.delete(msg.sid)) return;
        // As agent.js says it, through connectLoopback.
        send({ t: T.TUNNEL_CLOSE, sid: msg.sid, reason: !ready && err ? `Nothing answered at 127.0.0.1:${msg.port} or [::1]:${msg.port}. Start the app on port ${msg.port}, then try again.` : 'closed' });
      };
      sock.on('close', () => end());
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



test('changing a forward destination replaces its listener', async t => {
  const opened = [], closed = [];
  const f = make({ start: async (_net, options) => {
    opened.push(options);
    return { port: 45678, close: async () => { closed.push(options.port); } };
  } });
  t.after(() => f.stop());
  const id = 'eeeeeeee';
  await f.add({ id, side: 'in', peer: SOURCE, port: APP, localPort: 45678 });
  await f.add({ id, side: 'in', peer: SOURCE, port: APP + 1, localPort: 45678 });
  assert.deepEqual(opened.map(x => x.port), [APP, APP + 1]);
  assert.deepEqual(closed, [APP]);
  await f.add({ id, side: 'out', peer: SOURCE, port: APP });
  assert.deepEqual(closed, [APP, APP + 1], 'an outgoing half has no local listener');
  await f.remove(id);
});
