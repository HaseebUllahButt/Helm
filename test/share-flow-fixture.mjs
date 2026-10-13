import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';

// Set all paths before importing anything that can read Helm state.
const root = mkdtempSync(join(tmpdir(), 'helm-share-flow-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_PROCS_SOCKET = join(root, 'procs.sock');
process.env.HELM_TERMINALS_SOCKET = join(root, 'terminals.sock');
process.env.HELM_NATIVE_SOCKET = join(root, 'native.sock');
process.env.HELM_SHARE_DOMAIN = 'links.test';
const repo = process.env.HELM_FLOW_REPO || resolve(import.meta.dirname, '..');
const source = path => import(pathToFileURL(join(repo, path)).href);
const { createWsLayer } = await source('apps/relay/src/ws.js');
const { Daemon } = await source('packages/connect/src/agent.js');
const { createShareRoute } = await source('apps/relay/src/share.js');
const { createNetwork } = await import('@helm/protocol/network');
const { T } = await import('@helm/protocol');
const { hasActiveTransfers } = await import('@helm/protocol/transfer-activity');
createNetwork({ name: 'flow-test', port: 0 });
export { T, hasActiveTransfers };
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, timeout = 3000) {
  const start = Date.now();
  while (!check()) { assert.ok(Date.now() - start < timeout, 'condition timed out'); await sleep(5); }
}
export function cleanupState() { rmSync(root, { recursive: true, force: true }); }

export async function setup({ legacy = false, bytes = 12 * 1024 * 1024, uploadDelay = 0 } = {}) {
  const appSockets = new Set(), streams = new Set();
  const metrics = { sent: 0, uploaded: 0, peakDownloadCredit: 0, peakUploadCredit: 0,
    peakBuffered: 0, peakReadable: 0, produced: 0, opens: 0, closes: 0, hubCloses: 0, readyFlow: undefined };
  const chunk = Buffer.alloc(64 * 1024, 120);
  const app = http.createServer((req, res) => {
    if (req.method === 'POST') {
      req.pause();
      setTimeout(() => {
        req.on('data', c => {
          metrics.uploaded += c.length;
          assert.ok(c.every(byte => byte === 120));
          req.pause(); setTimeout(() => req.resume(), 2);
        });
        req.on('end', () => res.end(String(metrics.uploaded)));
        req.resume();
      }, uploadDelay);
      return;
    }
    res.writeHead(200, { 'content-length': bytes });
    const produce = () => {
      while (metrics.produced < bytes && !res.destroyed) {
        const size = Math.min(chunk.length, bytes - metrics.produced);
        metrics.produced += size;
        if (!res.write(chunk.subarray(0, size))) { res.once('drain', produce); return; }
      }
      if (!res.destroyed) res.end();
    };
    produce();
  });
  const appWs = new WebSocketServer({ server: app });
  appWs.on('connection', ws => ws.on('message', (data, binary) => ws.send(data, { binary })));
  app.on('connection', sock => { appSockets.add(sock); sock.on('close', () => appSockets.delete(sock)); });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  process.env.HELM_SSH_PORT = String(app.address().port);
  const daemon = new Daemon({ port: 18787 });
  const layer = createWsLayer();
  const share = createShareRoute({ online: layer.online,
    callEnv: async () => ({ shares: [{ name: 'flow', port: app.address().port }] }),
    openTcp: async (...args) => {
      const stream = await layer.openTcp(...args);
      streams.add(stream); stream.on('close', () => streams.delete(stream));
      return stream;
    } });
  const hub = http.createServer((req, res) => { share.route(req, res).catch(err => res.destroy(err)); });
  let target;
  hub.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
      share.upgrade(req, socket, head).catch(() => socket.destroy());
      return;
    }
    layer.wss.handleUpgrade(req, socket, head, ws => {
      target = ws;
      layer.wss.emit('connection', ws, req, { role: 'env', env: { id: 'sharer', name: 'sharer' } });
    });
  });
  await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
  const machine = new WebSocket(`ws://127.0.0.1:${hub.address().port}/ws`);
  const download = new Map(), upload = new Map();
  const observe = (msg, fromDaemon) => {
    const counts = fromDaemon ? download : upload;
    const other = fromDaemon ? upload : download;
    if (msg.t === T.TUNNEL_DATA) counts.set(msg.sid, (counts.get(msg.sid) ?? 0) + Buffer.from(msg.data, 'base64').length);
    if (msg.t === T.TUNNEL_ACK) other.set(msg.sid, (other.get(msg.sid) ?? 0) - (msg.bytes - (other.get(`${msg.sid}:ack`) ?? 0)));
    if (msg.t === T.TUNNEL_ACK) other.set(`${msg.sid}:ack`, msg.bytes);
    metrics.peakDownloadCredit = Math.max(metrics.peakDownloadCredit, ...[...download].filter(([k]) => !k.endsWith(':ack')).map(([, n]) => n));
    metrics.peakUploadCredit = Math.max(metrics.peakUploadCredit, ...[...upload].filter(([k]) => !k.endsWith(':ack')).map(([, n]) => n));
  };
  const sample = () => {
    let buffered = machine.bufferedAmount + (target?.bufferedAmount ?? 0);
    for (const stream of streams) {
      buffered += stream.readableLength + stream.writableLength;
      metrics.peakReadable = Math.max(metrics.peakReadable, stream.readableLength);
    }
    metrics.peakBuffered = Math.max(metrics.peakBuffered, buffered);
  };
  const link = { id: 'loopback', get tunnelWritable() { return machine.bufferedAmount < 256 * 1024; },
    send: (t, extra) => {
      const msg = { t, ...extra };
      if (t === T.TUNNEL_READY) metrics.readyFlow = extra.flow;
      if (t === T.TUNNEL_DATA) metrics.sent += Buffer.from(extra.data, 'base64').length;
      if (t === T.TUNNEL_CLOSE) metrics.closes++;
      observe(msg, true);
      if (machine.readyState === 1) machine.send(JSON.stringify(msg));
      sample();
    } };
  machine.on('message', raw => {
    const msg = JSON.parse(raw);
    observe(msg, false);
    if (msg.t === T.TUNNEL_OPEN) { metrics.opens++; if (legacy) delete msg.flow; }
    if (msg.t === T.TUNNEL_CLOSE) metrics.hubCloses++;
    if ([T.TUNNEL_OPEN, T.TUNNEL_DATA, T.TUNNEL_ACK, T.TUNNEL_CLOSE].includes(msg.t)) {
      daemon.onFrame(link, msg).catch(err => { throw err; });
    }
    if (msg.t === T.RPC) machine.send(JSON.stringify({ t: T.RPC_RESULT, id: msg.id, ok: true, result: 'chat still answers' }));
    sample();
  });
  machine.on('close', () => daemon.linkDown(link));
  await once(machine, 'open');
  const sampling = setInterval(sample, 1);
  const request = (options = {}) => http.request({ host: '127.0.0.1', port: hub.address().port,
    path: '/', headers: { host: 'flow.links.test' }, ...options });
  return { metrics, layer, daemon, machine, streams, appSockets, request, bytes,
    url: `ws://127.0.0.1:${hub.address().port}/live`,
    async close() {
      clearInterval(sampling);
      for (const stream of streams) stream.destroy();
      layer.stop();
      machine.terminate();
      for (const ws of layer.wss.clients) ws.terminate();
      await daemon.stop();
      for (const sock of appSockets) sock.destroy();
      for (const ws of appWs.clients) ws.terminate();
      appWs.close();
      app.closeAllConnections(); hub.closeAllConnections();
      await Promise.all([new Promise(r => app.close(r)), new Promise(r => hub.close(r))]);
      layer.wss.close(); delete process.env.HELM_SSH_PORT;
    } };
}

export async function download(fixture, { hold = 200, delay = 2 } = {}) {
  const req = fixture.request();
  req.end();
  const [res] = await once(req, 'response');
  res.pause();
  await sleep(hold);
  let received = 0;
  res.on('data', chunk => {
    assert.ok(chunk.every(byte => byte === 120));
    received += chunk.length;
    res.pause(); setTimeout(() => res.resume(), delay);
  });
  const finished = once(res, 'end');
  res.resume();
  await finished;
  assert.equal(received, fixture.bytes);
  return received;
}
