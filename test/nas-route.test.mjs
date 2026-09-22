import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tcpConnect } from 'node:net';
import { WebSocket } from 'ws';

/**
 * The whole path a phone takes to a nas, end to end.
 *
 * The allowlist, traversal rules and range streaming are proven in
 * nas-media.test.mjs at the package boundary; what is proved here is the
 * wiring around it - that a hub answers /media for its own machine only
 * when it is a nas, that a ticket in the URL stands in for a header a media
 * element cannot send, that the daemon's media RPCs are gated on the
 * designation, and that a hub proxies the stream through a tunnel to a
 * machine it can see but the browser cannot.
 */

const base = mkdtempSync(join(tmpdir(), 'helm-nasroute-'));
process.env.HELM_DIR = join(base, 'helm');
process.env.HELM_DB = join(base, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';
delete process.env.INVOCATION_ID;

const N = await import('@helm/protocol/network');
const { mintToken } = await import('@helm/protocol/identity');
const { M, T } = await import('@helm/protocol');
const { startRelay } = await import('@helm/relay');
const NAS = await import('@helm/nas');
const { Daemon } = await import('../packages/connect/src/agent.js');

const PORT = 18791;
const BASE = `http://127.0.0.1:${PORT}`;

const net = N.createNetwork({ name: 'nasbox', port: PORT });
N.describeSelf(net, { kind: 'nas' });
net.role = 'nas';
N.saveNetwork(net);
const SELF = net.self;

// The library being shared.
const media = join(base, 'media');
mkdirSync(join(media, 'Movies'), { recursive: true });
const FILM = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));
writeFileSync(join(media, 'Movies', 'film.mp4'), FILM);
writeFileSync(join(media, 'song.mp3'), 'audio-bytes');
writeFileSync(join(media, '.secret'), 'hidden');
NAS.addMediaRoot(media);

const hub = await startRelay({ port: PORT, dbFile: process.env.HELM_DB, host: '127.0.0.1' });
const phone = N.issueDevice(net, 'phone');

const ticketFor = (sub, env = SELF, ttlMs) =>
  NAS.mediaTicket(N.loadNetwork(), { sub, env, ...(ttlMs ? { ttlMs } : {}) }).ticket;
const streamUrl = (env, path, extra = '') =>
  `${BASE}/media/${env}/stream?root=0&path=${encodeURIComponent(path)}${extra}`;

test.after(() => { hub.stop(); rmSync(base, { recursive: true, force: true }); });

