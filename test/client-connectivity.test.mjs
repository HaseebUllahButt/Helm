import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';

const source = readFileSync(new URL('../apps/web/src/client.ts', import.meta.url), 'utf8');
const bundle = await build({ stdin: { contents: source, resolveDir: new URL('../apps/web/src/', import.meta.url).pathname,
  loader: 'ts' }, bundle: true, write: false, format: 'cjs', target: 'node22' });
const code = bundle.outputFiles[0].text;

function harness({ endpoints = ['http://good'], delays = {}, statuses = {}, reaches = {}, machineIds = {}, socket = 'open', socketDelay = 1, pong = true, location, streams = false } = {}) {
  let now = 0, serial = 0, parses = 0;
  const timers = new Map(), sockets = [], peers = [], events = [], requests = [], windows = new Map(), documents = new Map(), connection = new Map();
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
    module: { exports: {} }, exports: {},
    JSON: { stringify: JSON.stringify, parse: (...args) => { parses++; return JSON.parse(...args); } },
    performance: { now: () => now }, Date: class extends Date { static now() { return now; } },
    setTimeout: timer, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => timer(fn, ms, ms), clearInterval: id => timers.delete(id),
    AbortController, AbortSignal, WebSocket: Socket, RTCPeerConnection: Peer,
    ...(location ? { location } : {}),
    ...(streams ? { DecompressionStream, TextDecoderStream } : {}),
    document,
    navigator: { connection: { addEventListener: (kind, fn) => connection.set(kind, fn), removeEventListener: kind => connection.delete(kind) } },
    window: { addEventListener: (kind, fn) => windows.set(kind, fn), removeEventListener: kind => windows.delete(kind) },
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
  const client = new context.module.exports.Client(endpoints, 'test-token');
  client.on((env, kind, payload) => events.push({ env, kind, payload }));
  const start = () => client.connect().catch(error => error.message);
  return { client, sockets, peers, events, requests, timers, document, advance, start, parses: () => parses,
    suspend: ms => { now += ms; },
    window: kind => windows.get(kind)?.(), network: () => connection.get('change')?.(), visible: () => documents.get('visibilitychange')?.() };
}

test('a browser connection change retries a failed direct link without discarding a healthy link', async () => {
  const h = harness(); h.start(); await h.advance(200);
  await h.client.openDirect('failed'); await h.client.openDirect('healthy');
  h.peers[1].open();
  h.peers[0].connectionState = 'failed'; h.peers[0].onconnectionstatechange();
  assert.equal(h.client.directStatus('failed').state, 'trying again');
  assert.match(h.client.directStatus('failed').reason, /backup/);
  h.network(); await h.advance(10);
  assert.equal(h.peers.length, 3);
  assert.equal(h.client.directTo('healthy'), true);
  h.client.close(); h.network(); await h.advance(100);
  assert.equal(h.peers.length, 3, 'close removes the connection listener');
});

test('a direct link survives brief packet loss and falls back after sustained loss', async () => {
  const h = harness(); h.start(); await h.advance(200);
  await h.client.openDirect('vm'); const peer = h.peers[0]; peer.open();
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange();
  await h.advance(4000);
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  await h.advance(2000);
  assert.equal(h.client.directTo('vm'), true);
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange();
  await h.advance(5000);
  assert.equal(h.client.directTo('vm'), false);
  assert.match(h.client.directStatus('vm').reason, /stopped answering/);
  h.client.close();
});

test('frequent browser quality changes cannot postpone a dead connection check forever', async () => {
  const h = harness({ pong: false }); h.start(); await h.advance(200);
  const first = h.sockets[0];
  for (let i = 0; i < 17; i++) { h.network(); await h.advance(1000); }
  assert.equal(first.readyState, 3);
  h.client.close();
});

test('an ordinary browser direct event is parsed once', async () => {
  const h = harness(); h.start(); await h.advance(200);
  await h.client.openDirect('vm');
  const before = h.parses();
  h.peers[0].message({ t: 'event', kind: 'session.events', payload: { events: [] } });
  assert.equal(h.events.at(-1).kind, 'session.events');
  assert.equal(h.parses() - before, 1);
  h.client.close();
});

