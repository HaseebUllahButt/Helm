import WebSocket from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = mkdtempSync(join(tmpdir(), 'helm-security-routes-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_NO_SERVICE = '1';
await import('./fixtures/loopback-rtc.mjs');
const N = await import('@helm/protocol/network');
const S = await import('@helm/protocol/share');
const { proofOf, verifyToken } = await import('@helm/protocol/identity');
const { proofBody } = await import('../packages/protocol/proof.js');
const { startRelay } = await import('@helm/relay');
const { PeerHub, directCaller } = await import('../packages/connect/src/peer.js');
const { directPeer } = await import('../packages/connect/src/direct-rpc.js');
const { allowDirectSignal } = await import('../packages/connect/src/direct-auth.js');
const { cleanup } = await import('node-datachannel');
const bundle = await build({ entryPoints: ['apps/web/src/hubAuth.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser' });
let browserFetch = () => { throw new Error('No browser request was expected.'); };
const context = { module: { exports: {} }, crypto: webcrypto, URL, btoa, atob, TextEncoder, TextDecoder,
  setTimeout, clearTimeout, fetch: (...args) => browserFetch(...args), AbortSignal };
vm.runInNewContext(bundle.outputFiles[0].text, context);
const { HubAuth, browserProofKey } = context.module.exports;
test.after(() => { cleanup(); rmSync(root, { recursive: true, force: true }); });

async function hubFor(t) {
  const net = N.createNetwork();
  const hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => hub.stop());
  net.port = hub.server.address().port;
  N.saveNetwork(net);
  return { net, hub, base: `http://127.0.0.1:${net.port}` };
}

test('local sign-in refuses forwarded traffic and the Helm port cannot become a Spin', async t => {
  const { net, base } = await hubFor(t);
  const forwarded = { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10', 'x-forwarded-proto': 'https', host: `localhost:${net.port}` };
  const key = await fetch(base + '/api/auth/local', { method: 'POST', headers: forwarded, body: '{}' });
  assert.equal(key.status, 403);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: forwarded, body: JSON.stringify({ local: N.localKey() }) });
  assert.equal(login.status, 401);
  const { addShare, listShares } = await import('../packages/connect/src/shares.js');
  const { checkSharePort } = await import('../packages/connect/src/loopback.js');
  assert.throws(() => addShare({ name: 'own-helm', port: net.port }), /Do not share the Helm port/);
  await assert.rejects(checkSharePort(net.port), /Do not share the Helm port/);
  writeFileSync(join(process.env.HELM_DIR, 'shares.json'), JSON.stringify([{ name: 'old-unsafe', port: net.port }]));
  assert.equal(listShares().length, 0);
});

test('automatic sign-in refuses an old HTTP origin and keeps current HTTPS access', async t => {
  const { net, base } = await hubFor(t);
  net.machines.aabbccddeeff = { id: 'aabbccddeeff', name: 'old', updatedAt: Date.now(), endpoints: ['http://192.168.1.20:8787', 'https://current.example'] };
  N.saveNetwork(net);
  const request = origin => fetch(base + '/api/auth/desktop', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ network: net.id }) });
  assert.equal((await request('http://192.168.1.20:8787')).status, 403);
  assert.equal((await request('http://current.example')).status, 403);
  assert.equal((await request('https://current.example')).status, 200);
});

function signedRecord(net, record, pair) {
  record.codeSignPubkey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const clean = N.sanitizeRoster({ machines: { [record.id]: record } }).machines[record.id];
  delete clean.machineSignature;
  record.machineSignature = sign(null, proofBody(net.id, 'machine-record', clean), pair.privateKey).toString('base64url');
  return record;
}

