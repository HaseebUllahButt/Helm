import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'helm-link-reconnect-'));
process.env.HELM_DIR = dir;
const { createNetwork, hubProof, hubHello } = await import('../packages/protocol/network.js');
const { Link } = await import('../packages/connect/src/agent.js');
const { hubRpc } = await import('../packages/connect/src/hub-client.js');
const net = createNetwork({ name: 'test' });
test.after(() => rmSync(dir, { recursive: true, force: true }));

async function fixture(context, firstUpgrade, linkOptions = {}) {
  let upgrades = 0;
  const sockets = new Set();
  const webSockets = new WebSocketServer({ noServer: true });
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const { nonce } = JSON.parse(text);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ net: net.id, challenge: 'test', proof: hubProof(net, nonce) }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    upgrades++;
    if (upgrades === 1 && firstUpgrade) return firstUpgrade(socket);
    webSockets.handleUpgrade(request, socket, head, connection => webSockets.emit('connection', connection));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  const daemon = { net, port: server.address().port, name: 'test', describe: async () => ({}), onLinkUp: connected, onFrame: async () => {} };
  const link = new Link(daemon, url, linkOptions);
  context.after(() => {
    link.stop();
    for (const socket of sockets) socket.destroy();
    webSockets.close(); server.close();
  });
  return { link, daemon, ready, url, webSockets, upgrades: () => upgrades };
}

test('a timed-out hub proof does not prevent the CLI from trying another known hub', async context => {
  const setup = await fixture(context, null);
  setup.webSockets.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.t === 'rpc') socket.send(JSON.stringify({ t: 'rpcResult', id: frame.id, ok: true, result: 'recovered' }));
  }));
  const post = hubHello.post;
  context.mock.method(hubHello, 'post', (url, ...rest) => {
    if (String(url).startsWith('http://127.0.0.1:1/')) {
      return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }
    return post(url, ...rest);
  });
  const network = { ...net, port: 1, machines: {
    ...net.machines, [net.self]: { ...net.machines[net.self], endpoints: [setup.url] },
  } };
  assert.equal(await hubRpc(network, 'vm', 'env.info'), 'recovered');
});

test('a network change keeps a healthy hub socket and probes it at once', async context => {
  const setup = await fixture(context, null, { recoveryTimeout: 100 });
  setup.daemon.onFrame = async (_link, frame) => { if (frame.t === 'pong') setup.link.onPong(); };
  setup.webSockets.on('connection', socket => socket.on('message', raw => {
    if (JSON.parse(raw).t === 'ping') socket.send(JSON.stringify({ t: 'pong' }));
  }));
  setup.link.start();
  await setup.ready;
  setup.link.recover();
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(setup.upgrades(), 1);
  assert.equal(setup.link.connected, true);
});

test('a stale hub path reconnects quickly after a network change and late closes cannot undo it', async context => {
  const setup = await fixture(context, null, { recoveryTimeout: 30 });
  let up = 0, down = 0;
  let recovered;
  const ready = new Promise(resolve => { recovered = resolve; });
  setup.daemon.onLinkUp = () => { if (++up === 2) recovered(); };
  setup.daemon.linkDown = () => down++;
  setup.link.start();
  while (!setup.link.connected) await new Promise(resolve => setTimeout(resolve, 5));
  setup.link.recover();
  setup.link.recover(); // repeated events do not continually postpone recovery
  await ready;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(setup.upgrades(), 2);
  assert.equal(down, 1);
  assert.equal(setup.link.connected, true);
});

test('a route change cancels a stalled hub proof and stale answers never attach twice', async context => {
  const setup = await fixture(context, null);
  const post = hubHello.post;
  let calls = 0, release;
  context.mock.method(hubHello, 'post', (...args) => {
    if (++calls === 1) return new Promise(resolve => { release = () => resolve(post(...args)); });
    return post(...args);
  });
  setup.link.start();
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  setup.link.recover();
  await setup.ready;
  release();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(setup.upgrades(), 1);
  assert.equal(setup.link.connected, true);
});

test('daemon retries rejected upgrades and transient describe failures', { timeout: 4000 }, async context => {
  const setup = await fixture(context, socket => socket.end('HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n'));
  let descriptions = 0;
  setup.daemon.describe = async () => { if (++descriptions === 1) throw new Error('starting'); return {}; };
  const started = Date.now();
  setup.link.start();
  await setup.ready;
  assert.equal(setup.link.connected, true);
  assert.equal(setup.upgrades(), 2);
  assert.ok(Date.now() - started < 2500);
});

test('a stalled daemon WebSocket handshake expires and reconnects', { timeout: 18000 }, async context => {
  const setup = await fixture(context, () => {});
  const started = Date.now();
  setup.link.start();
  await setup.ready;
  assert.equal(setup.upgrades(), 2);
  assert.equal(setup.link.connected, true);
  assert.ok(Date.now() - started < 17000);
});

test('stopping during description cannot start a new connection', async context => {
  const setup = await fixture(context, () => {});
  let release;
  setup.daemon.describe = () => new Promise(resolve => { release = resolve; });
  setup.link.start();
  setup.link.stop();
  release({});
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(setup.upgrades(), 0);
  assert.equal(setup.link.connected, false);
});
