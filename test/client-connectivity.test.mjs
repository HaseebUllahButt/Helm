import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const source = readFileSync(new URL('../apps/web/src/client.ts', import.meta.url), 'utf8');
const bundle = await build({ stdin: { contents: source, resolveDir: new URL('../apps/web/src/', import.meta.url).pathname,
  loader: 'ts' }, bundle: true, write: false, format: 'cjs', target: 'node22' });
const code = bundle.outputFiles[0].text;

function harness({ endpoints = ['https://good'], delays = {}, statuses = {}, reaches = {}, machineIds = {}, socket = 'open', socketDelay = 1, pong = true, location, streams = false, storage = new Map() } = {}) {
  let now = 0, serial = 0;
  const timers = new Map(), sockets = [], peers = [], events = [], requests = [], windows = new Map(), documents = new Map();
  const timer = (fn, delay = 0, interval = 0) => {
    const id = ++serial; timers.set(id, { fn, at: now + delay, interval }); return id;
  };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const advance = async (ms) => {
    const until = now + ms;
    await flush();
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, task] = next; now = Math.max(now, task.at);
      if (task.interval) task.at = now + task.interval; else timers.delete(id);
      task.fn(); await flush();
    }
    now = until; await flush();
  };
  class Socket {
    static OPEN = 1; static CLOSED = 3;
    constructor(url) {
      this.url = url; this.readyState = 0; this.frames = []; sockets.push(this);
      const behavior = typeof socket === 'function' ? socket(url) : socket;
      if (behavior === 'open') timer(() => { if (this.readyState === 3) return; this.readyState = 1; this.onopen?.(); }, typeof socketDelay === 'function' ? socketDelay(url) : socketDelay);
      if (behavior === 'error') timer(() => this.onerror?.(), 1);
    }
    send(raw) {
      if (this.readyState !== 1) throw Error('closed');
      const msg = JSON.parse(raw); this.frames.push(msg);
      if (msg.t === 'ping' && pong) timer(() => this.onmessage?.({ data: '{"t":"pong"}' }), pong === true ? 1 : pong);
    }
    close() { this.readyState = 3; this.onclose?.({ code: 1006, reason: '' }); }
    message(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  }
  class Peer {
    constructor() { peers.push(this); this.connectionState = 'new'; }
    createDataChannel() {
      return this.channel = { readyState: 'connecting', frames: [], send(raw) { this.frames.push(JSON.parse(raw)); }, close() { this.readyState = 'closed'; this.onclose?.(); } };
    }
    async createOffer() { return { type: 'offer', sdp: 'test' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription(answer) { this.remoteDescription = answer; }
    async addIceCandidate(candidate) {
      if (!this.remoteDescription) throw new Error('remote description is not ready');
      (this.candidates ??= []).push(candidate);
    }
    close() { this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
    open() { this.channel.readyState = 'open'; this.channel.onopen?.(); }
    message(msg) { this.channel.onmessage?.({ data: JSON.stringify(msg) }); }
  }
  const document = {
    hidden: false, visibilityState: 'visible',
    addEventListener: (kind, fn) => documents.set(kind, fn),
    removeEventListener: (kind) => documents.delete(kind),
  };
  const context = {
    crypto: webcrypto, URL,
    localStorage: { get length() { return storage.size; }, key: i => [...storage.keys()][i],
      getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    module: { exports: {} }, exports: {},
    performance: { now: () => now }, Date: class extends Date { static now() { return now; } },
    setTimeout: timer, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => timer(fn, ms, ms), clearInterval: id => timers.delete(id),
    AbortController, AbortSignal, WebSocket: Socket, RTCPeerConnection: Peer,
    ...(location ? { location } : {}),
    ...(streams ? { DecompressionStream, TextDecoderStream } : {}),
    document,
    navigator: { userAgent: 'test', connection: { addEventListener() {}, removeEventListener() {} } },
    window: { matchMedia: () => ({ matches: false }), addEventListener: (kind, fn) => windows.set(kind, fn), removeEventListener: kind => windows.delete(kind) },
    fetch: (url, init) => new Promise((resolve, reject) => {
      requests.push({ url, init });
      const base = new URL(url).origin, delay = delays[url] ?? delays[base] ?? 0;
      const finish = () => {
        const status = statuses[base] ?? 200;
        resolve({ status, ok: status === 200, json: async () => url.endsWith('/api/read')
          ? { result: { fresh: true } } : { machines: (machineIds[base] ?? Array.from({ length: reaches[base] ?? 1 }, (_, index) => `machine-${index}`)).map(id => ({ id, online: true })), endpoints: [] } });
      };
      if (delay !== Infinity) timer(finish, delay);
      init?.signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true });
    }),
  };
  vm.runInNewContext(code, context, { filename: 'client.ts' });
  // Route tests use a transport stand-in. hub-auth tests use real signatures.
  const auth = { headers: async () => ({}), protocols: async () => ['helm', 'test-token'],
    offer: async (_target, payload) => ({ ...payload, credential: 'test-token' }),
    allowed: () => true, acceptTrust() {} };
  const client = new context.module.exports.Client(endpoints, 'test-token', undefined, auth);
  client.on((env, kind, payload) => events.push({ env, kind, payload }));
  const start = () => client.connect().catch(error => error.message);
  return { client, sockets, peers, events, requests, document, advance, start,
    window: kind => windows.get(kind)?.(), visible: () => documents.get('visibilitychange')?.() };
}

test('invalid direct fragments do not poison a valid reply', () => {
  const h = harness(), peer = { fragments: new Map() };
  const chunk = frame => h.client.accumulate(peer, JSON.stringify({ t: 'dc-chunk', gid: 'reply', n: 2, i: 0, data: '{"text":"hello', ...frame }));
  for (const frame of [{ data: 'x'.repeat(16001) }, { data: {} }, { gid: 'x'.repeat(101) }, { i: -1 }]) {
    assert.equal(chunk(frame), null);
    assert.equal(peer.fragments.size, 0);
  }
  assert.equal(chunk({}), null);
  assert.equal(chunk({ n: 3, i: 2, data: 'bad' }), null);
  assert.equal(chunk({ data: 'duplicate' }), null);
  assert.equal(chunk({ i: 1, data: ' world"}' }).text, 'hello world');
  assert.equal(peer.fragments.size, 0);
  h.client.close();
});

test('a slow route still falls back within its bounded latency budget without replaying writes', async () => {
  const h = harness(); h.start(); await h.advance(200);
  h.client.rttSamples.set('vm', [2400]);
  const read = h.client.rpc('vm', 'session.list', {}, 20000);
  await h.advance(5060); assert.equal((await read).fresh, true);
  const write = h.client.rpc('vm', 'session.input', { id: 'thread', data: 'once' }, 20000);
  const rejected = assert.rejects(write, /client closed|disconnected/);
  await h.advance(10000);
  assert.equal(h.sockets[0].frames.filter(f => f.method === 'session.input').length, 1);
  h.client.close(); await rejected;
});

test('an offline response from one hub immediately recovers safe reads without replaying writes', async () => {
  const setup = harness();
  setup.start(); await setup.advance(200);
  const read = setup.client.rpc('vm', 'session.list');
  const readFrame = setup.sockets[0].frames.at(-1);
  setup.sockets[0].message({ t: 'rpcResult', id: readFrame.id, ok: false, error: { code: 'offline', message: 'offline' } });
  await setup.advance(1);
  assert.equal((await read).fresh, true);
  assert.equal(setup.requests.filter(request => request.url.endsWith('/api/read')).length, 1);
  const write = setup.client.rpc('vm', 'session.input', { id: 'chat', data: 'hello' });
  const rejected = assert.rejects(write, /offline/);
  const writeFrame = setup.sockets[0].frames.at(-1);
  setup.sockets[0].message({ t: 'rpcResult', id: writeFrame.id, ok: false, error: { code: 'offline', message: 'offline' } });
  await rejected;
  await setup.advance(2000);
  assert.equal(setup.requests.filter(request => request.url.endsWith('/api/read')).length, 1);
  setup.client.close();
});

test('signout cancels an in-flight warm handshake and cannot resurrect its socket', async () => {
  let delay = 1;
  const setup = harness({ socketDelay: () => delay });
  setup.start(); await setup.advance(10);
  delay = 5000;
  setup.sockets[0].close();
  await setup.advance(600);
  setup.client.close();
  await setup.advance(25000);
  assert.equal(setup.client.connected, false);
  assert.ok(setup.sockets.every(socket => socket.readyState === 3));
});

test('hub migration keeps the old route working and drains writes without replay', async () => {
  const setup = harness({ endpoints: ['https://local'], reaches: { 'https://home': 4 },
    socketDelay: url => url.startsWith('wss://home') ? 5000 : 1 });
  setup.start(); await setup.advance(10);
  const original = setup.sockets[0];
  const connectionEvents = setup.events.filter(event => event.kind === 'connection').length;
  setup.client.learn(['https://local', 'https://home']);
  await setup.advance(100);
  assert.equal(setup.client.connected, true);
  assert.equal(setup.client.relay, 'https://local');
  const request = setup.client.rpc('vm', 'session.input', { data: 'once' });
  const frame = original.frames.at(-1);
  await setup.advance(5000);
  assert.equal(setup.client.relay, 'https://home');
  assert.equal(original.readyState, 1);
  original.message({ t: 'rpcResult', id: frame.id, ok: true, result: 'accepted' });
  assert.equal(await request, 'accepted');
  assert.equal(original.readyState, 3);
  assert.equal(setup.sockets.flatMap(socket => socket.frames).filter(frame => frame.t === 'rpc').length, 1);
  assert.equal(setup.events.filter(event => event.kind === 'connection').slice(connectionEvents).some(event => !event.payload.online), false);
  setup.client.close();
});

test('losing the new hub preserves a write still waiting on the old hub', async () => {
  const h = harness({ endpoints: ['https://local'], reaches: { 'https://home': 4 } });
  h.start(); await h.advance(10);
  const original = h.sockets[0];
  let settled = false;
  const request = h.client.rpc('vm', 'session.input', { data: 'once' });
  request.then(() => { settled = true; }, () => { settled = true; });
  const frame = original.frames.at(-1);
  h.client.learn(['https://local', 'https://home']);
  await h.advance(20);
  assert.equal(h.client.relay, 'https://home');
  h.sockets[1].close();
  await h.advance(1);
  assert.equal(settled, false, 'the old hub can still answer this write');
  original.message({ t: 'rpcResult', id: frame.id, ok: true, result: 'accepted' });
  assert.equal(await request, 'accepted');
  assert.equal(original.readyState, 3);
  assert.equal(h.sockets.flatMap(socket => socket.frames).filter(frame => frame.method === 'session.input').length, 1);
  h.client.close();
});

test('losing a draining hub fails only its own writes and never replays them', async () => {
  const h = harness({ endpoints: ['https://local'], reaches: { 'https://home': 4 } });
  h.start(); await h.advance(10);
  const original = h.sockets[0];
  let failure;
  const lost = h.client.rpc('vm', 'session.input', { data: 'old' }).catch(error => { failure = error; });
  h.client.learn(['https://local', 'https://home']);
  await h.advance(20);
  const replacement = h.sockets[1];
  const current = h.client.rpc('vm', 'session.input', { data: 'new' });
  const frame = replacement.frames.at(-1);
  original.close();
  await h.advance(1);
  assert.match(failure?.message ?? '', /disconnected/);
  await lost;
  assert.equal(h.client.connected, true);
  replacement.message({ t: 'rpcResult', id: frame.id, ok: true, result: 'accepted' });
  assert.equal(await current, 'accepted');
  assert.equal(h.sockets.flatMap(socket => socket.frames).filter(frame => frame.method === 'session.input').length, 2);
  h.client.close();
});

test('failed migration preserves the working hub and closing cancels a pending replacement', async () => {
  for (const behavior of ['error', 'hang']) {
    const setup = harness({ endpoints: ['https://local'], reaches: { 'https://home': 4 },
      socket: url => url.startsWith('wss://home') ? behavior : 'open' });
    setup.start(); await setup.advance(10);
    setup.client.learn(['https://local', 'https://home']);
    await setup.advance(100);
    assert.equal(setup.client.connected, true);
    assert.equal(setup.client.relay, 'https://local');
    setup.client.close();
    await setup.advance(25000);
    assert.ok(setup.sockets.every(socket => socket.readyState === 3));
    assert.equal(setup.sockets.length, 2);
  }
});

test('a replacement handshake timeout does not disconnect the original healthy hub', async () => {
  const setup = harness({ endpoints: ['https://local'], reaches: { 'https://home': 4 },
    socket: url => url.startsWith('wss://home') ? 'hang' : 'open' });
  setup.start(); await setup.advance(10);
  setup.client.learn(['https://local', 'https://home']);
  await setup.advance(20100);
  assert.equal(setup.client.connected, true);
  assert.equal(setup.client.relay, 'https://local');
  assert.equal(setup.sockets[0].readyState, 1);
  assert.equal(setup.sockets[1].readyState, 3);
  setup.client.close();
});

test('a connected local hub does not trap the browser when a broader hub returns later', async () => {
  const statuses = { 'https://home': 503 };
  const h = harness({ endpoints: ['https://local', 'https://home'], statuses, reaches: { 'https://home': 4 } });
  h.start(); await h.advance(200);
  assert.equal(h.client.relay, 'https://local');
  statuses['https://home'] = 200;
  await h.advance(15000);
  assert.equal(h.client.relay, 'https://home');
  assert.equal(h.client.connected, true);
  h.client.close();
});

test('cold connection accepts slow healthy hubs and does not misclassify a slow success as revoked', async () => {
  for (const statuses of [{}, { 'https://old': 401 }]) {
    const h = harness({ endpoints: ['https://good', 'https://old'], delays: { 'https://good': 3500, 'https://old': statuses['https://old'] ? 0 : 3500 }, statuses });
    const connection = h.start(); await h.advance(4000); await connection;
    assert.equal(h.client.connected, true);
    assert.equal(h.events.some(e => e.kind === 'unauthorized'), false);
    h.client.close();
  }
});

test('a stalled WebSocket upgrade has a deadline and retries without browser close events', async () => {
  const h = harness({ socket: 'hang' });
  const connection = h.start(); await h.advance(20600);
  assert.match(await connection, /timed out/);
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(h.sockets.length, 2);
  h.client.close();
});

test('a hub with working HTTP but broken WebSocket cannot win every reconnect', async () => {
  const h = harness({ endpoints: ['https://broken', 'https://good'], socket: url => url.startsWith('wss://broken') ? 'error' : 'open' });
  const connection = h.start(); await h.advance(600); await connection;
  assert.equal(h.sockets.length, 2);
  assert.equal(h.client.connected, true); assert.equal(h.client.relay, 'https://good');
  h.client.close();
});

test('an open but silent relay is replaced, while slow responding relays stay connected', async () => {
  const dead = harness({ pong: false }); dead.start(); await dead.advance(26000);
  assert.equal(dead.sockets.length, 2);
  assert.ok(dead.events.some(e => e.payload.error === 'connection stopped responding'));
  dead.client.close();
  const alive = harness({ pong: 12000 }); alive.start(); await alive.advance(61000);
  assert.equal(alive.sockets.length, 1); assert.equal(alive.client.connected, true);
  alive.client.close();
});

test('foreground checks a sleeping socket with fresh patience and offline/online recovers promptly', async () => {
  const h = harness(); h.start(); await h.advance(10);
  h.document.hidden = true; await h.advance(60000);
  h.document.hidden = false; h.visible(); await h.advance(2);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].frames.at(-1).t, 'ping');
  h.window('offline'); assert.equal(h.client.connected, false);
  assert.equal(h.events.at(-1).payload.reachable, false);
  h.window('online'); await h.advance(10);
  assert.equal(h.client.connected, true); assert.equal(h.sockets.length, 2);
  h.client.close();
});

