import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { hubCredential } from '../packages/protocol/network.js';

// A hub that answers with an error and keeps streaming its page.
async function hub(t, status) {
  let closed;
  const gone = new Promise(resolve => { closed = resolve; });
  const server = createServer((req, res) => {
    res.on('close', closed);
    res.writeHead(status, { 'content-type': 'text/html' });
    res.write('<p>error page that never ends');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, gone };
}

for (const status of [404, 503]) test(`a failed handshake releases its unread response after status ${status}`, async t => {
  const { base, gone } = await hub(t, status);
  await assert.rejects(hubCredential({}, base), status === 404 ? /older helm/ : /503/);
  await gone;
});

test('giving up on an address that never answers closes the connection at once', async t => {
  // A listener that accepts nothing back: the request waits for an answer.
  const { base, gone } = await (async () => {
    let closed;
    const gone = new Promise(resolve => { closed = resolve; });
    const server = createServer((req, res) => { res.on('close', closed); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return { base: `http://127.0.0.1:${server.address().port}`, gone };
  })();
  await assert.rejects(hubCredential({}, base, { timeout: 100 }), (err) => err.name === 'TimeoutError');
  await gone;
  const controller = new AbortController();
  const asked = hubCredential({}, base, { signal: controller.signal });
  controller.abort(new Error('cancelled by the caller'));
  await assert.rejects(asked, /cancelled by the caller/);
});

test('an address with nothing on it fails the way fetch did, so callers try the next hub', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(hubCredential({}, `http://127.0.0.1:${port}`), (err) => err.message === 'fetch failed' && err.cause?.code === 'ECONNREFUSED');
});
