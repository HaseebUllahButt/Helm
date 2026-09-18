import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'con-notification-route-'));
process.env.CON_DIR = dir;
process.env.CON_DB = join(dir, 'hub.sqlite');
process.env.CON_NO_SERVICE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a remote machine hands notifications to the hub that owns the phone subscription', async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const received = [];
  const pushService = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(Buffer.concat(chunks));
      res.writeHead(201).end();
    });
  });
  await new Promise((resolve) => pushService.listen(0, '127.0.0.1', resolve));
  t.after(() => pushService.close());

  const { createNetwork, loadNetwork, machineToken } = await import('@con/protocol/network');
  const { T } = await import('@con/protocol');
  const { q } = await import('../apps/relay/src/db.js');
  const { startRelay } = await import('@con/relay');
  const { default: WebSocket } = await import('ws');

  createNetwork({ name: 'home', port: 8787 });
  const pushPort = pushService.address().port;
  q.pushSet.run(
    `http://127.0.0.1:${pushPort}/phone`, 'phone-1',
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg', 'phone', Date.now(),
  );

  const hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.CON_DB, openLogin: false });
  t.after(() => { for (const socket of hub.online.values()) socket.terminate(); hub.stop(); });
  const port = hub.server.address().port;
  const net = loadNetwork();

  const machine = new WebSocket(`ws://127.0.0.1:${port}/con/ws?name=laptop&role=self`, {
    headers: { authorization: `Bearer ${machineToken(net)}` },
  });
  t.after(() => machine.close());
  await new Promise((resolve, reject) => {
    machine.once('open', resolve);
    machine.once('error', reject);
  });

  const payload = {
    title: 'con · codex needs you',
    body: 'Allow this command?',
    tag: 'con-session-1-request-1',
    envId: 'machine-1',
    sessionId: 'session-1',
  };
  machine.send(JSON.stringify({ t: T.NOTIFY, payload }));

  for (let i = 0; i < 50 && received.length === 0; i += 1) await sleep(20);
  assert.equal(received.length, 1, 'the hub with the subscription sent the push');
  assert.ok(received[0].length > 16, 'the push payload was encrypted');

  machine.send(JSON.stringify({ t: T.NOTIFY, payload }));
  await sleep(100);
  assert.equal(received.length, 1, 'the same permission request was not sent twice');
});
