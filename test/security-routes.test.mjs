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

test('a phone with a wrong clock stays signed in', async t => {
  const { base, publicOrigin, phone, auth } = await browserFor(t);
  const remote = { authorization: `Bearer ${phone.token}`, 'x-forwarded-for': '192.0.2.1', host: 'current.example' };
  const now = Date.now;
  let proof;
  try {
    Date.now = () => now() + 10 * 60_000;
    proof = await auth.headers(publicOrigin, 'GET', '/api/network');
  } finally { Date.now = now; }
  assert.equal((await fetch(base + '/api/network', { headers: { ...remote, ...proof } })).status, 200);
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

for (const mode of ['an old expiry', 'signer removal']) test(`a live direct browser connection after ${mode}`, async t => {
  const { net, phone, auth } = await browserFor(t);
  let current = net, sender, calls = 0, close, answer;
  const closed = new Promise(resolve => { close = resolve; });
  const answered = new Promise(resolve => { answer = resolve; });
  const receiver = new PeerHub((_id, payload) => void sender.receive(payload), async () => { calls++; answer(); return true; },
    { authorize: (device, frame, credential) => directCaller(current, device, frame.sub, true, credential) });
  const originalNow = Date.now;
  t.after(() => { Date.now = originalNow; sender?.close(); receiver.stop(); });
  sender = directPeer({ signal: async payload => {
    if (payload.type === 'offer') payload = { ...payload, ...await auth.offer(net.self, payload) };
    if (allowDirectSignal(current, phone.id, payload)) await receiver.signal('audit', payload, null, phone.id);
  }, onMessage() {}, onClose: () => close(), connectTimeout: 5000 });
  await sender.ready;
  if (mode === 'an old expiry') {
    // Only removal signs a browser out; its expiry is for older Helm.
    Date.now = () => verifyToken(net.key, phone.token).exp + 1;
    await sender.send({ t: 'rpc', id: 'after', method: 'session.list' });
    await answered;
    assert.equal(calls, 1);
    assert.equal(receiver.count, 1);
    return;
  }
  current = structuredClone(net); current.self = 'ffffffffffff'; current.revoked[net.self] = Date.now(); delete current.machines[net.self];
  receiver.dropRevoked(current.revoked);
  await closed;
  assert.equal(calls, 0);
  assert.equal(receiver.count, 0);
});

// ----------------------------------------------------- review of c88228a

const spki = (pair) => pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const proofFrom = (net, purpose, claims, pair, issuer) => {
  const value = { ...claims, issuer };
  value.signature = sign(null, proofBody(net.id, purpose, value), pair.privateKey).toString('base64url');
  return value;
};
/** A second member: its own key, admitted by this machine, at `endpoint`. */
function member(net, id, endpoint, over = {}) {
  const pair = generateKeyPairSync('ed25519');
  const admission = N.admitMachine(net, id, spki(pair));
  net.machines[id] = signedRecord(net, { id, name: `m-${id.slice(0, 4)}`, endpoints: endpoint ? [endpoint] : [], admission, updatedAt: Date.now(), ...over }, pair);
  N.saveNetwork(net);
  return pair;
}

test('a fake hub that relays a hello to another member gets no credential', async t => {
  const { net, base } = await hubFor(t);
  const original = N.hubHello.post;
  t.after(() => { N.hubHello.post = original; });
  const asked = [];
  let strip = false;
  // Whatever the dialler asks of a remote address goes to this hub instead:
  // the relay needs no secret, and this hub signs as itself.
  N.hubHello.post = async (url, body, opts) => {
    asked.push(url);
    const answer = await original(`${base}${N.HELLO_PATH}`, body, opts);
    if (strip) delete answer.body.signed;
    return answer;
  };
  member(net, 'aabbccdd0001', 'https://x.example', { signedHub: true });
  member(net, 'aabbccdd0002', 'https://legacy.example');
  const dialler = N.loadNetwork();

  await assert.rejects(N.hubCredential(dialler, 'https://x.example'), (err) => err.untrusted);
  strip = true;
  await assert.rejects(N.hubCredential(dialler, 'https://x.example'), (err) => err.untrusted, 'an updated owner cannot be downgraded');
  // An owner that still runs an older Helm is dialled as before, with no hub name.
  const legacy = await N.hubCredential(dialler, 'https://legacy.example');
  assert.equal(verifyToken(net.key, legacy).aud, undefined);
  asked.length = 0;
  await assert.rejects(N.hubCredential(dialler, 'https://nobody.example'), /belongs to no machine/);
  assert.deepEqual(asked, [], 'nothing went to an address no member owns');

  // The honest path: the owner itself answers, and the credential names it.
  strip = false;
  N.hubHello.post = original;
  const credential = await N.hubCredential(dialler, base);
  assert.equal(verifyToken(net.key, credential).aud, net.self);
  const ask = (token) => fetch(`${base}/api/network`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await ask(credential)).status, 200);
  const hello = async () => (await (await fetch(`${base}${N.HELLO_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: 'n'.repeat(24) }) })).json()).challenge;
  assert.equal((await ask(N.oneTimeToken(dialler, await hello(), 'aabbccdd0001'))).status, 401, 'a credential for another hub');
  assert.equal((await ask(N.oneTimeToken(dialler, await hello()))).status, 401, 'an updated machine always names the hub');
});

test('gossip admits a new machine only with a receipt from a known member', () => {
  const net = N.createNetwork();
  const attacker = generateKeyPairSync('ed25519');
  const evil = signedRecord(net, { id: 'deadbeef0001', name: 'evil', endpoints: ['https://evil.example'], pubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEVIL', updatedAt: Date.now() }, attacker);
  assert.equal(N.mergeRoster(net, { id: net.id, machines: { [evil.id]: evil } }), false);
  assert.equal(N.loadNetwork().machines[evil.id], undefined);
  assert.equal(N.hubTrust(N.loadNetwork()).machines[evil.id], undefined);

  // A receipt it wrote for itself, or one for another key, is not enough.
  const self = proofFrom(net, 'machine-admission', { machine: evil.id, key: spki(attacker), at: Date.now() }, attacker, evil.id);
  const own = signedRecord(net, { ...evil, admission: self }, attacker);
  assert.equal(N.mergeRoster(net, { id: net.id, machines: { [evil.id]: own } }), false);
  const other = generateKeyPairSync('ed25519');
  const wrongKey = signedRecord(net, { ...evil, admission: N.admitMachine(net, evil.id, spki(other)) }, attacker);
  assert.equal(N.mergeRoster(net, { id: net.id, machines: { [evil.id]: wrongKey } }), false);

  // A receipt from this machine admits it. A chain works within one roster.
  const fresh = N.loadNetwork();
  const a = generateKeyPairSync('ed25519'), b = generateKeyPairSync('ed25519');
  const ra = signedRecord(fresh, { id: 'aaaa00000001', name: 'a', endpoints: [], admission: N.admitMachine(fresh, 'aaaa00000001', spki(a)), updatedAt: Date.now() }, a);
  const rb = signedRecord(fresh, { id: 'bbbb00000001', name: 'b', endpoints: [], admission: proofFrom(fresh, 'machine-admission', { machine: 'bbbb00000001', key: spki(b), at: Date.now() }, a, 'aaaa00000001'), updatedAt: Date.now() }, b);
  assert.equal(N.mergeRoster(fresh, { id: fresh.id, machines: { [rb.id]: rb, [ra.id]: ra } }), true);
  const after = N.loadNetwork();
  assert.ok(after.machines.aaaa00000001 && after.machines.bbbb00000001);
});

test('a machine that joins carries the inviter receipt in its own record', async t => {
  const { net, base } = await hubFor(t);
  const credential = await N.hubCredential(net, base);
  const { code } = await (await fetch(`${base}/api/invite`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: '{}' })).json();
  const joiner = generateKeyPairSync('ed25519');
  const res = await fetch(`${base}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, self: 'cccc00000001', name: 'joiner', codeSignPubkey: spki(joiner) }) });
  const body = await res.json();
  assert.equal(body.admission.issuer, net.self);
  assert.equal(body.admission.key, spki(joiner));
  // Another member that never saw the join accepts the joiner's own signed record.
  const record = signedRecord(net, { id: 'cccc00000001', name: 'joiner', endpoints: [], admission: body.admission, updatedAt: Date.now() + 1 }, joiner);
  const elsewhere = N.loadNetwork();
  delete elsewhere.machines.cccc00000001;
  N.saveNetwork(elsewhere);
  assert.equal(N.mergeRoster(elsewhere, { id: net.id, machines: { [record.id]: record } }), true);
});

