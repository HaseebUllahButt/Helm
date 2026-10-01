import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

// Execute the real registered callback without opening a TCP socket. This is
// precisely the EventEmitter boundary at which a thrown URL error killed a hub.
const source = readFileSync(new URL('../apps/relay/src/server.js', import.meta.url), 'utf8');
const start = source.indexOf("  server.on('upgrade',");
const end = source.indexOf('\n  });', start) + '\n  });'.length;
let upgrade;
vm.runInNewContext(source.slice(start, end), {
  URL,
  server: { on: (_event, fn) => { upgrade = fn; } },
  tokenFromProtocols: () => null,
  clientTokenFrom: () => null,
});

function request(url) {
  const replies = [];
  let closed = false;
  const socket = {
    end: (text) => { replies.push(text); closed = true; },
    write: (text) => replies.push(text),
    destroy: () => { closed = true; },
  };
  assert.doesNotThrow(() => upgrade({ url, headers: {} }, socket, Buffer.alloc(0)));
  return { reply: replies.join(''), closed };
}

test('malformed unauthenticated upgrade URLs are rejected without throwing', () => {
  for (const url of ['//[', 'http://[', '//%', 'http://localhost:invalid/ws']) {
    const result = request(url);
    assert.match(result.reply, /^HTTP\/1\.1 400 Bad Request/);
    assert.equal(result.closed, true);
  }
});

test('the upgrade handler still rejects missing credentials and unknown paths', () => {
  assert.match(request('/helm/ws').reply, /^HTTP\/1\.1 401 Unauthorized/);
  assert.match(request('/ws').reply, /^HTTP\/1\.1 401 Unauthorized/);
  assert.equal(request('/elsewhere').closed, true);
});

test('malformed upgrades over TCP leave the real relay serving HTTP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-upgrade-wire-'));
  process.env.HELM_DIR = root;
  process.env.HELM_DB = join(root, 'hub.sqlite');
  const { startRelay } = await import('../apps/relay/src/server.js');
  const hub = await startRelay({ port: 0, host: '127.0.0.1', openLogin: false });
  const port = hub.server.address().port;
  try {
    for (const url of ['//[', 'http://[', '//%', 'http://localhost:invalid/ws']) {
      const reply = await new Promise((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port }, () => {
          socket.end(`GET ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        });
        let response = '';
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('upgrade timed out')); });
        socket.on('data', (chunk) => { response += chunk; });
        socket.on('error', reject);
        socket.on('close', () => resolve(response));
      });
      assert.match(reply, /^HTTP\/1\.1 400 Bad Request/);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/version`)).status, 404);
    }
  } finally { hub.stop(); rmSync(root, { recursive: true, force: true }); }
});
