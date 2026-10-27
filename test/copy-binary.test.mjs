import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import WebSocket from 'ws';

const root = mkdtempSync(join(tmpdir(), 'helm-copy-binary-'));
Object.assign(process.env, { HELM_DIR: join(root, 'helm'), HELM_DB: join(root, 'hub.sqlite'), HELM_SSH_DIR: join(root, 'ssh'), HELM_NO_SERVICE: '1' });
const N = await import('../packages/protocol/network.js');
await import('./fixtures/loopback-rtc.mjs');
const { PeerHub } = await import('../packages/connect/src/peer.js');
const { directPeer } = await import('../packages/connect/src/direct-rpc.js');
const { cleanup } = await import('node-datachannel');
const { createWsLayer } = await import('../apps/relay/src/ws.js');
const { CopyReceiver } = await import('../packages/connect/src/copy-transport.js');
const { copyProxy } = await import('../packages/connect/src/copy-proxy.js');
const { codeKeyInfo, codeSigningInfo } = await import('../packages/connect/src/code-transfer.js');
const { encodeTunnelFrame, decodeTunnelFrame } = await import('../packages/protocol/tunnel-frame.js');
test.after(() => { cleanup(); rmSync(root, { recursive: true, force: true }); });

async function transfer(t, { sourceBinary = true, targetBinary = true, oldTarget = false, direct = false } = {}) {
  const net = N.createNetwork({ name: 'source' });
  const keys = { ...codeSigningInfo(), codePubkey: codeKeyInfo().codePubkey };
  net.machines[net.self] = { ...net.machines[net.self], ...keys };
  net.machines.bb22 = { id: 'bb22', name: 'target', endpoints: [], ...keys };
  N.saveNetwork(net);
  const receiver = new CopyReceiver({ network: () => ({ ...net, self: 'bb22' }), spawnProcess: () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, done) { child.stdout.write(chunk, done); },
      final(done) { child.stdout.end(); child.exitCode = 0; done(); setImmediate(() => child.emit('close', 0, null)); },
    });
    child.kill = () => { child.exitCode = 1; setImmediate(() => child.emit('close', 1, null)); };
    setImmediate(() => child.emit('spawn'));
    return child;
  } });
  const layer = createWsLayer(), server = createServer();
  const counts = { sourceBinary: 0, targetBinary: 0, sourceDataBytes: 0, targetDataBytes: 0, directBinary: 0 };
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const target = url.searchParams.get('testTarget') === '1';
    if (!target && !sourceBinary) { url.searchParams.delete('binaryTunnel'); req.url = url.pathname + url.search; }
    const auth = target ? { role: 'env', env: net.machines.bb22, info: {} } : { role: 'client', sub: net.self, machine: true };
    layer.wss.handleUpgrade(req, socket, head, ws => {
      const send = ws.send.bind(ws);
      ws.send = (data, ...args) => {
        const frame = decodeTunnelFrame(data);
        if (frame?.t === 'tunnel.data') {
          counts[target ? 'targetDataBytes' : 'sourceDataBytes'] += Buffer.byteLength(data);
          if (Buffer.isBuffer(data)) counts[target ? 'targetBinary' : 'sourceBinary']++;
        }
        return send(data, ...args);
      };
      layer.wss.emit('connection', ws, req, auth);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  net.port = server.address().port; N.saveNetwork(net);
  const target = new WebSocket(`ws://127.0.0.1:${net.port}/ws?testTarget=1${targetBinary ? '&binaryTunnel=1' : ''}`);
  let targetWelcome;
  const welcomed = new Promise(resolve => { targetWelcome = resolve; });
  let binary = false;
  const link = { id: 'target', send(type, fields) { target.send(encodeTunnelFrame({ t: type, ...fields }, binary)); } };
  const peers = new PeerHub((peer, payload) => link.send('signal', { peer, payload }), async () => ({}), {
    onTunnel: (transport, frame, caller) => receiver.handle(transport, frame, caller),
    onTunnelClose: transport => receiver.dropLink(transport),
  });
  target.on('message', raw => {
    const frame = decodeTunnelFrame(raw);
    if (frame.t === 'welcome') { binary = frame.binaryTunnel === 1; targetWelcome(); return; }
    if (frame.t === 'signal') { void peers.signal(frame.peer, frame.payload, link, frame.device); return; }
    if (oldTarget && frame.copy) delete frame.copy.codec;
    receiver.handle(link, frame, frame.caller ?? net.self);
  });
  await welcomed;
  t.after(async () => {
    peers.stop(); target.terminate(); await receiver.stop(); layer.stop();
    for (const socket of layer.wss.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => layer.wss.close(resolve));
  });
  const payload = Buffer.concat([Buffer.from('rsync\0.\0/tmp/fixture-copy/\0\0'), randomBytes(2 * 1024 * 1024 + 173)]), input = new PassThrough(), output = [];
  input.end(payload);
  const notices = [];
  const result = await copyProxy(['--machine', 'bb22', '--target-folder', '/tmp/fixture-copy', direct ? '--direct' : '--relay', '--', 'bb22', 'rsync', '--server', '-slogDtpre.iLsfxCIvu'], {
    network: net, input, output: new Writable({ write(bytes, _encoding, done) { output.push(Buffer.from(bytes)); done(); } }),
    stderr: { write(text) { notices.push(text); } }, credential: async () => 'private-test', readyTimeout: 5000, connectBudget: 10000,
    peer: options => {
      const peer = directPeer(options), send = peer.send.bind(peer);
      peer.send = frame => { if (frame.t === 'tunnel.data' && Buffer.isBuffer(frame.data)) counts.directBinary++; return send(frame); };
      return peer;
    },
  });
  assert.equal(result, 0, notices.join(''));
  assert.deepEqual(Buffer.concat(output), payload);
  if (direct) assert.match(notices.join(''), /Direct WebRTC/);
  return { counts, bytes: payload.length };
}

test('encrypted copy crosses a real relay with binary frames in both directions', { timeout: 10000 }, async t => {
  const { counts, bytes } = await transfer(t);
  assert.ok(counts.sourceBinary > 0 && counts.targetBinary > 0);
  assert.ok(counts.sourceDataBytes < bytes * 1.03, JSON.stringify(counts));
  assert.ok(counts.targetDataBytes < bytes * 1.03, JSON.stringify(counts));
});

test('encrypted copy crosses a real data channel with binary fragmentation', { timeout: 15000 }, async t => {
  const { counts } = await transfer(t, { direct: true });
  assert.ok(counts.directBinary > 0);
  assert.equal(counts.sourceDataBytes + counts.targetDataBytes, 0, 'copy bytes bypass the relay');
});

for (const hop of ['source', 'target']) test(`binary copy falls back to text on an older ${hop} hop`, { timeout: 10000 }, async t => {
  const { counts } = await transfer(t, { sourceBinary: hop !== 'source', targetBinary: hop !== 'target' });
  assert.equal(counts[hop + 'Binary'], 0);
});

test('a receiver without codec selection keeps the original signed copy format', { timeout: 10000 }, async t => {
  const { counts, bytes } = await transfer(t, { oldTarget: true });
  assert.equal(counts.sourceBinary + counts.targetBinary, 0);
  assert.ok(counts.sourceDataBytes > bytes * 1.7, JSON.stringify(counts));
});
