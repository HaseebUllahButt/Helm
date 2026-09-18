import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { T } from '@helm/protocol';

/**
 * Which local services a tunnel may reach.
 *
 * A hub is trusted to carry bytes, not to choose what they reach. The daemon
 * used to connect to whatever port the frame named, so anything holding any
 * credential in the network - a paired phone included - could ask a machine
 * for a duplex byte stream to any port on its own loopback interface: every
 * database, admin socket and localhost-only server on the box.
 *
 * ssh is the only thing that has ever needed a tunnel, so ssh is the list.
 */

const root = mkdtempSync(join(tmpdir(), 'helm-tunnel-'));
process.env.HELM_DIR = join(root, 'helm');

const N = await import('@helm/protocol/network');
N.createNetwork({ name: 'laptop', port: 18787 });
const { Daemon } = await import('../packages/connect/src/agent.js');

test.after(() => rmSync(root, { recursive: true, force: true }));

/** Collect what the daemon sends back for one TUNNEL_OPEN. */
async function ask(daemon, port) {
  const sent = [];
  const link = { id: 'hub', send: (t, extra) => sent.push({ t, ...extra }) };
  await daemon.onFrame(link, { t: T.TUNNEL_OPEN, sid: 's', port });
  return { sent, settled: () => sent.find((f) => f.t === T.TUNNEL_CLOSE) };
}

test('a port nobody asked to expose is refused, not dialled', async () => {
  const daemon = new Daemon({ port: 18787 });
  for (const port of [5432, 6379, 8787, 80, 3000]) {
    const { settled } = await ask(daemon, port);
    assert.equal(settled()?.reason, 'port not allowed', `port ${port}`);
  }
});

test('ssh still gets through', async () => {
  // Something has to be listening, or "allowed" and "refused" both end in a
  // close and the test proves nothing.
  const sshd = createServer((c) => c.end());
  await new Promise((r) => sshd.listen(22022, '127.0.0.1', r));
  process.env.HELM_SSH_PORT = '22022';

  const daemon = new Daemon({ port: 18787 });
  const { settled, sent } = await ask(daemon, 22022);
  await new Promise((r) => setTimeout(r, 200));

  assert.notEqual(settled()?.reason, 'port not allowed');
  assert.ok(sent.some((f) => f.t === T.TUNNEL_READY), 'the connection was made');

  delete process.env.HELM_SSH_PORT;
  sshd.close();
});

test('a port named in config.json is allowed, and only from there', async () => {
  writeFileSync(
    join(root, 'helm', 'config.json'),
    JSON.stringify({ version: 1, tunnel: { ports: [9418] } })
  );
  const daemon = new Daemon({ port: 18787 });
  assert.notEqual((await ask(daemon, 9418)).settled()?.reason, 'port not allowed');
  assert.equal((await ask(daemon, 9419)).settled()?.reason, 'port not allowed');
});

test('a frame with no port at all still means ssh', async () => {
  const daemon = new Daemon({ port: 18787 });
  // Nothing is listening on 22 here, so what comes back is a connection
  // error - which is the proof it was allowed through to try.
  const { sent } = await ask(daemon, undefined);
  await new Promise((r) => setTimeout(r, 200));
  const close = sent.find((f) => f.t === T.TUNNEL_CLOSE);
  assert.notEqual(close?.reason, 'port not allowed');
});
