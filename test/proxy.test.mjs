import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { T } from '@helm/protocol';
import { bridge } from '../packages/connect/src/proxy.js';
import { TUNNEL_WINDOW, STREAM_WINDOW } from '../packages/connect/src/tunnel-flow.js';
import { encodeTunnelFrame, decodeTunnelFrame } from '../packages/protocol/tunnel-frame.js';
import { randomBytes } from 'node:crypto';

async function server(t, handler) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', handler);
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); http.close(); });
  return `http://127.0.0.1:${http.address().port}`;
}

test('proxy uses current route and carries binary data without leaking listeners', async t => {
  const input = new PassThrough();
  const output = new PassThrough();
  const received = [];
  output.on('data', c => received.push(c));
  const data = Buffer.from([0, 1, 255, 128, 10]);
  const hub = await server(t, (ws, req) => {
    assert.equal(req.url, '/helm/ws?role=proxy&binaryTunnel=1');
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.t === T.TUNNEL_OPEN) {
        ws.send(JSON.stringify({ t: T.TUNNEL_READY, sid: 'wrong' }));
        ws.send(JSON.stringify({ t: T.TUNNEL_READY, sid: msg.sid }));
      } else if (msg.t === T.TUNNEL_DATA) {
        assert.deepEqual(Buffer.from(msg.data, 'base64'), data);
        ws.send(raw.toString());
        ws.send(JSON.stringify({ t: T.TUNNEL_CLOSE, sid: msg.sid }));
      }
    });
  });
  input.write(data);
  await bridge(hub, 'test', 'target', 22, { input, output });
  assert.deepEqual(Buffer.concat(received), data);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.listenerCount('end'), 0);
  assert.equal(output.listenerCount('drain'), 0);
});

test('silent tunnel times out before consuming SSH input', async t => {
  const hub = await server(t, () => {});
  const input = new PassThrough(); input.write('ssh');
  await assert.rejects(bridge(hub, 'test', 'target', 22, {
    input, output: new PassThrough(), timeout: 80,
  }), /timed out/);
  assert.equal(input.read().toString(), 'ssh');
});

test('unexpected HTTP response fails promptly and marks only legacy path errors', async t => {
  const http = createServer();
  http.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'));
  await new Promise(r => http.listen(0, '127.0.0.1', r));
  t.after(() => http.close());
  await assert.rejects(bridge(`http://127.0.0.1:${http.address().port}`, 'test', 'target', 22), e => e.legacyPath === true && !e.established);
});

test('a lost established tunnel cannot be retried as a new SSH stream', async t => {
  const hub = await server(t, ws => ws.on('message', raw => {
    const msg = JSON.parse(raw);
    ws.send(JSON.stringify({ t: T.TUNNEL_READY, sid: msg.sid }), () => ws.close());
  }));
  await assert.rejects(bridge(hub, 'test', 'target', 22, {
    input: new PassThrough(), output: new PassThrough(),
  }), e => e.established === true);
});


test('a closed SSH reader rejects cleanly without an unhandled pipe error', async t => {
  const hub = await server(t, ws => ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.t !== T.TUNNEL_OPEN) return;
    ws.send(JSON.stringify({ t: T.TUNNEL_READY, sid: msg.sid, flow: 1 }));
    ws.send(JSON.stringify({ t: T.TUNNEL_DATA, sid: msg.sid, data: 'YQ==' }));
  }));
  const output = new Writable({ write(_chunk, _encoding, done) {
    done(Object.assign(new Error('reader closed'), { code: 'EPIPE' }));
  } });
  await assert.rejects(bridge(hub, 'test', 'target', 22, { input: new PassThrough(), output }), /reader closed/);
  await new Promise(r => setImmediate(r));
});

/**
 * A hub that never acknowledges: the bridge sends one window of bytes and
 * stops. `welcome` and `window` say what this hub and the far machine take.
 */
async function unacked(t, { welcome, window }) {
  const input = new PassThrough();
  const frames = [];
  let open, bytes = 0, full, asked = false;
  const filled = new Promise(resolve => { full = resolve; });
  const hub = await server(t, ws => {
    if (welcome) ws.send(JSON.stringify({ t: T.WELCOME, version: 1, role: 'client', binaryTunnel: 1 }));
    ws.on('message', (raw, isBinary) => {
      const msg = decodeTunnelFrame(raw);
      if (msg.t === T.TUNNEL_OPEN) {
        open = msg;
        ws.send(JSON.stringify({ t: T.TUNNEL_READY, sid: msg.sid, flow: 1, ...(window ? { window } : {}) }));
      } else if (msg.t === T.TUNNEL_DATA) {
        frames.push({ isBinary, data: msg.data });
        bytes += Buffer.isBuffer(msg.data) ? msg.data.length : Buffer.from(msg.data, 'base64').length;
        // A pong comes after every byte the bridge sent before it.
        if (bytes >= (window ?? TUNNEL_WINDOW) && !asked) { asked = true; ws.ping(); }
      }
    });
    ws.on('pong', full);
  });
  // Video bytes look random; more than any window, so only credit stops it.
  input.write(randomBytes(STREAM_WINDOW + 1024 * 1024));
  const tunnel = bridge(hub, 'test', 'target', 22, { input, output: new PassThrough() }).catch(() => {});
  await filled;
  input.destroy();
  await tunnel;
  return { open, frames, bytes };
}

test('a hub that takes binary gets tunnel bytes binary, and a machine that takes 4 MiB gets that window', async t => {
  const { open, frames, bytes } = await unacked(t, { welcome: true, window: STREAM_WINDOW });
  assert.equal(open.window, STREAM_WINDOW, 'the bridge says what it takes');
  assert.equal(bytes, STREAM_WINDOW);
  assert.ok(frames.every(f => f.isBinary && Buffer.isBuffer(f.data)), 'no base64');
});

test('an older hub and machine get base64 and the old 512 KiB window', async t => {
  const { frames, bytes } = await unacked(t, { welcome: false });
  assert.equal(bytes, TUNNEL_WINDOW);
  assert.ok(frames.every(f => !f.isBinary && typeof f.data === 'string'));
});

test('a binary hub with an older machine keeps the 512 KiB window', async t => {
  const { frames, bytes } = await unacked(t, { welcome: true });
  assert.equal(bytes, TUNNEL_WINDOW);
  assert.ok(frames.every(f => f.isBinary));
});

test('the bridge reads binary tunnel bytes from the hub', async t => {
  const output = new PassThrough();
  const data = randomBytes(5000);
  const hub = await server(t, ws => {
    ws.send(JSON.stringify({ t: T.WELCOME, version: 1, role: 'client', binaryTunnel: 1 }));
    ws.on('message', raw => {
      const msg = decodeTunnelFrame(raw);
      if (msg.t !== T.TUNNEL_OPEN) return;
      ws.send(JSON.stringify({ t: T.TUNNEL_READY, sid: msg.sid, flow: 1, window: STREAM_WINDOW }));
      ws.send(encodeTunnelFrame({ t: T.TUNNEL_DATA, sid: msg.sid, data }, true));
      ws.send(JSON.stringify({ t: T.TUNNEL_CLOSE, sid: msg.sid }));
    });
  });
  const got = [];
  output.on('data', c => got.push(c));
  await bridge(hub, 'test', 'target', 22, { input: new PassThrough(), output });
  assert.deepEqual(Buffer.concat(got), data);
});