test('an offline notification cannot stop retries when the online notification is missed', async () => {
  const setup = harness();
  setup.start(); await setup.advance(10);
  setup.window('offline');
  assert.equal(setup.client.connected, false);
  await setup.advance(600);
  assert.equal(setup.client.connected, true);
  setup.client.close();
});

test('a closed idle socket recovers even if the browser never delivers its close event', async () => {
  const setup = harness();
  setup.start(); await setup.advance(10);
  setup.sockets[0].readyState = 3;
  await setup.advance(6000);
  assert.equal(setup.client.connected, true);
  setup.client.close();
});

test('a dropped socket recovers pending project reads but never replays project writes', async () => {
  const setup = harness();
  setup.start(); await setup.advance(10);
  const request = setup.client.rpc('vm', 'project.list', {}, 20000);
  const write = setup.client.rpc('vm', 'project.save', { path: '~/project' });
  const failed = assert.rejects(write, /disconnected/);
  setup.sockets[0].close();
  await setup.advance(10);
  assert.equal((await request).fresh, true);
  await failed;
  assert.equal(setup.requests.filter(request => request.url.endsWith('/api/read')).length, 1);
  assert.equal(JSON.parse(setup.requests.find(request => request.url.endsWith('/api/read')).init.body).method, 'project.list');
  setup.client.close();
});

