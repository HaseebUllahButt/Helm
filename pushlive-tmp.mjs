import { createServer } from 'node:http';
import { createECDH, createHmac, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';

const HOME = process.env.HOME;
const b64 = (b) => Buffer.from(b).toString('base64url');
const extract = (salt, ikm) => createHmac('sha256', salt).update(ikm).digest();
const expand = (prk, info, len) =>
  createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);

// A stand-in browser: a real P-256 keypair, so the payload can be decrypted
// exactly the way a phone would.
const ua = createECDH('prime256v1'); ua.generateKeys();
const authSecret = Buffer.from('0123456789abcdef', 'utf8').subarray(0, 16);

function decrypt(body) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const prkKey = extract(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = expand(prkKey, keyInfo, 32);
  const prk = extract(salt, ikm);
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  return JSON.parse(out.subarray(0, out.length - 1).toString('utf8')); // strip the 0x02 delimiter
}

const got = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { got.push(Buffer.concat(chunks)); res.writeHead(201).end(); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const endpoint = `http://127.0.0.1:${port}/stub-phone`;
console.log('stub push service on', endpoint);

// Register it the way the hub would.
const db = new DatabaseSync(`${HOME}/.helm/hub.sqlite`);
db.prepare(`INSERT INTO push_subs (endpoint, device_id, p256dh, auth, label, created_at)
  VALUES (?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`)
  .run(endpoint, 'stub-device', b64(ua.getPublicKey()), b64(authSecret), 'stub phone', Date.now());
db.close();
console.log('subscription registered');

// Now make a session actually block.
const net = JSON.parse(readFileSync(`${HOME}/.helm/network.json`, 'utf8'));
const envId = net.self;
const auth = await (await fetch('http://127.0.0.1:8787/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: process.env.PASS, label: 'pushtest' }),
})).json();
if (!auth.token) { console.log('LOGIN FAILED', JSON.stringify(auth)); process.exit(1); }
const ws = new WebSocket('ws://127.0.0.1:8787/ws', ['helm', auth.token]);
let id = 0; const w = new Map();
ws.on('message', (r) => { const m = JSON.parse(r); if (m.t === 'rpcResult' && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } });
await new Promise((r) => ws.on('open', r));
const rpc = (method, params = {}, ms = 120000) => new Promise((res, rej) => {
  const i = ++id; const to = setTimeout(() => rej(new Error(method + ' timeout')), ms);
  w.set(i, (m) => { clearTimeout(to); m.ok ? res(m.result) : rej(new Error(m.error?.message || 'fail')); });
  ws.send(JSON.stringify({ t: 'rpc', id: i, env: envId, method, params }));
});

const { session } = await rpc('session.start', { cwd: `${HOME}/helm-image-check`, profileId: 'claudea', mode: 'ask' });
console.log('session', session.id, 'mode ask');
await rpc('session.input', { id: session.id, data: 'Run the shell command `echo helm-push-probe` using your Bash tool. Do not ask me anything first, just call the tool.' });
console.log('sent; waiting for it to block…');

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  if (got.length) break;
}
if (!got.length) {
  const log = await rpc('session.events', { id: session.id, since: 0 });
  console.log('NO PUSH. events seen:', (log.events ?? []).map((e) => e.type).join(', '));
} else {
  console.log('\n=== the stub phone received', got.length, 'push(es) ===');
  console.log('decrypted:', JSON.stringify(decrypt(got[0]), null, 2));
}
await rpc('session.kill', { id: session.id }).catch(() => {});
server.close(); ws.close(); process.exit(0);