test('watching a restored chat starts a direct link without opening its machine screen', async () => {
  const h = harness(); h.start(); await h.advance(200);
  const watched = h.client.rpc('vm', 'session.watch', { id: 'saved-chat' });
  await h.advance(1);
  assert.equal(h.peers.length, 1);
  assert.ok(h.sockets[0].frames.some(frame => frame.t === 'signal' && frame.env === 'vm'));
  const frame = h.sockets[0].frames.find(frame => frame.method === 'session.watch');
  h.sockets[0].message({ t: 'rpcResult', id: frame.id, ok: true, result: { last: 0 } });
  assert.deepEqual(await watched, { last: 0 });
  h.client.close();
});

test('direct fragments are bounded even when the oldest group ID is empty', () => {
  const h = harness(), peer = { fragments: new Map() };
  for (let n = 0; n < 20; n++) {
    h.client.accumulate(peer, JSON.stringify({ t: 'dc-chunk', gid: n ? String(n) : '', n: 2, i: 0, data: 'x' }));
  }
  assert.equal(peer.fragments.size, 8);
  h.client.close();
});

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

test('non-object frames are ignored on both browser transports', async () => {
  const h = harness(); h.start(); await h.advance(200);
  await h.client.openDirect('vm');
  for (const frame of [null, false, 42, 'text', []]) {
    assert.doesNotThrow(() => h.sockets[0].message(frame));
    assert.doesNotThrow(() => h.peers[0].message(frame));
  }
  h.client.close();
});

test('a fast hub opens promptly even when another remembered endpoint is unreachable', async () => {
  const h = harness({ endpoints: ['http://good', 'http://asleep'], delays: { 'http://asleep': Infinity } });
  const connection = h.start(); await h.advance(200); await connection;
  assert.equal(h.client.connected, true); assert.equal(h.sockets.length, 1);
  h.client.close();
});

test('a slow healthy read is not duplicated at the old fixed hedge deadline', async () => {
  const h = harness(); h.start(); await h.advance(200);
  h.client.rttSamples.set('vm', [2400]);
  const result = h.client.rpc('vm', 'session.events', { id: 'thread' }, 20000);
  const frame = h.sockets[0].frames.at(-1);
  await h.advance(3000);
  assert.equal(h.requests.filter(r => r.url.endsWith('/api/read')).length, 0);
  assert.equal(h.sockets[0].frames.filter(f => f.id === frame.id).length, 1);
  h.sockets[0].message({ t: 'rpcResult', id: frame.id, ok: true, result: { last: 5 } });
  assert.equal((await result).last, 5); h.client.close();
});