test('manual recovery cancels a queued retry and late callbacks cannot replace the new socket', async () => {
  const h = harness(); h.start(); await h.advance(10);
  const first = h.sockets[0], staleClose = first.onclose;
  first.close(); h.start(); await h.advance(600);
  assert.equal(h.sockets.length, 2);
  staleClose({ code: 1006 }); await h.advance(1000);
  assert.equal(h.sockets.length, 2); assert.equal(h.client.connected, true);
  h.client.close();
});

test('a relay disconnect does not reject a live direct RPC and writes are never replayed', async () => {
  const h = harness(); h.start(); await h.advance(10);
  await h.client.openDirect('machine'); const peer = h.peers[0]; peer.open();
  const request = h.client.rpc('machine', 'session.input', { text: 'once' });
  const frame = peer.channel.frames[0]; h.sockets[0].close();
  peer.message({ t: 'rpcResult', id: frame.id, ok: true, result: 'accepted' });
  assert.equal(await request, 'accepted');
  await h.advance(600);
  assert.equal(peer.channel.frames.length, 1);
  assert.equal(h.sockets.flatMap(s => s.frames).filter(f => f.t === 'rpc').length, 0);
  h.client.close();
});

test('safe chat reads use authenticated HTTP when WebSocket upgrades are unavailable', async () => {
  const h = harness({ socket: 'hang' }); h.start(); await h.advance(10);
  for (const method of ['session.events', 'session.messages', 'session.list', 'model.list', 'session.commands', 'env.info', 'session.watch', 'session.unwatch', 'net.routes']) {
    const request = h.client.rpc('machine', method, { id: 'chat' }); await h.advance(1);
    assert.equal((await request).fresh, true);
    const sent = h.requests.at(-1);
    assert.equal(sent.url, 'https://good/api/read');
    assert.equal(sent.init.headers.authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(sent.init.body), { env: 'machine', method, params: { id: 'chat' }, timeoutMs: 30000 });
  }
  assert.equal(h.sockets.length, 1); // HTTP reads do not stop the socket retry loop.
  h.client.close();
});

