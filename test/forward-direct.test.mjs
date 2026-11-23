import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createServer, connect as tcpConnect } from 'node:net';
import { once } from 'node:events';

/**
 * A forward's connection over the direct channel (forward.js `direct`,
 * proxy.js bridgeDirect) into the far machine's real daemon
 * (agent.js directTunnel). The channel here is a stand-in that passes the
 * same frames both ways a little later, as the WebRTC one does; the hub is
 * a stub that answers "hub", so a test sees which way a connection went.
 */

const root = mkdtempSync(join(tmpdir(), 'helm-forward-direct-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_DB = join(root, 'helm.sqlite');
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_NO_SERVICE = '1';

const N = await import('@helm/protocol/network');
const { T } = await import('@helm/protocol');
const { Daemon } = await import('../packages/connect/src/agent.js');
const { startForward } = await import('../packages/connect/src/forward.js');

const PORT = 18799;
const NEAR = 'aa11bb22cc33';
const GONE = 'dd44ee55ff66';
const net = N.createNetwork({ name: 'far', port: PORT });
for (const [id, name] of [[NEAR, 'why'], [GONE, 'old']]) {
  net.machines[id] = { id, name, endpoints: [], addedAt: 1, updatedAt: 1 };
}
N.saveNetwork(net);
N.revoke(N.loadNetwork(), GONE);
const PHONE = N.issueDevice(N.loadNetwork(), 'phone').id;

const daemon = new Daemon({ port: PORT });
const app = http.createServer((req, res) => { res.writeHead(200); res.end(`app saw ${req.url}`); });
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const APP = app.address().port;

test.after(async () => {
  app.close();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

let seq = 0;
/**
 * A direct channel from `caller` to the far daemon. `far(link, frame)`
 * stands for the far machine; by default the real daemon.
 */
function channel(caller, far = (link, frame) => daemon.directTunnel(link, frame, caller)) {
  const streams = new Map();
  const link = {
    id: `dc-test-${++seq}`,
    send: (t, extra) => { setImmediate(() => streams.get(extra.sid)?.onFrame({ t, ...extra })); return Promise.resolve(true); },
  };
  const opened = [];
  return {
    link, opened,
    open: (handlers) => {
      const sid = `dt-${++seq}`;
      streams.set(sid, handlers);
      opened.push(sid);
      return {
        sid,
        send: async (t, extra = {}) => { setImmediate(() => far(link, { ...extra, t, sid })); },
        close: () => { streams.delete(sid); },
      };
    },
    /** The channel goes, on both machines at once. */
    drop() {
      daemon.directChannelGone(link);
      for (const [sid, handlers] of [...streams]) { streams.delete(sid); handlers.onClose(new Error('direct channel closed')); }
    },
  };
}

/** A hub that answers every connection with "hub". */
function stubHub() {
  const calls = [];
  const open = async (hub, token, target, port, { input, output }) => {
    calls.push({ hub, target, port });
    input.resume();
    output.write('HTTP/1.1 200 OK\r\ncontent-length: 3\r\nconnection: close\r\n\r\nhub');
  };
  return { calls, open, hubs: ['http://hub.invalid'], credential: async () => 'token' };
}

async function forward(t, { port = APP, direct, hub = stubHub() }) {
  const fwd = await startForward(N.loadNetwork(), {
    target: 'far', port, localPort: 0, machine: 'far',
    hubs: hub.hubs, open: hub.open, credential: hub.credential, direct,
  });
  t.after(() => fwd.close());
  return { fwd, hub };
}

function get(port, path = '/') {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }).on('error', reject);
  });
}

/** What the far daemon answers one direct open with. */
async function ask(caller, port) {
  const sent = [];
  const link = { id: `dc-ask-${++seq}`, send: (t, extra) => { sent.push({ t, ...extra }); return Promise.resolve(true); } };
  daemon.directTunnel(link, { t: T.TUNNEL_OPEN, sid: 's1', port, flow: 1 }, caller);
  for (let i = 0; i < 200 && !sent.length; i++) await new Promise((r) => setImmediate(r));
  daemon.directChannelGone(link);
  return sent[0];
}

