import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sandbox before any con module reads its environment.
const dir = mkdtempSync(join(tmpdir(), 'con-kick-'));
process.env.CON_DIR = dir;
process.env.CON_DB = join(dir, 'hub.sqlite');
process.env.CON_NO_SERVICE = '1';

const PORT = 18971;

test('removing a device closes its live WebSocket, not just its next request', async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { createNetwork } = await import('@con/protocol/network');
  const { startRelay } = await import('@con/relay');
  const { default: WebSocket } = await import('ws');

  createNetwork({ name: 'test', port: PORT });
  const hub = await startRelay({ port: PORT, host: '127.0.0.1', dbFile: process.env.CON_DB });
  t.after(() => hub.stop());

  const login = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: hub.password, label: 'phone' }),
  }).then((r) => r.json());
  assert.ok(login.token, 'login should issue a token');

  // The browser path: the token rides in the subprotocol list, never the URL,
  // and the hub must answer with the plain "con" protocol.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['con', login.token]);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  assert.equal(ws.protocol, 'con');

  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  const res = await fetch(`http://127.0.0.1:${PORT}/api/devices/${login.deviceId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${login.token}` },
  });
  assert.equal(res.status, 200);

  assert.equal(await closed, 4004, 'the live socket should be closed by the removal');
});