test('HTTP read fallback never sends untracked writes and respects the read deadline', async () => {
  const h = harness({ delays: { 'https://good': Infinity } });
  for (const method of ['session.input', 'session.archive', 'profile.defaults']) {
    await assert.rejects(h.client.rpc('machine', method), /not connected/);
  }
  assert.equal(h.requests.length, 0);
  const request = h.client.rpc('machine', 'session.events', {}, 250).catch(e => e.message);
  await h.advance(251);
  assert.match(await request, /timed out/);
  h.client.close();
});

test('a silent open WebSocket read recovers over HTTP without waiting for socket timeout', async () => {
  const h = harness(); h.start(); await h.advance(10);
  const request = h.client.rpc('machine', 'session.events'); await h.advance(1510);
  assert.equal((await request).fresh, true);
  assert.equal(h.client.connected, true);
  assert.equal(h.requests.filter(r => r.url.endsWith('/api/read')).length, 1);
  h.client.close();
});

test('an HTTP403 or503 advances endpoint failover immediately without defeating a slower success', async () => {
  for (const status of [403, 503]) {
    const h = harness({ endpoints: ['https://old', 'https://good'], statuses: { 'https://old': status }, delays: { 'https://good': 1000 } });
    const request = h.client.rpc('machine', 'session.events', {}, 2000);
    await h.advance(1); assert.equal(h.requests.length, 2);
    await h.advance(1000);
    assert.equal((await request).fresh, true);
    h.client.close();
  }
});