test('the hub serves this machine’s shares when it is a nas', async () => {
  const bearer = { authorization: `Bearer ${phone.token}` };

  // Listing and streaming over the hub are exactly the package answers.
  const roots = await (await fetch(`${BASE}/media/${SELF}/roots`, { headers: bearer })).json();
  assert.equal(roots.roots[0].path, realpathSync(media));

  const res = await fetch(streamUrl(SELF, 'Movies/film.mp4'), { headers: bearer });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), FILM);

  const part = await fetch(streamUrl(SELF, 'Movies/film.mp4'), {
    headers: { ...bearer, range: 'bytes=0-9' },
  });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-9/${FILM.length}`);

  // Nobody without a credential learns the share exists.
  assert.equal((await fetch(`${BASE}/media/${SELF}/roots`)).status, 401);
  assert.equal((await fetch(streamUrl(SELF, 'Movies/film.mp4'))).status, 401);
  // And the boundary holds over HTTP: escape is refused, not found.
  assert.equal((await fetch(streamUrl(SELF, '../nas-route-x'), { headers: bearer })).status, 403);
  assert.equal((await fetch(streamUrl(SELF, '.secret'), { headers: bearer })).status, 404);
});

test('a ticket in the URL stands in for the header a player cannot send', async () => {
  const good = await fetch(streamUrl(SELF, 'song.mp3', `&t=${ticketFor(phone.id)}`));
  assert.equal(good.status, 200);

  // Minted for another machine, expired, or naming nobody - all refused.
  const wrongEnv = await fetch(streamUrl(SELF, 'song.mp3', `&t=${ticketFor(phone.id, 'aa99bb88cc77')}`));
  assert.equal(wrongEnv.status, 401);
  const stale = await fetch(streamUrl(SELF, 'song.mp3', `&t=${ticketFor(phone.id, SELF, -1000)}`));
  assert.equal(stale.status, 401);
  const ghost = await fetch(streamUrl(SELF, 'song.mp3', `&t=${ticketFor('deadbeef00ff')}`));
  assert.equal(ghost.status, 401);

  // A member that has been removed takes its tickets with it.
  const gone = N.issueDevice(net, 'gone');
  const t = ticketFor(gone.id);
  const after = N.loadNetwork();
  N.revoke(after, gone.id);
  assert.equal((await fetch(streamUrl(SELF, 'song.mp3', `&t=${t}`))).status, 401);
});

test('a machine that is not a nas answers no media questions', async () => {
  const holder = N.loadNetwork();
  N.describeSelf(holder, { kind: 'pc' });
  N.saveNetwork(holder);
  try {
    const bearer = { authorization: `Bearer ${phone.token}` };
    assert.equal((await fetch(`${BASE}/media/${SELF}/roots`, { headers: bearer })).status, 404);
    assert.equal((await fetch(streamUrl(SELF, 'song.mp3'), { headers: bearer })).status, 404);
  } finally {
    const back = N.loadNetwork();
    N.describeSelf(back, { kind: 'nas' });
    N.saveNetwork(back);
  }
});

test('the daemon gates media RPCs on the designation, and mints scoped tickets', async () => {
  // Not started: dispatch is the RPC surface, and it is what is gated.
  const d = new Daemon({ name: 'nasbox', port: PORT + 1, advertiseLan: false });

  const { roots } = await d.dispatch(M.MEDIA_ROOTS, {});
  assert.equal(roots[0].path, realpathSync(media));

  const listed = await d.dispatch(M.MEDIA_LIST, { root: 0, path: 'Movies' });
  assert.deepEqual(listed.entries.map((e) => e.name), ['film.mp4']);

  // The ticket is minted for the caller on the frame - here, the phone.
  const { ticket, expiresAt } = await d.dispatch(M.MEDIA_TICKET, {}, phone.id);
  assert.ok(expiresAt > Date.now());
  const claims = (await NAS.mediaAuthorize({ self: SELF })(
    { url: `/media/stream?t=${ticket}`, headers: {} }
  ));
  assert.equal(claims.sub, phone.id);
  assert.equal(claims.env, SELF);

  // A call that arrived with no caller mints a ticket for no one - which
  // is the same as minting nothing.
  const nobody = await d.dispatch(M.MEDIA_TICKET, {});
  const denied = await NAS.mediaAuthorize({ self: SELF })(
    { url: `/media/stream?t=${nobody.ticket}`, headers: {} }
  );
  assert.equal(denied, null);
});

test('becoming a nas opens the media tunnel port; leaving closes it', async (t) => {
  const holder = N.loadNetwork();
  N.describeSelf(holder, { kind: 'pc' });
  N.saveNetwork(holder);

  const d = new Daemon({ name: 'nasbox', port: PORT + 1, advertiseLan: false });
  t.after(() => d.stop());
  const sent = [];
  const link = { id: 'hub', send: (tt, extra) => sent.push({ t: tt, ...extra }) };

  // Not yet: a nas answer on a pc is a refusal, and no port is allowed.
  await assert.rejects(() => d.dispatch(M.MEDIA_INFO, {}), /not a nas/);
  await d.onFrame(link, { t: T.TUNNEL_OPEN, sid: 's1', port: 9999 });
  assert.equal(sent.find((f) => f.t === T.TUNNEL_CLOSE)?.reason, 'port not allowed');

  sent.length = 0;
  await d.dispatch(M.MACHINE_SET_KIND, { kind: 'nas' });
  const info = await d.dispatch(M.MEDIA_INFO, {});
  assert.ok(info.port > 0, 'the media listener is up');

  // And the tunnel to it opens: this is the remote streaming path.
  await d.onFrame(link, { t: T.TUNNEL_OPEN, sid: 's2', port: info.port });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(sent.some((f) => f.t === T.TUNNEL_READY), JSON.stringify(sent));

  // Leaving nas takes the port out of the allowlist with it.
  sent.length = 0;
  await d.dispatch(M.MACHINE_SET_KIND, { kind: 'pc' });
  await d.onFrame(link, { t: T.TUNNEL_OPEN, sid: 's3', port: info.port });
  assert.equal(sent.find((f) => f.t === T.TUNNEL_CLOSE)?.reason, 'port not allowed');

  const back = N.loadNetwork();
  N.describeSelf(back, { kind: 'nas' });
  N.saveNetwork(back);
});

/**
 * A stand-in for a nas daemon on another machine: a ws holding an env slot,
 * which answers media.info and terminates tunnels the way agent.js does -
 * by dialing the port on its own loopback. Here the port is a real media
 * server, so the bytes that come back are the file itself.
 */
async function fakeNas(id, mediaPort) {
  const ws = new WebSocket(`${BASE}/helm/ws?name=nas-remote`, {
    headers: {
      authorization: `Bearer ${mintToken(net.key, { net: net.id, sub: id, role: 'machine' })}`,
    },
  });
  const tunnels = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.t === T.RPC) {
      const result = msg.method === 'media.info'
        ? { kind: 'nas', port: mediaPort, roots: [] }
        : {};
      ws.send(JSON.stringify({ t: T.RPC_RESULT, id: msg.id, ok: true, result }));
    } else if (msg.t === T.TUNNEL_OPEN) {
      const sock = tcpConnect({ host: '127.0.0.1', port: msg.port });
      tunnels.set(msg.sid, sock);
      sock.on('connect', () => ws.send(JSON.stringify({ t: T.TUNNEL_READY, sid: msg.sid })));
      sock.on('data', (c) => ws.send(JSON.stringify({ t: T.TUNNEL_DATA, sid: msg.sid, data: c.toString('base64') })));
      const end = () => { if (tunnels.delete(msg.sid)) ws.send(JSON.stringify({ t: T.TUNNEL_CLOSE, sid: msg.sid })); };
      sock.on('close', end);
      sock.on('error', end);
    } else if (msg.t === T.TUNNEL_DATA) {
      tunnels.get(msg.sid)?.write(Buffer.from(msg.data, 'base64'));
    } else if (msg.t === T.TUNNEL_CLOSE) {
      tunnels.get(msg.sid)?.destroy();
      tunnels.delete(msg.sid);
    }
  });
  // The welcome can ride in the same packet as the 101 - listen for it
  // before awaiting open, or it is gone before the listener exists.
  const welcomed = new Promise((resolve) => {
    const onMsg = (raw) => {
      if (JSON.parse(raw).t === T.WELCOME) { ws.off('message', onMsg); resolve(); }
    };
    ws.on('message', onMsg);
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  await welcomed;
  return ws;
}

test('a hub proxies media to a nas it can see but the browser cannot', async (t) => {
  const REMOTE = 'ff00ee11dd22';
  // The upstream checks the ticket is for *it* - env pinning, end to end.
  const upstream = await NAS.startMediaServer({
    host: '127.0.0.1', port: 0, authorize: NAS.mediaAuthorize({ self: REMOTE }),
  });
  const fake = await fakeNas(REMOTE, upstream.port);
  t.after(() => { fake.close(); upstream.server.close(); });

  const t2 = ticketFor(phone.id, REMOTE);
  const url = (verb, q) => `${BASE}/media/${REMOTE}/${verb}?${q}&t=${t2}`;

  const res = await fetch(url('stream', `root=0&path=${encodeURIComponent('Movies/film.mp4')}`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), FILM);

  // Ranges survive the proxy intact - seeking is still a partial read.
  const part = await fetch(url('stream', `root=0&path=${encodeURIComponent('Movies/film.mp4')}`), {
    headers: { range: 'bytes=500-599' },
  });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), FILM.subarray(500, 600));

  // A ticket for the local machine means nothing to the remote one.
  const wrong = await fetch(
    `${BASE}/media/${REMOTE}/stream?root=0&path=song.mp3&t=${ticketFor(phone.id, SELF)}`);
  assert.equal(wrong.status, 401);
  // And no credential at all is stopped at the hub, never proxied.
  assert.equal(
    (await fetch(`${BASE}/media/${REMOTE}/stream?root=0&path=song.mp3`)).status, 401);

  // Traversal is refused by the upstream and relayed as its status.
  const escape = await fetch(url('stream', 'root=0&path=..%2f..%2fetc%2fpasswd'));
  assert.equal(escape.status, 403);

  // Machines the hub cannot see and machines serving nothing both 404.
  assert.equal((await fetch(`${BASE}/media/aabbccddee11/roots`, {
    headers: { authorization: `Bearer ${phone.token}` },
  })).status, 404);
});