test('read recovery learns slow payload delivery even when ping latency is low', async () => {
  const h = harness(); h.start(); await h.advance(200); h.client.rttSamples.set('vm', [30]);
  const first = h.client.rpc('vm', 'session.events', { id: 'thread' }, 20000);
  const frame = h.sockets[0].frames.at(-1);
  // A successful history delivery establishes its cost without another probe.
  await h.advance(1400); h.sockets[0].message({ t: 'rpcResult', id: frame.id, ok: true, result: { last: 1 } }); await first;
  const second = h.client.rpc('vm', 'session.events', { id: 'thread' }, 20000), secondFrame = h.sockets[0].frames.at(-1);
  await h.advance(1800);
  assert.equal(h.requests.filter(r => r.url.endsWith('/api/read')).length, 0);
  h.sockets[0].message({ t: 'rpcResult', id: secondFrame.id, ok: true, result: { last: 2 } });
  assert.equal((await second).last, 2); h.client.close();
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

test('slow latency probes stay single-flight instead of building a queue', async () => {
  const h = harness(); h.start(); await h.advance(200);
  const off = h.client.watchLatency('vm');
  await h.advance(9000);
  assert.equal(h.sockets[0].frames.filter(f => f.method === 'ping').length, 1);
  const ping = h.sockets[0].frames.find(f => f.method === 'ping');
  h.sockets[0].message({ t: 'rpcResult', id: ping.id, ok: true, result: {} });
  await h.advance(3000);
  assert.equal(h.sockets[0].frames.filter(f => f.method === 'ping').length, 2);
  off(); h.client.close();
});

test('direct signalling buffers early candidates and ignores superseded negotiations', async () => {
  const setup = harness();
  setup.start(); await setup.advance(200);
  await setup.client.openDirect('vm');
  const first = setup.sockets[0].frames.find(frame => frame.payload?.type === 'offer').payload;
  const candidate = { candidate: 'early', sdpMid: '0' };
  setup.sockets[0].message({ t: 'signal', env: 'vm', payload: { type: 'candidate', candidate, negotiation: first.negotiation } });
  await setup.advance(1);
  assert.equal(setup.peers[0].candidates, undefined);
  setup.sockets[0].message({ t: 'signal', env: 'vm', payload: { type: 'answer', sdp: 'answer', negotiation: first.negotiation } });
  await setup.advance(1);
  assert.equal(setup.peers[0].candidates[0].candidate, 'early');
  setup.client.dropDirect('vm');
  await setup.client.openDirect('vm');
  const replacement = setup.peers.at(-1);
  setup.sockets[0].message({ t: 'signal', env: 'vm', payload: { type: 'answer', sdp: 'stale', negotiation: first.negotiation } });
  setup.sockets[0].message({ t: 'signal', env: 'vm', payload: { type: 'candidate', candidate, negotiation: first.negotiation } });
  await setup.advance(1);
  assert.equal(replacement.remoteDescription, undefined);
  assert.equal(replacement.candidates, undefined);
  const current = setup.sockets[0].frames.filter(frame => frame.payload?.type === 'offer').at(-1).payload;
  setup.sockets[0].message({ t: 'signal', env: 'vm', payload: { type: 'answer', sdp: 'current', negotiation: current.negotiation } });
  await setup.advance(1);
  assert.equal(replacement.remoteDescription.sdp, 'current');
  setup.client.close();
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

test('a broader hub takes over as soon as it answers, without waiting for a sleeping address', async () => {
  const h = harness({ endpoints: ['http://local', 'http://home', 'http://asleep'],
    delays: { 'http://home': 1000, 'http://asleep': Infinity }, reaches: { 'http://local': 1, 'http://home': 4 } });
  h.start(); await h.advance(200);
  assert.equal(h.client.relay, 'http://local');
  await h.advance(900);
  assert.equal(h.client.connected, true);
  assert.equal(h.client.relay, 'http://home');
  assert.equal(h.sockets.length, 2);
  h.client.close();
});

test('warm reconnect races the known WebSocket without waiting for slow HTTP discovery', async () => {
  const delays = {};
  const setup = harness({ delays });
  setup.start(); await setup.advance(10);
  delays['http://good'] = 12000;
  setup.sockets[0].close();
  await setup.advance(510);
  assert.equal(setup.client.connected, true);
  assert.equal(setup.sockets.length, 2);
  await setup.advance(12500);
  assert.equal(setup.sockets.length, 2);
  setup.client.close();
});

test('the page origin opens immediately even when its HTTP discovery is stalled', async () => {
  const setup = harness({ endpoints: ['https://home'], delays: { 'https://home': Infinity },
    location: { origin: 'https://home', protocol: 'https:' } });
  const connection = setup.start();
  await setup.advance(10); await connection;
  assert.equal(setup.client.connected, true);
  assert.equal(setup.client.relay, 'https://home');
  setup.client.close();
});

test('HTTP discovery failure cannot cancel a working origin WebSocket', async () => {
  const setup = harness({ endpoints: ['https://home'], statuses: { 'https://home': 503 },
    location: { origin: 'https://home', protocol: 'https:' } });
  const connection = setup.start();
  await setup.advance(10); await connection;
  assert.equal(setup.client.connected, true);
  assert.equal(setup.sockets.length, 1);
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

test('a cached hub whose upgrade stalls cannot block another discovered hub', async () => {
  const delays = { 'http://other': Infinity };
  let stalled = false;
  const setup = harness({ endpoints: ['http://good', 'http://other'], delays,
    socket: url => stalled && url.startsWith('ws://good') ? 'hang' : 'open' });
  setup.start(); await setup.advance(200);
  stalled = true;
  delays['http://other'] = 1000;
  setup.window('offline'); setup.window('online');
  await setup.advance(1100);
  assert.equal(setup.client.connected, true);
  assert.equal(setup.client.relay, 'http://other');
  assert.equal(setup.sockets[1].readyState, 3);
  setup.client.close();
});

test('hub migration keeps the old route working and drains writes without replay', async () => {
  const setup = harness({ endpoints: ['http://local'], reaches: { 'http://home': 4 },
    socketDelay: url => url.startsWith('ws://home') ? 5000 : 1 });
  setup.start(); await setup.advance(10);
  const original = setup.sockets[0];
  const connectionEvents = setup.events.filter(event => event.kind === 'connection').length;
  setup.client.learn(['http://local', 'http://home']);
  await setup.advance(100);
  assert.equal(setup.client.connected, true);
  assert.equal(setup.client.relay, 'http://local');
  const request = setup.client.rpc('vm', 'session.input', { data: 'once' });
  const frame = original.frames.at(-1);
  await setup.advance(5000);
  assert.equal(setup.client.relay, 'http://home');
  assert.equal(original.readyState, 1);
  original.message({ t: 'rpcResult', id: frame.id, ok: true, result: 'accepted' });
  assert.equal(await request, 'accepted');
  assert.equal(original.readyState, 3);
  assert.equal(setup.sockets.flatMap(socket => socket.frames).filter(frame => frame.t === 'rpc').length, 1);
  assert.equal(setup.events.filter(event => event.kind === 'connection').slice(connectionEvents).some(event => !event.payload.online), false);
  setup.client.close();
});

test('failed migration preserves the working hub and closing cancels a pending replacement', async () => {
  for (const behavior of ['error', 'hang']) {
    const setup = harness({ endpoints: ['http://local'], reaches: { 'http://home': 4 },
      socket: url => url.startsWith('ws://home') ? behavior : 'open' });
    setup.start(); await setup.advance(10);
    setup.client.learn(['http://local', 'http://home']);
    await setup.advance(100);
    assert.equal(setup.client.connected, true);
    assert.equal(setup.client.relay, 'http://local');
    setup.client.close();
    await setup.advance(25000);
    assert.ok(setup.sockets.every(socket => socket.readyState === 3));
    assert.equal(setup.sockets.length, 2);
  }
});

test('losing the old hub during migration does not supersede the pending replacement', async () => {
  const setup = harness({ endpoints: ['http://local'], reaches: { 'http://home': 4 },
    socketDelay: url => url.startsWith('ws://home') ? 2000 : 1 });
  setup.start(); await setup.advance(10);
  setup.client.learn(['http://local', 'http://home']);
  await setup.advance(100);
  setup.sockets[0].close();
  await setup.advance(2100);
  assert.equal(setup.client.connected, true);
  assert.equal(setup.client.relay, 'http://home');
  assert.equal(setup.sockets.length, 2);
  setup.client.close();
});

test('a replacement handshake timeout does not disconnect the original healthy hub', async () => {
  const setup = harness({ endpoints: ['http://local'], reaches: { 'http://home': 4 },
    socket: url => url.startsWith('ws://home') ? 'hang' : 'open' });
  setup.start(); await setup.advance(10);
  setup.client.learn(['http://local', 'http://home']);
  await setup.advance(20100);
  assert.equal(setup.client.connected, true);
  assert.equal(setup.client.relay, 'http://local');
  assert.equal(setup.sockets[0].readyState, 1);
  assert.equal(setup.sockets[1].readyState, 3);
  setup.client.close();
});

test('hub migration restarts unfinished direct negotiation but preserves live direct routes', async () => {
  const setup = harness({ endpoints: ['http://local'], reaches: { 'http://home': 4 } });
  setup.start(); await setup.advance(10);
  await setup.client.openDirect('ready');
  setup.peers[0].open();
  await setup.client.openDirect('negotiating');
  const stale = setup.peers[1];
  setup.client.learn(['http://local', 'http://home']);
  await setup.advance(20);
  assert.equal(setup.client.directTo('ready'), true);
  assert.equal(stale.connectionState, 'closed');
  assert.equal(setup.peers.length, 3);
  assert.ok(setup.sockets[1].frames.some(frame => frame.t === 'signal' && frame.env === 'negotiating'));
  setup.client.close();
});

test('a lossy distant hub remains eligible after twelve seconds while the local app opens immediately', async () => {
  const setup = harness({ endpoints: ['http://local', 'http://home'],
    delays: { 'http://home': 12000 }, reaches: { 'http://local': 1, 'http://home': 3 } });
  setup.start(); await setup.advance(200);
  assert.equal(setup.client.connected, true);
  assert.equal(setup.client.relay, 'http://local');
  await setup.advance(12000);
  assert.equal(setup.client.connected, true);
  assert.equal(setup.client.relay, 'http://home');
  setup.client.close();
});

test('a connected local hub does not trap the browser when a broader hub returns later', async () => {
  const statuses = { 'http://home': 503 };
  const h = harness({ endpoints: ['http://local', 'http://home'], statuses, reaches: { 'http://home': 4 } });
  h.start(); await h.advance(200);
  assert.equal(h.client.relay, 'http://local');
  statuses['http://home'] = 200;
  await h.advance(15000);
  assert.equal(h.client.relay, 'http://home');
  assert.equal(h.client.connected, true);
  h.client.close();
});

test('learning a new hub checks its reach without waiting for a reconnect', async () => {
  const h = harness({ endpoints: ['http://local'], reaches: { 'http://home': 4 } });
  h.start(); await h.advance(200);
  h.client.learn(['http://local', 'http://home']);
  await h.advance(20);
  assert.equal(h.client.relay, 'http://home');
  assert.equal(h.client.connected, true);
  h.client.close();
});

test('a dead previously broader hub cannot delay a healthy local reconnect', async () => {
  const delays = { 'http://home': 1000 };
  const h = harness({ endpoints: ['http://local', 'http://home'], delays, reaches: { 'http://home': 4 } });
  h.start(); await h.advance(1100);
  assert.equal(h.client.relay, 'http://home');
  delays['http://home'] = Infinity;
  h.sockets.at(-1).close();
  await h.advance(700);
  assert.equal(h.client.connected, true);
  assert.equal(h.client.relay, 'http://local');
  h.client.close();
});

test('a presence response from the old hub cannot overwrite the new hub after failover', async () => {
  const delays = {};
  const h = harness({ endpoints: ['http://local'], delays, reaches: { 'http://home': 4 } });
  h.start(); await h.advance(200);
  delays['http://local/api/machines'] = 2000;
  const presence = h.client.environments();
  h.client.learn(['http://local', 'http://home']);
  await h.advance(2100);
  assert.equal(h.client.relay, 'http://home');
  assert.equal((await presence).environments.length, 4);
  h.client.close();
});

test('equal reach stays on the current hub and closing stops periodic discovery', async () => {
  const h = harness({ endpoints: ['http://local', 'http://home'] });
  h.start(); await h.advance(46000);
  assert.equal(h.sockets.length, 1);
  h.client.close();
  const requests = h.requests.length;
  await h.advance(30000);
  assert.equal(h.requests.length, requests);
});

test('cold connection accepts slow healthy hubs and does not misclassify a slow success as revoked', async () => {
  for (const statuses of [{}, { 'http://old': 401 }]) {
    const h = harness({ endpoints: ['http://good', 'http://old'], delays: { 'http://good': 3500, 'http://old': statuses['http://old'] ? 0 : 3500 }, statuses });
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

test('a slow WebSocket handshake is allowed to complete without a reconnect loop', async () => {
  const setup = harness({ socketDelay: 12000 });
  const connected = setup.start();
  await setup.advance(12500);
  await connected;
  assert.equal(setup.client.connected, true);
  assert.equal(setup.sockets.length, 1);
  setup.client.close();
});

test('a hub with working HTTP but broken WebSocket cannot win every reconnect', async () => {
  const h = harness({ endpoints: ['http://broken', 'http://good'], socket: url => url.startsWith('ws://broken') ? 'error' : 'open' });
  const connection = h.start(); await h.advance(600); await connection;
  assert.equal(h.sockets.length, 2);
  assert.equal(h.client.connected, true); assert.equal(h.client.relay, 'http://good');
  h.client.close();
});

test('the first slow success opens without waiting for an unreachable endpoint to expire', async () => {
  const h = harness({ endpoints: ['http://good', 'http://asleep'], delays: { 'http://good': 3500, 'http://asleep': Infinity } });
  const connection = h.start(); await h.advance(3600); await connection;
  assert.equal(h.client.connected, true);
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

test('returning after suspension replaces a stale connecting attempt immediately', async () => {
  let stalled = true;
  const setup = harness({ socket: () => stalled ? 'hang' : 'open' });
  setup.start(); await setup.advance(10);
  setup.suspend(60000);
  stalled = false;
  setup.visible();
  await setup.advance(10);
  assert.equal(setup.client.connected, true);
  assert.equal(setup.sockets[0].readyState, 3);
  setup.client.close();
});

test('repeated focus events cannot postpone dead-socket detection indefinitely', async () => {
  const setup = harness({ pong: false });
  setup.start(); await setup.advance(10);
  for (let count = 0; count < 5; count++) {
    setup.window('focus');
    await setup.advance(5000);
  }
  assert.ok(setup.sockets.length >= 2);
  setup.client.close();
});

test('project reads escape a silent direct connection instead of timing out', async () => {
  const setup = harness();
  setup.start(); await setup.advance(10);
  await setup.client.openDirect('vm'); setup.peers[0].open();
  const request = setup.client.rpc('vm', 'project.list', {}, 20000);
  await setup.advance(1500);
  const frame = setup.sockets[0].frames.find(frame => frame.method === 'project.list');
  assert.ok(frame);
  setup.sockets[0].message({ t: 'rpcResult', id: frame.id, ok: true, result: { projects: [] } });
  assert.equal((await request).projects.length, 0);
  assert.equal(setup.client.directTo('vm'), false);
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

test('direct negotiation expires and old peer callbacks cannot drop a replacement', async () => {
  const h = harness(); h.start(); await h.advance(10);
  await h.client.openDirect('machine'); const first = h.peers[0], staleClose = first.channel.onclose;
  await h.advance(19100); assert.equal(h.peers.length, 2);
  const second = h.peers[1]; second.open(); staleClose();
  assert.equal(h.client.directTo('machine'), true);
  h.client.close();
});

test('successful read fallback retires the silent peer for subsequent calls', async () => {
  const h = harness(); h.start(); await h.advance(10);
  await h.client.openDirect('machine'); h.peers[0].open();
  const request = h.client.rpc('machine', 'session.events'); await h.advance(1500);
  const frame = h.sockets[0].frames.find(f => f.t === 'rpc');
  h.sockets[0].message({ t: 'rpcResult', id: frame.id, ok: true, result: 'fresh' });
  assert.equal(await request, 'fresh'); assert.equal(h.client.directTo('machine'), false);
  const next = h.client.rpc('machine', 'session.events');
  const nextFrame = h.sockets[0].frames.at(-1);
  assert.equal(nextFrame.t, 'rpc');
  h.sockets[0].message({ t: 'rpcResult', id: nextFrame.id, ok: true, result: 'fresh again' });
  assert.equal(await next, 'fresh again');
  h.client.close();
});

test('an early hedge error does not reject the slower direct success', async () => {
  const h = harness(); h.start(); await h.advance(10);
  await h.client.openDirect('machine'); const peer = h.peers[0]; peer.open();
  const request = h.client.rpc('machine', 'session.events'); await h.advance(1500);
  const frame = h.sockets[0].frames.find(f => f.t === 'rpc');
  h.sockets[0].message({ t: 'rpcResult', id: frame.id, ok: false, error: { message: 'environment is not connected' } });
  peer.message({ t: 'rpcResult', id: frame.id, ok: true, result: 'fresh' });
  assert.equal(await request, 'fresh'); assert.equal(h.client.directTo('machine'), true);
  h.client.close();
});

test('safe chat reads use authenticated HTTP when WebSocket upgrades are unavailable', async () => {
  const h = harness({ socket: 'hang' }); h.start(); await h.advance(10);
  for (const method of ['session.events', 'session.messages', 'session.list', 'model.list', 'session.commands', 'env.info', 'session.watch', 'session.unwatch']) {
    const request = h.client.rpc('machine', method, { id: 'chat' }); await h.advance(1);
    assert.equal((await request).fresh, true);
    const sent = h.requests.at(-1);
    assert.equal(sent.url, 'http://good/api/read');
    assert.equal(sent.init.headers.authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(sent.init.body), { env: 'machine', method, params: { id: 'chat' } });
  }
  assert.equal(h.sockets.length, 1); // HTTP reads do not stop the socket retry loop.
  h.client.close();
});

test('HTTP fallback never sends mutations and respects the read deadline', async () => {
  const h = harness({ delays: { 'http://good': Infinity } });
  for (const method of ['session.input', 'session.answer', 'session.archive', 'profile.defaults']) {
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

test('a silent direct read uses HTTP when the relay has disconnected', async () => {
  const h = harness(); h.start(); await h.advance(10);
  await h.client.openDirect('machine'); h.peers[0].open();
  h.client.disconnectSocket('test disconnect', false);
  const request = h.client.rpc('machine', 'session.events'); await h.advance(1510);
  assert.equal((await request).fresh, true);
  assert.equal(h.client.directTo('machine'), false);
  h.client.close();
});

test('HTTP still recovers a chat read when both open socket routes are silent', async () => {
  const h = harness(); h.start(); await h.advance(10);
  await h.client.openDirect('machine'); h.peers[0].open();
  const request = h.client.rpc('machine', 'session.events'); await h.advance(3010);
  assert.equal((await request).fresh, true);
  assert.equal(h.client.directTo('machine'), false);
  assert.equal(h.requests.filter(r => r.url.endsWith('/api/read')).length, 1);
  h.client.close();
});

test('a socket read cancels its HTTP backup when it returns first', async () => {
  for (const route of ['direct', 'relay']) {
    const h = harness({ delays: { 'http://good/api/read': Infinity } });
    h.start(); await h.advance(10);
    if (route === 'direct') { await h.client.openDirect('machine'); h.peers[0].open(); }
    const request = h.client.rpc('machine', 'session.events');
    await h.advance(3010);
    const backup = h.requests.find(r => r.url.endsWith('/api/read'));
    assert.ok(backup);
    assert.equal(backup.init.signal.aborted, false);
    const sender = route === 'direct' ? h.peers[0] : h.sockets[0];
    const frame = (route === 'direct' ? sender.channel.frames : sender.frames).find(f => f.t === 'rpc');
    sender.message({ t: 'rpcResult', id: frame.id, ok: true, result: 'latest chat' });
    assert.equal(await request, 'latest chat');
    assert.equal(backup.init.signal.aborted, true);
    await h.advance(30000);
    assert.equal(h.requests.filter(r => r.url.endsWith('/api/read')).length, 1);
    h.client.close();
  }
});

test('the parent read deadline cancels a running HTTP backup', async () => {
  const h = harness({ delays: { 'http://good/api/read': Infinity } });
  h.start(); await h.advance(10);
  const request = h.client.rpc('machine', 'session.events', {}, 4000).catch(e => e.message);
  await h.advance(4010);
  assert.match(await request, /timed out/);
  assert.equal(h.requests.find(r => r.url.endsWith('/api/read')).init.signal.aborted, true);
  h.client.close();
});

test('HTTP reads fail over promptly from a dead remembered relay and cancel the losing request', async () => {
  const h = harness({ endpoints: ['http://old', 'http://good'], delays: { 'http://old': Infinity, 'http://good': 10 } });
  const request = h.client.rpc('machine', 'session.events', {}, 20000);
  await h.advance(399); assert.equal(h.requests.length, 1);
  await h.advance(20);
  assert.equal((await request).fresh, true);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.equal(h.timers.size, 0, 'winning a read clears its deadline and stagger timers');
  h.client.close();
});

test('an HTTP403 or503 advances endpoint failover immediately without defeating a slower success', async () => {
  for (const status of [403, 503]) {
    const h = harness({ endpoints: ['http://old', 'http://good'], statuses: { 'http://old': status }, delays: { 'http://good': 1000 } });
    const request = h.client.rpc('machine', 'session.events', {}, 2000);
    await h.advance(1); assert.equal(h.requests.length, 2);
    await h.advance(1000);
    assert.equal((await request).fresh, true);
    h.client.close();
  }
});

test('closing a client cancels HTTP reads and prevents staggered requests after signout', async () => {
  const h = harness({ endpoints: ['http://old', 'http://good'], delays: { 'http://old': Infinity } });
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
  const h = harness({ endpoints: ['http://local'], delays: { 'http://local': 100, 'http://other': 1 },
    machineIds: { 'http://local': ['vm'], 'http://other': ['unrelated'] } });
  h.start(); await h.advance(200);
  h.client.subscribe('vm');
  await h.advance(30000);
  h.client.learn(['http://local', 'http://other']);
  await h.advance(16000);
  assert.equal(h.client.relay, 'http://local', 'equal counts must not hide the active terminal machine');
  h.client.close();
});


test('a faster hub with the same machines restores subscriptions and drains pending writes', async () => {
  const delays = { 'http://local': 100, 'http://other': 1 };
  const h = harness({ endpoints: ['http://local'], delays });
  h.start(); await h.advance(200);
  h.client.subscribe('vm');
  await h.advance(30100);
  const old = h.sockets[0];
  const write = h.client.rpc('vm', 'session.input', { data: 'once' });
  const frame = old.frames.at(-1);
  h.client.learn(['http://local', 'http://other']);
  await h.advance(200);
  assert.equal(h.client.relay, 'http://other');
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
  delays['http://local'] = 1;
  delays['http://other'] = 100;
  await h.advance(15100);
  assert.equal(h.client.relay, 'http://other');
  await h.advance(30000);
  assert.equal(h.client.relay, 'http://local');
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

test('a model list that waits for its refresh is not raced over other routes', async () => {
  const h = harness(); h.start(); await h.advance(200);
  const waiting = h.client.rpc('vm', 'model.list', { profileId: 'p', settled: true }, 30000);
  await h.advance(10000);
  assert.equal(h.sockets[0].frames.filter(f => f.method === 'model.list').length, 1);
  assert.equal(h.requests.filter(r => r.url.endsWith('/api/read')).length, 0);
  const frame = h.sockets[0].frames.find(f => f.method === 'model.list');
  h.sockets[0].message({ t: 'rpcResult', id: frame.id, ok: true, result: { models: ['m'] } });
  assert.equal((await waiting).models[0], 'm');
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
  assert.equal(h.events.filter(e => e.kind === 'connection' && e.payload.online).length, before + 1, 'screens resync the gap');
  h.client.close();
});

test('a machine subscribed while its direct link is up never gets a hub copy', async () => {
  const h = harness(); h.start(); await h.advance(200);
  await h.client.openDirect('vm'); h.peers[0].open();
  h.client.subscribe('vm');
  assert.equal(h.sockets[0].frames.filter(f => f.env === 'vm' && /subscribe/.test(f.t)).length, 0);
  h.client.close();
});

test('a silent direct link is checked, and dropped when it does not answer', async () => {
  const h = harness(); h.start(); await h.advance(200);
  h.client.subscribe('vm');
  await h.client.openDirect('vm'); const peer = h.peers[0]; peer.open();
  await h.advance(9000);
  assert.equal(peer.channel.frames.filter(f => f.method === 'ping').length, 0, 'recent traffic needs no check');
  await h.advance(2000);
  const ping = peer.channel.frames.find(f => f.method === 'ping');
  assert.ok(ping, 'ten silent seconds send a check');
  peer.message({ t: 'rpcResult', id: ping.id, ok: true, result: {} });
  await h.advance(1);
  assert.equal(h.client.directTo('vm'), true);
  await h.advance(20000);
  assert.equal(h.client.directTo('vm'), false, 'an unanswered check drops the link');
  assert.equal(h.sockets[0].frames.filter(f => f.env === 'vm' && f.t === 'subscribe').length, 2);
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

test('after waking, a socket that does not answer in 1.2 s is replaced at once', async () => {
  const h = harness({ pong: false }); h.start(); await h.advance(10);
  h.document.hidden = true; h.document.visibilityState = 'hidden'; h.visible();
  await h.advance(60000);
  h.document.hidden = false; h.document.visibilityState = 'visible'; h.visible();
  await h.advance(1100);
  assert.equal(h.sockets.length, 1, 'a slow answer still has time');
  await h.advance(200);
  assert.equal(h.sockets.length, 2, 'a fresh socket opens beside the silent one');
  assert.equal(h.client.connected, true);
  await h.advance(2000);
  assert.equal(h.sockets[0].readyState, 3, 'the silent socket is retired');
  assert.equal(h.sockets.length, 2);
  h.client.close();
});

test('after waking, a socket that answers is kept', async () => {
  const h = harness({ pong: 1000 }); h.start(); await h.advance(10);
  h.document.hidden = true; h.document.visibilityState = 'hidden'; h.visible();
  await h.advance(60000);
  h.document.hidden = false; h.document.visibilityState = 'visible'; h.visible();
  await h.advance(8000);
  assert.equal(h.sockets.length, 1);
  h.client.close();
});

test('just after waking, a read tries the web route after 0.5 s', async () => {
  const h = harness({ pong: false }); h.start(); await h.advance(10);
  h.document.hidden = true; h.document.visibilityState = 'hidden'; h.visible();
  await h.advance(60000);
  h.document.hidden = false; h.document.visibilityState = 'visible'; h.visible();
  const read = h.client.rpc('vm', 'session.events', { id: 'c', since: 1 });
  await h.advance(400);
  assert.equal(h.requests.filter(r => r.url.endsWith('/api/read')).length, 0);
  await h.advance(200);
  assert.equal(h.requests.filter(r => r.url.endsWith('/api/read')).length, 1);
  assert.equal((await read).fresh, true);
  h.client.close();
});