test('closing a client cancels HTTP reads and prevents staggered requests after signout', async () => {
  const h = harness({ endpoints: ['https://old', 'https://good'], delays: { 'https://old': Infinity } });
  const request = h.client.rpc('machine', 'session.events').catch(error => error.message);
  await h.advance(100); h.client.close();
  assert.equal(await request, 'client closed');
  await h.advance(1000);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].init.signal.aborted, true);
});

test('HTTPS read failover never sends the token to a mixed-content HTTP endpoint', async () => {
  const h = harness({
    location: { origin: 'https://old', protocol: 'https:' },
    endpoints: ['http://ineligible', 'https://good'], statuses: { 'https://old': 503 },
  });
  const request = h.client.rpc('machine', 'session.events'); await h.advance(10);
  assert.equal((await request).fresh, true);
  assert.deepEqual(h.requests.map(r => r.url), ['https://old/api/read', 'https://good/api/read']);
  h.client.close();
});

test('a faster hub with equal reach must still reach the machines in the current hub', async () => {
  const h = harness({ endpoints: ['https://local'], delays: { 'https://local': 100, 'https://other': 1 },
    machineIds: { 'https://local': ['vm'], 'https://other': ['unrelated'] } });
  h.start(); await h.advance(200);
  h.client.subscribe('vm');
  await h.advance(30000);
  h.client.learn(['https://local', 'https://other']);
  await h.advance(16000);
  assert.equal(h.client.relay, 'https://local', 'equal counts must not hide the active terminal machine');
  h.client.close();
});

test('a faster hub with the same machines restores subscriptions and drains pending writes', async () => {
  const delays = { 'https://local': 100, 'https://other': 1 };
  const h = harness({ endpoints: ['https://local'], delays });
  h.start(); await h.advance(200);
  h.client.subscribe('vm');
  await h.advance(30100);
  const old = h.sockets[0];
  const write = h.client.rpc('vm', 'session.input', { data: 'once' });
  const frame = old.frames.at(-1);
  h.client.learn(['https://local', 'https://other']);
  await h.advance(200);
  assert.equal(h.client.relay, 'https://other');
  const replacement = h.sockets.at(-1);
  assert.ok(replacement.frames.some(f => f.t === 'subscribe' && f.env === 'vm'));
  assert.equal(old.readyState, 1);
  replacement.message({ t: 'event', env: 'vm', kind: 'session.data', payload: { id: 'terminal', text: 'new output' } });
  assert.ok(h.events.some(e => e.kind === 'session.data' && e.payload.text === 'new output'));
  old.message({ t: 'rpcResult', id: frame.id, ok: true, result: 'accepted' });
  assert.equal(await write, 'accepted');
  assert.equal(old.readyState, 3);
  assert.equal(h.sockets.flatMap(s => s.frames).filter(f => f.method === 'session.input').length, 1);

  // A reversal within thirty seconds must not flap the connection.
  delays['https://local'] = 1;
  delays['https://other'] = 100;
  await h.advance(15100);
  assert.equal(h.client.relay, 'https://other');
  await h.advance(30000);
  assert.equal(h.client.relay, 'https://local');
  h.client.close();
});

