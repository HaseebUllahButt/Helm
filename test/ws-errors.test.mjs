import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'helm-ws-errors-'));
process.env.HELM_DIR = dir;
process.env.HELM_DB = join(dir, 'hub.sqlite');
const { createNetwork, issueDevice, machineToken } = await import('@helm/protocol/network');
const { startRelay } = await import('@helm/relay');

test('bad frames disconnect only their sender, for devices and machines', { timeout: 10_000 }, async (t) => {
  const net = createNetwork({ name: 'test', port: 0 });
  const { token } = issueDevice(net, 'device');
  const hub = await startRelay({ host: '127.0.0.1', port: 0, openLogin: false });
  const base = `127.0.0.1:${hub.server.address().port}`;
  const sockets = [];
  t.after(() => {
    for (const socket of sockets) socket.terminate();
    hub.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const connect = async (credential, query = '') => {
    const socket = new WebSocket(`ws://${base}/ws${query}`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    sockets.push(socket);
    socket.on('error', () => {});
    await once(socket, 'open');
    return socket;
  };
  const healthy = await connect(token);
  for (const [credential, query] of [[token, ''], [machineToken(net), '?role=self']]) {
    for (const invalidUtf8 of [true, false]) {
      const offender = await connect(credential, query);
      const closed = once(offender, 'close');
      if (invalidUtf8) offender.send(Buffer.from([0xff]), { binary: false });
      else offender._socket.write(Buffer.from([0x81, 0x00])); // client frames must be masked
      await closed;
      assert.equal((await fetch(`http://${base}/api/health`)).status, 200);
      const pong = once(healthy, 'pong');
      healthy.ping('still alive');
      await pong;
    }
  }
});
