import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const root = mkdtempSync(join(tmpdir(), 'helm-boundaries-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_NO_SERVICE = '1';
delete process.env.INVOCATION_ID;

const PORT = 18991;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;

const N = await import('@helm/protocol/network');
const { mintToken, newNetworkId, newNetworkKey, ROLE } = await import('@helm/protocol/identity');
const NAS = await import('@helm/nas');
const { startRelay } = await import('@helm/relay');
const { join: joinNet } = await import('../packages/connect/src/serve.js');

const net = N.createNetwork({ name: 'box', port: PORT });
const hub = await startRelay({ port: PORT, dbFile: process.env.HELM_DB, host: '127.0.0.1' });
const phone = N.issueDevice(net, 'phone');
const MACHINE = N.machineToken(net);

test.after(() => { hub.stop(); rmSync(root, { recursive: true, force: true }); });

const signed = (claims) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const mac = createHmac('sha256', Buffer.from(net.key, 'base64url'))
    .update(payload).digest('base64url');
  return `helm1.${payload}.${mac}`;
};

const bearer = (t) => ({ authorization: `Bearer ${t}` });

const wsHello = (token, viaSubprotocol = false) => new Promise((resolve, reject) => {
  const ws = viaSubprotocol
    ? new WebSocket(`${WS}/ws`, ['helm', token])
    : new WebSocket(`${WS}/ws`, { headers: bearer(token) });
  ws.once('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { m = {}; }
    ws.close();
    resolve(m);
  });
  ws.on('unexpected-response', (_req, res) => resolve({ httpStatus: res.statusCode }));
  ws.on('error', reject);
});

test('authenticate admits real members and refuses everything else', () => {
  const current = () => N.loadNetwork();

  assert.ok(N.authenticate(current(), mintToken(net.key, {
    net: net.id, sub: 'eeff00112233', role: ROLE.MACHINE,
  })), 'unknown machine id still authenticates');
  assert.ok(N.authenticate(current(), mintToken(net.key, {
    net: net.id, sub: phone.id, role: ROLE.DEVICE,
  })), 'a rostered device authenticates');

  for (const sub of [phone.id, net.self]) {
    const { ticket } = NAS.mediaTicket(current(), { sub, env: net.self });
    assert.equal(N.authenticate(current(), ticket), null, `media ticket for ${sub}`);
  }

  assert.equal(N.authenticate(current(), signed({ net: net.id, sub: net.self, role: 'root' })), null);
  assert.equal(N.authenticate(current(), mintToken(net.key, {
    net: net.id, sub: net.self, role: ROLE.DEVICE,
  })), null, 'a device claim cannot name a machine');
  assert.equal(N.authenticate(current(), mintToken(net.key, {
    net: net.id, sub: 'eeff00112233', role: ROLE.DEVICE,
  })), null, 'a device claim must name a rostered device');
  assert.equal(N.authenticate(current(), mintToken(net.key, {
    net: net.id, role: ROLE.MACHINE,
  })), null, 'no sub');
  assert.equal(N.authenticate(current(), mintToken(net.key, {
    net: net.id, sub: 'Not-Hex!', role: ROLE.MACHINE,
  })), null, 'a sub that is not a member id');

  assert.equal(N.authenticate(current(), signed(['not', 'claims'])), null);
  assert.equal(N.authenticate(current(), signed(42)), null);
  assert.equal(N.authenticate(current(), signed(null)), null);

  const gone = N.issueDevice(current(), 'gone');
  N.revoke(N.loadNetwork(), gone.id);
  assert.equal(N.authenticate(N.loadNetwork(), gone.token), null);
});

test('a media ticket is not a bearer credential on the HTTP API', async () => {
  const current = N.loadNetwork();
  const tickets = [
    NAS.mediaTicket(current, { sub: phone.id, env: net.self }).ticket,
    NAS.mediaTicket(current, { sub: net.self, env: net.self }).ticket,
  ];
  for (const ticket of tickets) {
    assert.equal(
      (await fetch(`${BASE}/api/network`, { headers: bearer(ticket) })).status, 401);
    assert.equal((await fetch(`${BASE}/api/auth/rotate`, {
      method: 'POST',
      headers: { ...bearer(ticket), 'content-type': 'application/json' },
      body: '{}',
    })).status, 401);
  }
  assert.equal((await fetch(`${BASE}/api/network`, { headers: bearer(phone.token) })).status, 200);
  assert.equal((await fetch(`${BASE}/api/network`, { headers: bearer(MACHINE) })).status, 200);
});

test('a media ticket cannot upgrade to a socket', async () => {
  const current = N.loadNetwork();
  for (const sub of [phone.id, net.self]) {
    const { ticket } = NAS.mediaTicket(current, { sub, env: net.self });
    assert.equal((await wsHello(ticket)).httpStatus, 401, `header ticket for ${sub}`);
    assert.equal((await wsHello(ticket, true)).httpStatus, 401, `subprotocol ticket for ${sub}`);
  }
  const hello = await wsHello(phone.token);
  assert.equal(hello.role, 'client');
});

test('a device credential never becomes an environment, whatever its subject', async () => {
  const ghostId = 'aa00bb11cc22';
  const holder = N.loadNetwork();
  holder.machines[ghostId] = {
    id: ghostId, name: 'other', endpoints: [], updatedAt: Date.now(), addedAt: Date.now(),
  };
  holder.devices[ghostId] = {
    id: ghostId, label: 'impostor', updatedAt: Date.now(), addedAt: Date.now(),
  };
  N.saveNetwork(holder);
  try {
    const impostor = mintToken(net.key, { net: net.id, sub: ghostId, role: ROLE.DEVICE });
    const hello = await wsHello(impostor);
    assert.equal(hello.role, 'client', 'device credential attaches as a client');
    assert.equal(hello.envId, undefined);
    assert.equal(hub.online.has(ghostId), false, 'no env slot was claimed');
  } finally {
    const back = N.loadNetwork();
    delete back.devices[ghostId];
    delete back.machines[ghostId];
    N.saveNetwork(back);
  }
});

