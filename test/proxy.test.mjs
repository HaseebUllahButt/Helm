import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { T } from '@helm/protocol';
import { bridge } from '../packages/connect/src/proxy.js';

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
    assert.equal(req.url, '/helm/ws?role=proxy');
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
