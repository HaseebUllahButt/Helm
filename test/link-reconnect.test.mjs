import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'helm-link-reconnect-'));
process.env.HELM_DIR = dir;
const { createNetwork, hubProof } = await import('../packages/protocol/network.js');
const { Link } = await import('../packages/connect/src/agent.js');
const net = createNetwork({ name: 'test' });
test.after(() => rmSync(dir, { recursive: true, force: true }));

async function fixture(context, firstUpgrade) {
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
    if (upgrades === 1) return firstUpgrade(socket);
    webSockets.handleUpgrade(request, socket, head, connection => webSockets.emit('connection', connection));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  const daemon = { net, port: server.address().port, name: 'test', describe: async () => ({}), onLinkUp: connected, onFrame: async () => {} };
  const link = new Link(daemon, url);
  context.after(() => {
    link.stop();
    for (const socket of sockets) socket.destroy();
    webSockets.close(); server.close();
  });
  return { link, daemon, ready, upgrades: () => upgrades };
}

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

test('a stalled daemon WebSocket handshake expires and reconnects', { timeout: 8000 }, async context => {
  const setup = await fixture(context, () => {});
  const started = Date.now();
  setup.link.start();
  await setup.ready;
  assert.equal(setup.upgrades(), 2);
  assert.equal(setup.link.connected, true);
  assert.ok(Date.now() - started < 7000);
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