const mode = (path) => lstatSync(path).mode & 0o777;
const helmDir = () => process.env.HELM_DIR;

test('writing the network repairs a loose directory and file', () => {
  const file = join(helmDir(), 'network.json');
  chmodSync(helmDir(), 0o755);
  chmodSync(file, 0o644);
  N.saveNetwork(N.loadNetwork());
  assert.equal(mode(helmDir()), 0o700);
  assert.equal(mode(file), 0o600);
});

test('an existing loose local key is tightened, not replaced', () => {
  const file = join(helmDir(), 'local.key');
  const before = N.localKey();
  chmodSync(helmDir(), 0o755);
  chmodSync(file, 0o644);
  assert.equal(N.localKey(), before, 'the same key comes back');
  assert.equal(mode(helmDir()), 0o700);
  assert.equal(mode(file), 0o600);
});

test('the code-transfer keys are tightened on reuse, not reissued', async () => {
  const CT = await import('../packages/connect/src/code-transfer.js');
  const cipher = CT.codeKeyInfo().codePubkey;
  const signer = CT.codeSigningInfo().codeSignPubkey;
  const files = ['code_x25519', 'code_x25519.pub', 'code_ed25519', 'code_ed25519.pub'];
  chmodSync(helmDir(), 0o755);
  for (const f of files) chmodSync(join(helmDir(), f), 0o644);

  assert.equal(CT.codeKeyInfo().codePubkey, cipher, 'the key is unchanged');
  assert.equal(CT.codeSigningInfo().codeSignPubkey, signer);
  assert.equal(mode(helmDir()), 0o700);
  for (const f of files) assert.equal(mode(join(helmDir(), f)), 0o600, f);
});

test('profile and secrets writes land 0600 inside a repaired helm dir', async () => {
  const P = await import('../packages/connect/src/profiles.js');
  writeFileSync(join(helmDir(), 'profiles.json'), '{}', { mode: 0o644 });
  writeFileSync(join(helmDir(), 'secrets.env'), 'FIXTURE=synthetic\n', { mode: 0o644 });
  chmodSync(helmDir(), 0o755);

  P.saveProfiles([{ id: 'fixture', engine: 'x' }]);
  P.saveSecrets({ FIXTURE_TWO: 'synthetic' });

  assert.equal(mode(helmDir()), 0o700);
  assert.equal(mode(join(helmDir(), 'profiles.json')), 0o600);
  assert.equal(mode(join(helmDir(), 'secrets.env')), 0o600);
});

test('join refuses anything but a bare https origin or literal loopback http', async () => {
  N.forgetNetwork();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => { calls += 1; return realFetch(...args); };
  try {
    for (const at of [
      'http://home.example:8787',
      'http://192.168.1.5:8787',
      'http://[::ffff:127.0.0.1]:8787',
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example:8787',
      'ftp://127.0.0.1:8787',
      'https://user:pass@home.example',
      'https://home.example/some/path',
      'https://home.example/?x=1',
      'https://home.example/#frag',
      'not a url',
      '',
    ]) {
      await assert.rejects(() => joinNet({ code: 'AAAA-BBBB', at }), /https|loopback/i, at);
    }
    assert.equal(calls, 0, 'a refused address never reaches fetch');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an https origin passes the gate without touching the network', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), opts });
    return {
      ok: true,
      json: async () => ({
        id: newNetworkId(), key: newNetworkKey(), self: 'aa11bb22cc33',
        machines: {}, devices: {}, revoked: {}, role: 'pc',
      }),
    };
  };
  try {
    N.forgetNetwork();
    const joined = await joinNet({ code: 'AAAA-BBBB', at: 'https://home.example:8787/', name: 'x' });
    assert.ok(joined.id, 'joined over the stubbed https answer');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://home.example:8787/api/join', 'the root slash is trimmed');
    assert.equal(seen[0].opts.redirect, 'error');
  } finally {
    globalThis.fetch = realFetch;
    N.forgetNetwork();
  }
});

test('join accepts a real loopback invite and refuses a redirect', async (t) => {
  const joinHits = [];
  const answer = {
    id: newNetworkId(), key: newNetworkKey(), self: 'aa11bb22cc33',
    machines: {}, devices: {}, revoked: {}, role: 'pc',
  };
  const server = createServer((req, res) => {
    joinHits.push(req.url);
    if (req.url === '/api/join') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(answer));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  N.forgetNetwork();
  const joined = await joinNet({ code: 'AAAA-BBBB', at: `http://127.0.0.1:${port}` });
  assert.equal(joined.id, answer.id);
  assert.equal(N.loadNetwork().id, answer.id);
  assert.equal(mode(join(helmDir(), 'network.json')), 0o600);

  N.forgetNetwork();
  const redirector = createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/api/join` }).end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  t.after(() => redirector.close());
  await assert.rejects(
    () => joinNet({ code: 'AAAA-BBBB', at: `http://127.0.0.1:${redirector.address().port}` }),
  );
  assert.equal(joinHits.filter((u) => u === '/api/join').length, 1,
    'the redirect was never followed into the join route again');

  N.forgetNetwork();
  const named = await joinNet({ code: 'AAAA-BBBB', at: `http://localhost:${port}/` });
  assert.equal(named.id, answer.id);
  N.forgetNetwork();
});
