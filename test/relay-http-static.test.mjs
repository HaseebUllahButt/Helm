import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { createStaticHandler } from '../apps/relay/src/static.js';

const temp = await mkdtemp(join(tmpdir(), 'helm-relay-http-'));
process.env.HELM_DB = join(temp, 'relay.sqlite');
const { readBody } = await import('../apps/relay/src/http.js');

const collectResponse = (url, options = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, options, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({
      status: res.statusCode,
      headers: res.headers,
      body: Buffer.concat(chunks),
    }));
  });
  req.on('error', reject);
  req.end();
});

async function withStaticServer(root, run) {
  const serve = createStaticHandler({
    webRoot: root,
    securityHeaders: { 'x-content-type-options': 'nosniff' },
  });
  const server = createServer(async (req, res) => {
    if (await serve(req, res)) return;
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test.after(async () => { await rm(temp, { recursive: true, force: true }); });

test('static text assets negotiate Brotli and gzip with q values and cache variants', async () => {
  const root = join(temp, 'compression');
  await mkdir(join(root, 'assets'), { recursive: true });
  const source = Buffer.from(`const bundle = '${'fast '.repeat(500)}';`);
  await writeFile(join(root, 'assets', 'bundle.js'), source);

  await withStaticServer(root, async (base) => {
    const br = await collectResponse(`${base}/assets/bundle.js`, {
      headers: { 'accept-encoding': 'gzip;q=0.7, br;q=1, identity;q=0' },
    });
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(br.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(brotliDecompressSync(br.body), source);

    const gzip = await collectResponse(`${base}/assets/bundle.js`, {
      headers: { 'accept-encoding': 'br;q=0, gzip;q=1, identity;q=0' },
    });
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.deepEqual(gunzipSync(gzip.body), source);
    assert.notEqual(gzip.headers.etag, br.headers.etag);

    const identityPreferred = await collectResponse(`${base}/assets/bundle.js`, {
      headers: { 'accept-encoding': 'br;q=0.4, gzip;q=0.5, identity;q=0.9' },
    });
    assert.equal(identityPreferred.headers['content-encoding'], undefined);
    assert.deepEqual(identityPreferred.body, source);

    const noAllowedRepresentation = await collectResponse(`${base}/assets/bundle.js`, {
      headers: { 'accept-encoding': '*;q=0' },
    });
    assert.equal(noAllowedRepresentation.status, 406);
  });
});

test('static ETags validate GET and HEAD representations and cache invalidates after edits', async () => {
  const root = join(temp, 'validators');
  await mkdir(root, { recursive: true });
  const file = join(root, 'index.html');
  const firstBody = Buffer.from(`<html>${'first '.repeat(200)}</html>`);
  await writeFile(file, firstBody);

  await withStaticServer(root, async (base) => {
    const first = await collectResponse(`${base}/`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(first.status, 200);
    assert.equal(first.headers['cache-control'], 'no-cache');
    assert.equal(first.headers['content-encoding'], 'gzip');

    const unchanged = await collectResponse(`${base}/`, {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': `W/${first.headers.etag}` },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.body.length, 0);
    assert.equal(unchanged.headers['content-encoding'], 'gzip');

    const head = await collectResponse(`${base}/`, {
      method: 'HEAD', headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers.etag, first.headers.etag);
    assert.equal(Number(head.headers['content-length']), first.body.length);

    const nextBody = Buffer.from(`<html>${'second'.repeat(200)}</html>`);
    await writeFile(file, nextBody);
    const changedTime = new Date(Date.now() + 2_000);
    await utimes(file, changedTime, changedTime);
    const changed = await collectResponse(`${base}/`, { headers: { 'accept-encoding': 'gzip' } });
    assert.notEqual(changed.headers.etag, first.headers.etag);
    assert.deepEqual(gunzipSync(changed.body), nextBody);
  });
});

test('static paths reject malformed encodings and symlinks outside the web root', async () => {
  const root = join(temp, 'contained');
  const outside = join(temp, 'outside.txt');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'index.html'), '<html>safe</html>');
  await writeFile(outside, 'secret outside web root');
  await symlink(outside, join(root, 'leak.txt'));

  await withStaticServer(root, async (base) => {
    const link = await collectResponse(`${base}/leak.txt`);
    assert.equal(link.status, 404);
    assert.doesNotMatch(link.body.toString(), /secret outside/);

    const traversal = await collectResponse(`${base}/%2e%2e%2foutside.txt`);
    assert.notEqual(traversal.body.toString(), 'secret outside web root');

    const malformed = await collectResponse(`${base}/%ZZ`);
    assert.equal(malformed.status, 404);

    const normalizedIndex = await collectResponse(`${base}/assets/%2e%2e%2findex.html`);
    assert.equal(normalizedIndex.status, 200);
    assert.equal(normalizedIndex.headers['cache-control'], 'no-cache');
  });
});

test('readBody counts UTF-8 bytes across chunks and drains oversized requests without retaining data', async () => {
  const splitUtf8 = Readable.from([
    Buffer.from('{"label":"'),
    Buffer.from([0xc3]),
    Buffer.from([0xa9]),
    Buffer.from('"}'),
  ]);
  assert.deepEqual(await readBody(splitUtf8), { label: 'é' });

  const incoming = Readable.from([
    Buffer.from('{"label":"'),
    Buffer.from('é'.repeat(500_000)),
    Buffer.from('"}'),
  ]);
  const ended = once(incoming, 'end');
  await assert.rejects(readBody(incoming), /body too large/);
  await ended;
  assert.equal(incoming.listenerCount('data'), 0);
  assert.equal(incoming.readableEnded, true);
});

test('readBody rejects an aborted request and consumes a late stream error', async () => {
  const incoming = new EventEmitter();
  incoming.complete = false;
  incoming.resume = () => {};
  const reading = readBody(incoming);
  incoming.emit('data', Buffer.from('{"partial":'));
  incoming.emit('aborted');
  await assert.rejects(reading, /request aborted/);
  assert.doesNotThrow(() => incoming.emit('error', new Error('late stream error')));
  incoming.emit('close');
  assert.equal(incoming.listenerCount('error'), 0);
});