test('a chat list is asked for as changes to the one the device holds', async () => {
  const h = harness(); h.start(); await h.advance(200);
  const socket = h.sockets[0];
  const answer = async (result) => {
    await h.advance(1);
    const frame = socket.frames.filter(f => f.method === 'session.list').at(-1);
    socket.message({ t: 'rpcResult', id: frame.id, ok: true, result });
    return frame;
  };
  const a = { id: 'a', title: 'one' }, b = { id: 'b', title: 'two' }, c = { id: 'c', title: 'new' };
  const first = h.client.rpc('vm', 'session.list', { includeDetected: true });
  assert.equal((await answer({ sessions: [a, b], digest: 'd1' })).params.have, undefined);
  assert.equal(JSON.stringify((await first).sessions), JSON.stringify([a, b]));

  const second = h.client.rpc('vm', 'session.list', { includeDetected: true });
  assert.equal((await answer({ base: 'd1', digest: 'd2', ids: ['c', 'b'], changed: [c] })).params.have, 'd1');
  assert.equal(JSON.stringify((await second).sessions), JSON.stringify([c, b]));

  const third = h.client.rpc('vm', 'session.list', { includeDetected: true });
  assert.equal((await answer({ base: 'd2', digest: 'd2', unchanged: true })).params.have, 'd2');
  assert.equal(JSON.stringify((await third).sessions), JSON.stringify([c, b]));

  // A filter of its own holds its own list.
  const other = h.client.rpc('vm', 'session.list', {});
  assert.equal((await answer({ sessions: [a], digest: 'd9' })).params.have, undefined);
  assert.equal(JSON.stringify((await other).sessions), JSON.stringify([a]));

  // Changes that do not fit the held list mean one more ask, for all of it.
  const lost = h.client.rpc('vm', 'session.list', { includeDetected: true });
  await answer({ base: 'd2', digest: 'd3', ids: ['x'], changed: [] });
  assert.equal((await answer({ sessions: [a], digest: 'd4' })).params.have, undefined);
  assert.equal(JSON.stringify((await lost).sessions), JSON.stringify([a]));
  h.client.close();
});

test('a direct link stops the hub copy of events, and losing it takes the copy back', async () => {
  const h = harness(); h.start(); await h.advance(200);
  const hub = h.sockets[0];
  h.client.subscribe('vm');
  await h.client.openDirect('vm'); h.peers[0].open();
  assert.deepEqual(hub.frames.filter(f => f.env === 'vm' && /subscribe/.test(f.t)).map(f => f.t), ['subscribe', 'unsubscribe']);
  const before = h.events.filter(e => e.kind === 'connection').length;
  h.peers[0].channel.close();
  assert.deepEqual(hub.frames.filter(f => f.env === 'vm' && /subscribe/.test(f.t)).map(f => f.t), ['subscribe', 'unsubscribe', 'subscribe']);
  assert.equal(h.events.filter(e => e.kind === 'connection' && e.payload.online).length, before, 'other machines do not resync');
  assert.ok(h.events.some(e => e.env === 'vm' && e.kind === 'transport' && !e.payload.direct));
  h.client.close();
});

test('a hub reconnect leaves a machine on its direct link quiet', async () => {
  const h = harness(); h.start(); await h.advance(200);
  h.client.subscribe('vm'); h.client.subscribe('other');
  await h.client.openDirect('vm'); h.peers[0].open();
  h.sockets[0].close(); await h.advance(5000);
  const next = h.sockets.at(-1);
  assert.notEqual(next, h.sockets[0]);
  assert.deepEqual(next.frames.filter(f => f.t === 'subscribe').map(f => f.env), ['other']);
  h.client.close();
});

test('a browser that can read compressed frames gets them in one stream', async () => {
  const { DeflateLink } = await import('../packages/connect/src/peer.js');
  const h = harness({ streams: true }); h.start(); await h.advance(200);
  await h.client.openDirect('vm'); const peer = h.peers[0]; peer.open();
  assert.deepEqual(peer.channel.frames[0], { t: 'hello', zip: 'deflate-raw' });
  assert.equal(peer.channel.binaryType, 'arraybuffer');

  const sent = [];
  const link = new DeflateLink({ readyState: 'open', bufferedAmount: 0, send: (bytes) => sent.push(Buffer.from(bytes)) });
  const big = 'x'.repeat(100_000);
  const read = h.client.rpc('vm', 'session.events', { id: 'c' });
  const rpc = peer.channel.frames.find(f => f.method === 'session.events');
  for (let i = 0; i < 3; i++) await link.send(JSON.stringify({ t: 'event', kind: 'session.update', payload: { session: { id: 'c', n: i } }, eid: `b:${i}` }));
  await link.send(JSON.stringify({ t: 'rpcResult', id: rpc.id, ok: true, result: { text: big } }));
  link.close();
  assert.ok(sent.length > 1 && sent.every(b => b.length <= 16_000), 'large output is split');
  const raw = sent.reduce((n, b) => n + b.length, 0);
  assert.ok(raw < 5_000, `compressed to ${raw} bytes`);
  // Split the bytes at other places than the machine did: the reader must not care.
  const all = Buffer.concat(sent);
  for (let at = 0; at < all.length; at += 7) {
    const piece = all.subarray(at, at + 7);
    peer.channel.onmessage({ data: piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.length) });
  }
  for (let i = 0; i < 20 && h.events.filter(e => e.kind === 'session.update').length < 3; i++) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(h.events.filter(e => e.kind === 'session.update').map(e => e.payload.session.n), [0, 1, 2]);
  assert.equal((await read).text.length, big.length);
  h.client.close();
});

