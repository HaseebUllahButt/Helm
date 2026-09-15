import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The home hub publishes every machine's T3 server on its own hostname: the
// bare name for itself, one port per other machine, routed on Host and
// carried to the machine over the tunnel frames it already speaks for ssh.
const dir = mkdtempSync(join(tmpdir(), 'helm-publish-'));
process.env.HELM_DIR = dir;
process.env.HELM_DB = join(dir, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_HOME_HOST = 'home.test';

const PORT = 18991;

/** A stand-in for `t3 serve`: echoes requests as JSON, echoes WebSocket frames. */
async function fakeT3(WebSocketServer) {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method, url: req.url, host: req.headers.host,
        forwardedHost: req.headers['x-forwarded-host'], body,
      }));
    });
  });
  const wss = new WebSocketServer({ server: srv, path: '/ws' });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => srv.close() };
}

test('the hub publishes each machine\'s T3 on its own port, itself on the bare host', async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { createNetwork, loadNetwork, machineToken, publishedPorts } = await import('@helm/protocol/network');
  const { mintToken, ROLE } = await import('@helm/protocol/identity');
  const { startRelay } = await import('@helm/relay');
  const { createTunnelEnd } = await import('../packages/connect/src/tunnel-end.js');
  const { T } = await import('@helm/protocol');
  const { default: WebSocket, WebSocketServer } = await import('ws');

  createNetwork({ name: 'vm', port: PORT });
  const hub = await startRelay({ port: PORT, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => { for (const s of hub.online.values()) s.terminate(); hub.server.closeAllConnections(); hub.stop(); });
  const net = loadNetwork();

  const vmT3 = await fakeT3(WebSocketServer);
  const lapT3 = await fakeT3(WebSocketServer);
  t.after(() => { vmT3.close(); lapT3.close(); });

  // The VM's own daemon attaches over loopback as itself, T3 port in tow.
  const attach = (token, query) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/helm/ws${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  const vmSock = await attach(machineToken(net), `?name=vm&role=self&info=${encodeURIComponent(JSON.stringify({ t3: { port: vmT3.port } }))}`);
  t.after(() => vmSock.close());

  // A laptop behind NAT: dials in, answers tunnel frames with the real
  // terminator, and only allows its T3 port.
  const lapToken = mintToken(net.key, { net: net.id, sub: 'aaaa1111bbbb', role: ROLE.MACHINE });
  const lapSock = await attach(lapToken, `?name=laptop&info=${encodeURIComponent(JSON.stringify({ t3: { port: lapT3.port } }))}`);
  const link = { id: 'hub', send: (kind, extra = {}) => lapSock.send(JSON.stringify({ t: kind, ...extra })) };
  const tunnels = createTunnelEnd({ allowPorts: () => [lapT3.port] });
  lapSock.on('message', (raw) => tunnels.onFrame(link, JSON.parse(raw)));
  await new Promise((r) => setTimeout(r, 150));

  const ports = publishedPorts(loadNetwork());
  const lapPort = ports.get('aaaa1111bbbb');
  assert.ok(lapPort, 'the laptop gets a published port once the hub has seen it');
  assert.notEqual(lapPort, ports.get(net.self));

  // fetch() refuses a custom Host header; plain http.request honours it.
  const get = (host, path, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, path, method, headers: { host } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data), text: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

  // Bare host -> the VM's own T3.
  let r = await get('home.test', '/anything?x=1');
  assert.equal(r.status, 200, r.text);
  let body = await r.json();
  assert.equal(body.url, '/anything?x=1');
  assert.equal(body.host, 'home.test');

  // Host:port -> the laptop's T3, through the tunnel, headers intact.
  r = await get(`home.test:${lapPort}`, '/pair', { method: 'POST', body: 'hello' });
  assert.equal(r.status, 200, r.text);
  body = await r.json();
  assert.equal(body.method, 'POST');
  assert.equal(body.body, 'hello');
  assert.equal(body.host, `home.test:${lapPort}`);
  assert.equal(body.forwardedHost, `home.test:${lapPort}`);

  // WebSocket upgrades ride the same tunnel as raw bytes.
  const echoed = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { host: `home.test:${lapPort}` } });
    ws.once('open', () => ws.send('ping'));
    ws.once('message', (m) => { resolve(String(m)); ws.close(); });
    ws.once('error', reject);
  });
  assert.equal(echoed, 'echo:ping');

  // A port nobody holds, and helm's own paths, are not proxied.
  r = await get('home.test:44399', '/');
  assert.equal(r.status, 404);
  r = await get('home.test', '/helm/api/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  r = await get(`127.0.0.1:${PORT}`, '/');
  assert.equal(r.status, 404, 'an unpublished host is helm\'s own 404');

  // The machine refuses any port it did not expose.
  const refused = await new Promise((resolve) => {
    const cli = new WebSocket(`ws://127.0.0.1:${PORT}/helm/ws?role=client`, {
      headers: { authorization: `Bearer ${machineToken(net)}` },
    });
    cli.once('open', () => cli.send(JSON.stringify({ t: T.TUNNEL_OPEN, sid: 'x1', env: 'aaaa1111bbbb', port: 9 })));
    cli.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t === T.TUNNEL_CLOSE) { resolve(msg.reason); cli.close(); }
    });
  });
  assert.equal(refused, 'port not allowed');

  // The laptop goes away: its port answers 502, not a hang.
  lapSock.close();
  await new Promise((r) => setTimeout(r, 150));
  r = await get(`home.test:${lapPort}`, '/');
  assert.equal(r.status, 502);
});