test('only a machine owner can change its record, including its SSH key', () => {
  const net = N.createNetwork();
  const owner = generateKeyPairSync('ed25519'), attacker = generateKeyPairSync('ed25519');
  const id = '112233445566', now = Date.now();
  const record = signedRecord(net, { id, name: 'honest', endpoints: [], pubkey: 'ssh-ed25519 AAAAHONEST', updatedAt: now - 1000 }, owner);
  net.machines[id] = record;
  N.saveNetwork(net);
  const forged = { ...record, pubkey: 'ssh-ed25519 AAAAATTACKER', updatedAt: now };
  assert.equal(N.mergeRoster(net, { id: net.id, machines: { [id]: forged } }), false);
  signedRecord(net, forged, attacker);
  assert.equal(N.mergeRoster(net, { id: net.id, machines: { [id]: forged } }), false);
  const valid = signedRecord(net, { ...record, name: 'new-name', updatedAt: now }, owner);
  assert.equal(N.mergeRoster(net, { id: net.id, machines: { [id]: valid } }), true);
  assert.equal(net.machines[id].name, 'new-name');
  assert.equal(net.machines[id].pubkey, 'ssh-ed25519 AAAAHONEST');
  assert.equal(N.rosterHash(N.roster(net)), N.rosterHash(N.sanitizeRoster(N.roster(net))));
  const legacy = { id: 'aabbccddeeff', name: 'legacy', endpoints: [], updatedAt: now - 1000 };
  net.machines[legacy.id] = legacy;
  const replacement = signedRecord(net, { ...legacy, updatedAt: now }, attacker);
  assert.equal(N.mergeRoster(net, { id: net.id, machines: { [legacy.id]: replacement } }), false);
});

test('private Spin grants and cookies need a current machine signature and a bounded lifetime', () => {
  const net = N.createNetwork(), phone = N.issueDevice(net);
  const params = { name: 'private-app', host: 'home.example', sub: phone.id };
  const grant = S.mintShareGrant(net, params);
  assert.ok(S.checkShareGrant(net, grant, params));
  assert.throws(() => S.mintShareGrant({ id: net.id, key: net.key }, params));
  const payload = Buffer.from(JSON.stringify({ n: params.name, h: params.host, s: phone.id, e: Date.now() + 60_000, j: 'forged' })).toString('base64url');
  const forged = payload + '.' + proofOf(net.key, 'share-grant', `${net.id}:${payload}`);
  assert.equal(S.checkShareGrant(net, forged, params), null);
  const cookie = S.memberCookie(net, { ...params, expiresAt: Date.now() + S.MEMBER_TTL_MS });
  assert.equal(S.checkMemberCookie(net, cookie, params), phone.id);
  const long = S.memberCookie(net, { ...params, expiresAt: Date.now() + 100 * 365 * 86400000 });
  assert.equal(S.checkMemberCookie(net, long, params), null);
  const parent = 'aabbccddeeff';
  net.machines[parent] = { id: parent };
  const inherited = S.memberCookie(net, { ...params, expiresAt: Date.now() + 60_000, authorities: [parent] });
  assert.equal(S.checkMemberCookie(net, inherited, params), phone.id);
  net.revoked[parent] = Date.now();
  assert.equal(S.checkMemberCookie(net, inherited, params), null);
  net.revoked[net.self] = Date.now();
  assert.equal(S.checkShareGrant(net, grant, params), null);
  assert.equal(S.checkMemberCookie(net, cookie, params), null);
});