test('a received message confirms delivery while its receipt is still lost', async () => {
  const h = harness({ delays: { 'https://good/api/action': Infinity } }); h.start(); await h.advance(200);
  const actionId = 'a'.repeat(32);
  let result;
  const done = h.client.input('pc', { id: 'chat', data: 'once' }, 120000, actionId).then(value => { result = value; });
  await h.advance(1600);
  assert.equal(h.client.pendingActions().length, 1);
  h.sockets[0].message({ t: 'event', env: 'pc', kind: 'session.event', payload: {
    id: 'wrong-chat', events: [{ type: 'turn.start', messageId: actionId }],
  } });
  assert.equal(h.client.pendingActions().length, 1, 'proof must belong to this chat');
  h.sockets[0].message({ t: 'event', env: 'pc', kind: 'session.event', payload: {
    id: 'chat', events: [{ type: 'turn.start', messageId: actionId }],
  } });
  await done;
  assert.equal(result.confirmed, 'log');
  assert.equal(h.client.pendingActions().length, 0);
  const writes = h.sockets[0].frames.filter(frame => frame.method === 'session.deliver').length;
  const requests = h.requests.filter(req => req.url.endsWith('/api/action')).length;
  await h.advance(121000);
  assert.equal(h.sockets[0].frames.filter(frame => frame.method === 'session.deliver').length, writes);
  assert.equal(h.requests.filter(req => req.url.endsWith('/api/action')).length, requests, 'confirmation stops retries');
  h.client.close();
});

test('saved delivery checks use a working direct link without another send', async () => {
  const h = harness(); h.start(); await h.advance(200);
  await h.client.openDirect('pc'); const peer = h.peers[0]; peer.open();
  const actionId = 'b'.repeat(32);
  h.client.saveAction({ env: 'pc', method: 'session.deliver', actionId, started: true,
    params: { id: 'chat', data: 'once', messageId: actionId } });
  const done = h.client.resumeActions('pc', 'chat');
  const frame = peer.channel.frames.find(frame => frame.method === 'session.action-status');
  assert.ok(frame);
  peer.message({ t: 'rpcResult', id: frame.id, ok: true, result: { state: 'done', result: { ok: true } } });
  await done;
  assert.equal(h.client.pendingActions().length, 0);
  assert.equal(peer.channel.frames.some(frame => frame.method === 'session.deliver'), false);
  assert.equal(h.requests.some(req => req.url.endsWith('/api/action')), false);
  h.client.close();
});

test('native helper messages retain a delivery number until the view confirms it', async () => {
  const h=harness(); h.start(); await h.advance(200);
  const sending=h.client.rpc('pc','session.native-message',{id:'parent',agentId:'helper',data:'once'},30000);
  await h.advance(1);
  const frame=h.sockets[0].frames.find(item=>item.method==='session.native-message-deliver');
  assert.ok(frame);
  assert.match(frame.params.actionId,/^[a-f0-9]{32}$/);
  h.sockets[0].message({t:'rpcResult',id:frame.id,ok:true,result:{state:'done',result:{ok:true}}});
  const result=await sending;
  assert.equal(result.actionId,frame.params.actionId);
  assert.equal(h.client.nativeMessageActions('pc','parent','helper')[0].confirmed,true);
  const repeated=await h.client.rpc('pc','session.native-message',{id:'parent',agentId:'helper',data:'once'},30000);
  assert.equal(repeated.actionId,frame.params.actionId);
  assert.equal(h.sockets[0].frames.filter(item=>item.method==='session.native-message-deliver').length,1);
  await assert.rejects(h.client.rpc('pc','session.native-message',{id:'parent',agentId:'helper',data:'different'},30000),/previous message/i);
  h.client.ackNativeMessage(frame.params.actionId);
  assert.equal(h.client.nativeMessageActions('pc','parent','helper').length,0);
  h.client.close();
});

test('a lost native helper reply checks the same receipt before any retry', async () => {
  const h=harness({delays:{'https://good/api/action':Infinity}}); h.start(); await h.advance(200);
  const sending=h.client.rpc('pc','session.native-message',{id:'parent',agentId:'helper',data:'once'},30000);
  await h.advance(1);
  const first=h.sockets[0].frames.find(item=>item.method==='session.native-message-deliver');
  const blocked=h.client.rpc('pc','session.native-message',{id:'parent',agentId:'helper',data:'new'},30000);
  await assert.rejects(blocked,/previous message/i);
  await h.advance(10501);
  const status=h.sockets[0].frames.find(item=>item.method==='session.action-status');
  assert.equal(status.params.kind,'native');
  assert.equal(status.params.actionId,first.params.actionId);
  h.sockets[0].message({t:'rpcResult',id:status.id,ok:true,result:{state:'done',result:{ok:true}}});
  assert.equal((await sending).actionId,first.params.actionId);
  assert.equal(h.sockets[0].frames.filter(item=>item.method==='session.native-message-deliver').length,1);
  h.client.close();
});