test('desktop sign-in refuses forwarded traffic and odd browser keys', async t => {
  const { net, base } = await hubFor(t);
  N.advertise(N.loadNetwork(), ['https://current.example']);
  const plain = { 'content-type': 'application/json', origin: 'https://current.example' };
  const post = (headers, body = { network: net.id }) => fetch(`${base}/api/auth/desktop`, { method: 'POST', headers, body: JSON.stringify(body) });
  for (const extra of [{ 'x-forwarded-for': '192.0.2.10' }, { forwarded: 'for=192.0.2.10' }, { 'x-forwarded-host': 'current.example' }]) {
    assert.equal((await post({ ...plain, ...extra })).status, 403, JSON.stringify(extra));
  }
  assert.equal((await post(plain, { network: net.id, proofKey: 'x'.repeat(600) })).status, 400);
  assert.equal((await post(plain)).status, 200);
});

test('the invitation address ends when the inviter advertises or after a day', () => {
  const net = N.createNetwork();
  const owner = member(net, '0123456789ab', null);
  const fresh = N.loadNetwork();
  fresh.bootstrap = { machine: '0123456789ab', url: 'https://old-invite.example', at: Date.now() };
  N.saveNetwork(fresh);
  assert.ok(N.allEndpoints(N.loadNetwork()).includes('https://old-invite.example'));
  assert.deepEqual(N.addressOwners(N.loadNetwork(), 'https://old-invite.example'), ['0123456789ab']);
  assert.equal(N.bootstrapAddress({ ...fresh, bootstrap: { ...fresh.bootstrap, at: Date.now() - N.BOOTSTRAP_TTL_MS - 1 } }), null);
  assert.equal(N.bootstrapAddress({ ...fresh, bootstrap: { machine: '0123456789ab', url: 'https://old-invite.example' } }), null, 'an older note with no time is not used');
  const moved = signedRecord(fresh, { ...fresh.machines['0123456789ab'], endpoints: ['https://new-home.example'], updatedAt: Date.now() + 1 }, owner);
  assert.equal(N.mergeRoster(fresh, { id: fresh.id, machines: { [moved.id]: moved } }), true);
  const after = N.loadNetwork();
  assert.equal(after.bootstrap, undefined);
  assert.equal(N.allEndpoints(after).includes('https://old-invite.example'), false);
});

test('forwarded requests are never local for the window, certificates or sockets', async t => {
  const { net, base } = await hubFor(t);
  const host = `127.0.0.1:${net.port}`;
  const close = await fetch(`${base}/api/window/close`, { method: 'POST', headers: { origin: `http://${host}`, forwarded: 'for=192.0.2.10' } });
  assert.notEqual(close.status, 204);
  const ask = await fetch(`${base}/api/share/ask?domain=x.example`, { headers: { 'x-forwarded-host': 'x.example' } });
  assert.notEqual(await ask.text(), 'ok');
});
