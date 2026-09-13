import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A machine must attach to its own hub over loopback, or a phone connected to
// that hub sees the machine as offline and can run nothing on it - which is
// the entire single-VM setup. The `role=self` attach is allowed; any other
// self-attach (a machine that dialled its own public address) is still refused
// so it cannot start the supersede war invariant #2 guards against.
const dir = mkdtempSync(join(tmpdir(), 'helm-self-'));
process.env.HELM_DIR = dir;
process.env.HELM_DB = join(dir, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';

const PORT = 18981;

test('a machine reaches itself through its own hub (role=self allowed, others 409)', async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { createNetwork, loadNetwork, machineToken } = await import('@helm/protocol/network');
  const { startRelay } = await import('@helm/relay');
  const { default: WebSocket } = await import('ws');

  createNetwork({ name: 'vm', port: PORT });
  const hub = await startRelay({ port: PORT, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => hub.stop());
  const token = machineToken(loadNetwork());
  const selfId = loadNetwork().self;

  const connect = (query) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return new Promise((resolve) => {
      ws.once('open', () => resolve({ ws, ok: true }));
      ws.once('unexpected-response', (_req, res) => resolve({ ws, ok: false, status: res.statusCode }));
      ws.once('error', () => resolve({ ws, ok: false }));
    });
  };

  // A self-attach with no role is the accidental one: still refused.
  const bare = await connect('?name=vm&info=%7B%7D');
  assert.equal(bare.ok, false, 'a bare self env-attach must be refused');
  assert.equal(bare.status, 409);

  // The legitimate loopback link marks itself role=self and is accepted.
  const self = await connect('?name=vm&info=%7B%7D&role=self');
  assert.equal(self.ok, true, 'role=self loopback attach must be accepted');
  t.after(() => self.ws.close());

  // Give the hub a moment to register the env, then confirm presence.
  await new Promise((r) => setTimeout(r, 200));
  const body = await fetch(`http://127.0.0.1:${PORT}/api/network`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const me = body.machines.find((m) => m.id === selfId);
  assert.equal(me?.online, true, 'the machine must be online on its own hub');
});