test('an uncertain native send can be cleared only for its own helper', async () => {
  const h=harness(); h.start(); await h.advance(200);
  const actionId='c'.repeat(32);
  h.client.saveAction({env:'pc',method:'session.native-message-deliver',actionId,started:true,
    params:{id:'parent',agentId:'helper',data:'earlier',actionId}});
  assert.throws(()=>h.client.abandonNativeMessage('pc','parent','other',actionId),/message/i);
  assert.equal(h.client.nativeMessageActions('pc','parent','helper').length,1);
  h.client.delivering.set(actionId,Promise.resolve());
  assert.throws(()=>h.client.abandonNativeMessage('pc','parent','helper',actionId),/still checking/i);
  h.client.delivering.delete(actionId);
  h.client.abandonNativeMessage('pc','parent','helper',actionId);
  assert.equal(h.client.nativeMessageActions('pc','parent','helper').length,0);
  assert.equal(h.sockets[0].frames.some(item=>item.method==='session.native-message-deliver'),false);
  h.client.close();
});

test('a message to a removed chat ends as a failure, and Retry sends it once under a new number', async () => {
  const h = harness({ delays: { 'https://good/api/action': Infinity } }); h.start(); await h.advance(200);
  const actionId = 'c'.repeat(32);
  const done = h.client.input('pc', { id: 'chat', data: 'keep me' }, 120000, actionId).catch(error => error);
  await h.advance(10);
  const first = h.sockets[0].frames.find(frame => frame.method === 'session.deliver');
  h.sockets[0].message({ t: 'rpcResult', id: first.id, ok: false, error: { message: 'unknown session: chat' } });
  // The web backup for the same send is still waiting; let it run out.
  await h.advance(11000);
  const error = await done;
  assert.equal(error.deliveryRejected, true);
  assert.equal(h.client.pendingActions().length, 0);
  assert.equal(h.client.failedActions().length, 1);
  assert.equal(h.client.holdsDelivery('pc', 'chat'), true, 'failed words still belong to the chat');
  assert.equal(h.client.holdsDelivery('pc', 'other'), false);
  const sent = h.sockets[0].frames.filter(frame => frame.method === 'session.deliver').length;
  const retry = h.client.retryFailedAction(actionId);
  await h.advance(10);
  assert.equal(h.client.failedActions().length, 0);
  assert.equal(h.client.pendingActions().length, 1, 'the new send is saved before it goes');
  const frames = h.sockets[0].frames.filter(frame => frame.method === 'session.deliver');
  assert.equal(frames.length, sent + 1);
  const again = frames.at(-1);
  assert.notEqual(again.params.messageId, actionId);
  assert.equal(again.params.data, 'keep me');
  h.sockets[0].message({ t: 'rpcResult', id: again.id, ok: true, result: { ok: true } });
  await retry;
  assert.equal(h.client.holdsDelivery('pc', 'chat'), false);
  h.client.close();
});

test('resuming every unconfirmed send skips machines that are offline', async () => {
  const h = harness({ delays: { 'https://good/api/action': Infinity } }); h.start(); await h.advance(200);
  for (const [env, letter] of [['pc', 'd'], ['away', 'e']]) {
    const actionId = letter.repeat(32);
    h.client.saveAction({ env, method: 'session.deliver', actionId, started: true, savedAt: 1,
      params: { id: 'chat', data: 'later', messageId: actionId } });
  }
  void h.client.resumeAllActions(env => env === 'pc');
  await h.advance(10);
  const checks = h.sockets[0].frames.filter(frame => frame.method === 'session.action-status');
  assert.deepEqual(checks.map(frame => frame.env), ['pc'], 'a saved send asks for its receipt before it sends again');
  h.client.close();
});

test('an approval whose reply was lost is checked, not sent again, after a page reload', async () => {
  const storage = new Map(), delays = { 'https://good/api/action': Infinity };
  const before = harness({ storage, delays }); before.start(); await before.advance(200);
  const decision = { option: 'allow' };
  void before.client.rpc('pc', 'session.answer', { id: 'chat', requestId: 'second', decision }).catch(() => {});
  await before.advance(1);
  const sent = before.sockets[0].frames.find(frame => frame.method === 'session.answer-deliver');
  assert.ok(sent);
  before.client.close();

  const after = harness({ storage, delays }); after.start(); await after.advance(200);
  assert.equal(after.client.pendingActions().length, 1, 'the answer survives the reload');
  const resumed = after.client.resumeActions('pc', 'chat');
  await after.advance(1);
  await assert.rejects(after.client.rpc('pc', 'session.answer', { id: 'chat', requestId: 'second', decision: { option: 'deny' } }), /previous answer/);
  const status = after.sockets[0].frames.find(frame => frame.method === 'session.action-status');
  assert.equal(status.params.actionId, sent.params.actionId);
  assert.equal(status.params.kind, 'answer');
  after.sockets[0].message({ t: 'rpcResult', id: status.id, ok: true, result: { state: 'done', result: { ok: true } } });
  await resumed;
  assert.equal(after.client.pendingActions().length, 0);
  assert.equal(after.sockets[0].frames.some(frame => frame.method === 'session.answer-deliver'), false, 'never answered twice');
  after.client.close();
});