async function browserFor(t) {
  const { net, hub, base } = await hubFor(t);
  const publicOrigin = 'https://current.example';
  N.advertise(net, [publicOrigin]);
  const phone = N.issueDevice(net, 'browser', await browserProofKey());
  const requests = [];
  browserFetch = async (url, init = {}) => {
    requests.push({ url, init });
    const u = new URL(url);
    return fetch(base + u.pathname, { ...init, headers: { ...init.headers, host: u.host, 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.10', origin: u.origin } });
  };
  const auth = new HubAuth(phone.token, N.hubTrust(net), publicOrigin);
  return { net, hub, base, publicOrigin, phone, auth, requests };
}

test('remote browser requests require fresh device proofs bound to the target and request', async t => {
  const { net, base, publicOrigin, phone, auth } = await browserFor(t);
  const remote = { authorization: `Bearer ${phone.token}`, 'x-forwarded-for': '192.0.2.1', host: 'current.example' };
  assert.equal((await fetch(base + '/api/network', { headers: remote })).status, 401);
  const proof = await auth.headers(publicOrigin, 'GET', '/api/network');
  assert.equal((await fetch(base + '/api/network', { headers: { ...remote, ...proof } })).status, 200);
  assert.equal((await fetch(base + '/api/network', { headers: { ...remote, ...proof } })).status, 401);
  const other = await auth.headers(publicOrigin, 'GET', '/api/network');
  assert.equal((await fetch(base + '/api/devices', { headers: { ...remote, ...other } })).status, 401);
  const p = JSON.parse(Buffer.from(other['x-helm-proof'], 'base64url').toString());
  p.aud = 'aabbccddeeff';
  const encoded = Buffer.from(JSON.stringify(p)).toString('base64url');
  assert.equal(N.checkDeviceRequest(net, verifyToken(net.key, phone.token), encoded, 'GET', '/api/network'), false);
});

test('remote browser WebSockets require a proof and refuse its replay', async t => {
  const { base, publicOrigin, phone, auth } = await browserFor(t);
  const protocols = await auth.protocols(publicOrigin);
  const connect = ps => new Promise((resolve, reject) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', ps,
      { headers: { host: 'current.example', 'x-forwarded-for': '192.0.2.1' } });
    socket.on('error', reject);
    socket.once('open', () => { socket.close(); socket.once('close', () => resolve(101)); });
    socket.once('unexpected-response', (req, res) => { res.resume(); req.destroy(); resolve(res.statusCode); });
  });
  assert.equal(await connect(['helm', phone.token]), 401);
  assert.equal(await connect(protocols), 101);
  assert.equal(await connect(protocols), 401);
});

test('retired addresses are removed and a false hub receives no browser credential', async t => {
  const { net, auth, publicOrigin, requests } = await browserFor(t);
  const retired = 'https://retired.example';
  const initial = N.hubTrust(net);
  initial.machines.aabbccddeeff = { key: N.machineSigningInfo().codeSignPubkey, endpoints: [retired] };
  auth.acceptTrust(initial);
  assert.equal(auth.allowed(retired), true);
  auth.acceptTrust(N.hubTrust(net));
  assert.equal(auth.allowed(retired), false);
  await assert.rejects(auth.headers(retired, 'GET', '/api/network'), /no longer in the network/);
  assert.equal(requests.some(r => r.url.startsWith(retired)), false);
  browserFetch = async () => ({ ok: true, json: async () => ({ issuer: net.self, network: net.id, nonce: 'wrong', signature: 'bad' }) });
  await assert.rejects(auth.headers(publicOrigin, 'GET', '/api/network'), /did not prove its identity/);
});

test('direct browser offers bind the credential to the target and DTLS identity', async t => {
  const { net, phone, auth } = await browserFor(t);
  const payload = { type: 'offer', ...await auth.offer(net.self, { negotiation: 'fresh', sdp: 'fingerprint:test' }) };
  assert.equal(allowDirectSignal(net, phone.id, payload), true);
  assert.equal(allowDirectSignal(net, phone.id, { ...payload, sdp: 'fingerprint:attacker' }), false);
  assert.equal(allowDirectSignal({ ...net, self: 'aabbccddeeff' }, phone.id, payload), false);
  assert.equal(allowDirectSignal(net, phone.id, { type: 'offer', credential: phone.token }), false);
});

for (const mode of ['expiry', 'signer removal']) test(`a live direct browser connection closes after ${mode}`, async t => {
  const { net, phone, auth } = await browserFor(t);
  let current = net, sender, calls = 0, close;
  const closed = new Promise(resolve => { close = resolve; });
  const receiver = new PeerHub((_id, payload) => void sender.receive(payload), async () => { calls++; return true; },
    { authorize: (device, frame, credential) => directCaller(current, device, frame.sub, true, credential) });
  const originalNow = Date.now;
  t.after(() => { Date.now = originalNow; sender?.close(); receiver.stop(); });
  sender = directPeer({ signal: async payload => {
    if (payload.type === 'offer') payload = { ...payload, ...await auth.offer(net.self, payload) };
    if (allowDirectSignal(current, phone.id, payload)) await receiver.signal('audit', payload, null, phone.id);
  }, onMessage() {}, onClose: () => close(), connectTimeout: 5000 });
  await sender.ready;
  if (mode === 'expiry') Date.now = () => verifyToken(net.key, phone.token).exp + 1;
  else {
    current = structuredClone(net); current.self = 'ffffffffffff'; current.revoked[net.self] = Date.now(); delete current.machines[net.self];
    receiver.dropRevoked(current.revoked);
  }
  if (mode === 'expiry') await sender.send({ t: 'rpc', id: 'after', method: 'session.list' });
  await closed;
  assert.equal(calls, 0);
  assert.equal(receiver.count, 0);
});
