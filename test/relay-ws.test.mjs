import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-relay-ws-'));
Object.assign(process.env, { HELM_DIR: root, HELM_DB: join(root, 'hub.sqlite') });
const { createWsLayer } = await import('../apps/relay/src/ws.js');
const { hasActiveTransfers } = await import('../packages/protocol/transfer-activity.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

function socket() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}

test('a repeated tunnel id closes both ends and releases its first route', t => {
  const layer = createWsLayer(); t.after(() => layer.stop());
  const source = socket(), target = socket();
  layer.online.set('target', target);
  const open = { t: 'tunnel.open', sid: 'copy', env: 'target' };
  layer.routeTunnel(source, open);
  const firstSid = target.sent[0].sid;
  assert.equal(hasActiveTransfers(), true);
  layer.routeTunnel(source, open);
  assert.deepEqual(target.sent.at(-1), { t: 'tunnel.close', sid: firstSid, reason: 'duplicate stream id' });
  assert.equal(source.sent.at(-1).t, 'tunnel.close');
  assert.equal(source.sidMap.size, 0);
  assert.equal(source.tunnelSids.size, 0);
  assert.equal(target.tunnelSids.size, 0);
  assert.equal(hasActiveTransfers(), false);

  layer.routeTunnel(source, open);
  const nextSid = target.sent.at(-1).sid;
  layer.routeTunnel(target, { t: 'tunnel.close', sid: firstSid });
  assert.equal(source.sidMap.get('copy'), nextSid, 'late close cannot remove the next stream');
  layer.routeTunnel(source, { t: 'tunnel.close', sid: 'copy' });
  assert.equal(hasActiveTransfers(), false);
});

test('a partial machine upload gets proof of receipt before its full message arrives', async t => {
  const { WebSocket, WebSocketServer } = await import('ws');
  const { once } = await import('node:events');
  let checkProgress;
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (fn, ms, ...args) => {
    if (ms === 5000) { checkProgress = fn; return { unref() {} }; }
    return interval(fn, ms, ...args);
  });
  const layer = createWsLayer(); t.after(() => layer.stop());
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const [peer] = await connected;
  await once(client, 'open');
  t.after(async () => { client.terminate(); peer.terminate(); await new Promise(resolve => server.close(resolve)); });
  peer.progressBytes = peer._socket.bytesRead;
  peer.isAlive = false;
  layer.online.set('machine', peer);
  let complete = false;
  peer.on('message', () => { complete = true; });
  const received = once(peer._socket, 'data');
  client.send('{"t":"large",', { fin: false }); await received;
  const proof = once(client, 'ping');
  checkProgress(); await proof;
  assert.equal(complete, false);
  assert.equal(peer.isAlive, true);
  peer.isAlive = false;
  checkProgress();
  assert.equal(peer.isAlive, false, 'a stopped upload does not extend liveness');
  const finished = once(peer, 'message');
  client.send('"done":true}', { fin: true }); await finished;
  assert.equal(complete, true);
});