test('a forward goes straight to the machine over the direct channel, not the hub', async (t) => {
  process.env.HELM_SSH_PORT = String(APP);
  t.after(() => { delete process.env.HELM_SSH_PORT; });
  const ch = channel(NEAR);
  const { fwd, hub } = await forward(t, { direct: ch.open });
  const one = await get(fwd.port, '/page');
  assert.equal(one.status, 200);
  assert.equal(one.text, 'app saw /page');
  const two = await get(fwd.port, '/next');
  assert.equal(two.text, 'app saw /next');
  assert.equal(ch.opened.length, 2);
  assert.equal(hub.calls.length, 0);
});

test('over a direct channel the far machine opens only allowed ports, and only for its own machines', async (t) => {
  process.env.HELM_SSH_PORT = String(APP);
  t.after(() => { delete process.env.HELM_SSH_PORT; });
  assert.equal((await ask(NEAR, APP)).t, T.TUNNEL_READY);
  const closed = await ask(NEAR, 5432);
  assert.equal(closed.t, T.TUNNEL_CLOSE);
  assert.equal(closed.reason, 'port not allowed');
  for (const caller of [GONE, PHONE, N.loadNetwork().self, undefined]) {
    const answer = await ask(caller, APP);
    assert.equal(answer.t, T.TUNNEL_CLOSE, String(caller));
    assert.match(answer.reason, /another machine of this network only/);
  }
});

test('a port the far machine does not allow gives the refused page, as through a hub', async (t) => {
  const ch = channel(NEAR);
  const { fwd, hub } = await forward(t, { port: 5432, direct: ch.open });
  const page = await get(fwd.port);
  assert.equal(page.status, 502);
  assert.equal(page.headers['x-helm-forward'], 'refused');
  assert.equal(hub.calls.length, 0);
});

test('a direct open that cannot start goes to the hub, with no error page', async (t) => {
  process.env.HELM_SSH_PORT = String(APP);
  t.after(() => { delete process.env.HELM_SSH_PORT; });
  // An older Helm on the far machine refuses every direct stream but copies.
  const old = channel(NEAR, (link, frame) => {
    if (frame.t === T.TUNNEL_OPEN) link.send(T.TUNNEL_CLOSE, { sid: frame.sid, reason: 'direct tunnels carry signed copy requests only' });
  });
  const a = await forward(t, { direct: old.open });
  assert.equal((await get(a.fwd.port)).text, 'hub');
  assert.equal(old.opened.length, 1);
  assert.equal(a.hub.calls.length, 1);
  // A removed machine is refused there, so it gets the hub's answer instead.
  const removed = channel(GONE);
  const b = await forward(t, { direct: removed.open });
  assert.equal((await get(b.fwd.port)).text, 'hub');
  // No channel open, or not the faster way: the hub, as before.
  const c = await forward(t, { direct: () => null });
  assert.equal((await get(c.fwd.port)).text, 'hub');
});

test('a direct channel that drops closes the forwarded connection on both machines, never replayed', async (t) => {
  const held = new Set();
  const live = createServer((s) => { held.add(s); s.write('hi'); s.on('close', () => held.delete(s)); s.on('error', () => {}); });
  await new Promise((r) => live.listen(0, '127.0.0.1', r));
  t.after(() => live.close());
  process.env.HELM_SSH_PORT = String(live.address().port);
  t.after(() => { delete process.env.HELM_SSH_PORT; });
  const ch = channel(NEAR);
  const { fwd, hub } = await forward(t, { port: live.address().port, direct: ch.open });
  const client = tcpConnect(fwd.port, '127.0.0.1');
  client.on('error', () => {});
  const [first] = await once(client, 'data');
  assert.equal(String(first), 'hi');
  assert.equal(held.size, 1);
  const [server] = held;
  const farClosed = once(server, 'close');
  const nearClosed = once(client, 'close');
  ch.drop();
  await Promise.all([farClosed, nearClosed]);
  assert.equal(hub.calls.length, 0);
});
