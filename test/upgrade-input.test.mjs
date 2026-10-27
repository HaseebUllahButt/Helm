import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

const malformedUrls = ['//[', 'http://[', '//%', 'http://localhost:invalid/ws'];

function sendUpgrade(port, url) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.end(`GET ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let response = '';
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('upgrade timed out')); });
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(response));
  });
}

test('malformed upgrades are rejected and leave the real relay serving HTTP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-upgrade-wire-'));
  const previousDir = process.env.HELM_DIR;
  const previousDb = process.env.HELM_DB;
  process.env.HELM_DIR = root;
  process.env.HELM_DB = join(root, 'hub.sqlite');
  const { startRelay } = await import('../apps/relay/src/server.js');
  const hub = await startRelay({ port: 0, host: '127.0.0.1', openLogin: false });
  const port = hub.server.address().port;
  try {
    for (const url of malformedUrls) {
      assert.match(await sendUpgrade(port, url), /^HTTP\/1\.1 400 Bad Request/);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/version`)).status, 404);
    }
    assert.match(await sendUpgrade(port, '/helm/ws'), /^HTTP\/1\.1 401 Unauthorized/);
    assert.match(await sendUpgrade(port, '/ws'), /^HTTP\/1\.1 401 Unauthorized/);
    assert.equal(await sendUpgrade(port, '/elsewhere'), '');
  } finally {
    hub.stop();
    rmSync(root, { recursive: true, force: true });
    if (previousDir === undefined) delete process.env.HELM_DIR; else process.env.HELM_DIR = previousDir;
    if (previousDb === undefined) delete process.env.HELM_DB; else process.env.HELM_DB = previousDb;
  }
});