async function hubFixture(t) {
  const { default: WebSocket } = await import('ws');
  const { createServer } = await import('node:http');
  const N = await import('../packages/protocol/network.js');
  const net = N.createNetwork({ name: 'hub' });
  for (const id of ['m1', 'm2', 'otherhub']) net.machines[id] = { id, name: id, endpoints: [] };
  N.saveNetwork(net);
  const layer = createWsLayer();
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const env = new URL(req.url, 'http://hub').searchParams.get('env');
    const auth = env ? { role: 'env', env: net.machines[env], info: {} } : { role: 'client', sub: net.self };
    layer.wss.handleUpgrade(req, socket, head, ws => layer.wss.emit('connection', ws, req, auth));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    layer.stop();
    await new Promise(resolve => server.close(resolve));
  });
  const open = async (query) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?${query}`);
    sockets.push(ws);
    const frames = [];
    ws.on('message', raw => frames.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const until = async (match) => {
      while (!frames.some(match)) await new Promise(resolve => setImmediate(resolve));
      return frames.find(match);
    };
    // Frames are ordered: once this pong is back, everything sent before it is here.
    const settled = async () => {
      const seen = frames.filter(frame => frame.t === 'pong').length;
      ws.send(JSON.stringify({ t: 'ping' }));
      await until(() => frames.filter(frame => frame.t === 'pong').length > seen);
    };
    const send = frame => ws.send(JSON.stringify(frame));
    await until(frame => frame.t === 'welcome');
    return { ws, frames, until, settled, send };
  };
  return { layer, open };
}

const joinPieces = pieces => JSON.parse(pieces.map(piece => piece.data).join(''));

test('a client that asks gets large frames as ordered pieces; other clients get them whole', async t => {
  const { open } = await hubFixture(t);
  const machine = await open('env=m1');
  const chunked = await open('chunks=1');
  const whole = await open('');
  assert.equal(chunked.frames[0].chunks, 1, 'the welcome says pieces will come');
  assert.equal('chunks' in whole.frames[0], false);
  for (const client of [chunked, whole]) { client.send({ t: 'subscribe', env: 'm1' }); await client.settled(); }

  chunked.send({ t: 'rpc', id: 'r1', env: 'm1', method: 'session.events', params: {} });
  const asked = await machine.until(frame => frame.t === 'rpc');
  machine.send({ t: 'rpcResult', id: asked.id, ok: true, result: 'x'.repeat(50_000) });
  await chunked.until(frame => frame.t === 'dc-chunk' && frame.i === frame.n - 1);
  const pieces = chunked.frames.filter(frame => frame.t === 'dc-chunk');
  assert.deepEqual(pieces.map(piece => piece.i), [0, 1, 2, 3]);
  assert.ok(pieces.every(piece => piece.rid === 'r1' && piece.gid === pieces[0].gid && piece.data.length <= 16_000));
  const reply = joinPieces(pieces);
  assert.equal(reply.t, 'rpcResult');
  assert.equal(reply.id, 'r1');
  assert.equal(reply.result.length, 50_000);

  machine.send({ t: 'event', kind: 'session.update', payload: { session: { id: 'c', title: 'y'.repeat(40_000) } } });
  const event = await whole.until(frame => frame.t === 'event');
  assert.equal(event.payload.session.title.length, 40_000, 'an old client still gets one whole frame');
  await chunked.until(frame => frame.t === 'dc-chunk' && frame.gid !== pieces[0].gid && frame.i === frame.n - 1);
  const eventPieces = chunked.frames.filter(frame => frame.t === 'dc-chunk' && frame.gid !== pieces[0].gid);
  assert.ok(eventPieces.every(piece => !('rid' in piece)), 'events name no request');
  assert.equal(joinPieces(eventPieces).payload.session.title.length, 40_000);
  machine.send({ t: 'event', kind: 'session.update', payload: { session: { id: 'small' } } });
  assert.equal((await chunked.until(frame => frame.t === 'event')).payload.session.id, 'small', 'small frames stay whole');
});

test('a machine that asks hears whether a browser or another hub watches it', async t => {
  const { open } = await hubFixture(t);
  const machine = await open('env=m1&watched=1');
  const watched = () => machine.frames.filter(frame => frame.t === 'watched').map(frame => frame.on);
  await machine.until(frame => frame.t === 'watched');
  assert.deepEqual(watched(), [false], 'nobody watches a machine that just came');

  const browser = await open('');
  browser.send({ t: 'subscribe', env: 'm1' }); await browser.settled(); await machine.settled();
  assert.deepEqual(watched(), [false, true]);
  browser.send({ t: 'subscribe', env: 'm1' }); await browser.settled(); await machine.settled();
  assert.deepEqual(watched(), [false, true], 'no news, no frame');
  browser.send({ t: 'unsubscribe', env: 'm1' }); await browser.settled(); await machine.settled();
  assert.deepEqual(watched(), [false, true, false]);

  const otherHub = await open('env=otherhub');
  otherHub.send({ t: 'hubWatch', envs: ['m1'] }); await otherHub.settled(); await machine.settled();
  assert.deepEqual(watched(), [false, true, false, true], 'a distant browser behind another hub counts');
  otherHub.ws.close();
  await machine.until(() => watched().length === 5);
  assert.deepEqual(watched(), [false, true, false, true, false]);

  browser.send({ t: 'subscribe', env: 'm1' }); await browser.settled(); await machine.settled();
  browser.ws.close();
  await machine.until(() => watched().length === 7);
  assert.equal(watched().at(-1), false, 'a closed browser stops watching');

  const older = await open('env=m2');
  const viewer = await open('');
  viewer.send({ t: 'subscribe', env: 'm2' }); await viewer.settled(); await older.settled();
  assert.equal(older.frames.some(frame => frame.t === 'watched'), false, 'a machine that did not ask hears nothing new');
});

test('other hubs are asked only for machines that are not attached here', async t => {
  const { layer, open } = await hubFixture(t);
  const asked = [];
  layer.attachMesh({ watch: envs => asked.push([...envs]), machines: () => new Map(), forgetPeer() {} });
  const browser = await open('');
  browser.send({ t: 'subscribe', env: 'm1' }); await browser.settled();
  assert.deepEqual(asked.at(-1), ['m1']);
  const machine = await open('env=m1');
  await machine.settled();
  assert.deepEqual(asked.at(-1), [], 'its own socket brings its events');
  machine.ws.close();
  while (!asked.at(-1).includes('m1')) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(asked.at(-1), ['m1'], 'other hubs are asked again once it leaves');
});
