import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Signing in without a pairing link, on the machine itself.
//
// The danger this guards is specific: the VM's Caddy terminates HTTPS and
// proxies to the hub over loopback, so a request from the internet arrives at
// the hub looking exactly as local as a browser on the box. Being on 127.0.0.1
// therefore cannot be the credential - the local key, which only this
// machine's user can read, is.
const dir = mkdtempSync(join(tmpdir(), 'helm-local-login-'));
process.env.HELM_DIR = dir;
process.env.HELM_DB = join(dir, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';

const PORT = 18974;

const login = (body, port = PORT) =>
  fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a browser on this machine signs in with the local key, and nothing else does', async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { createNetwork, localKey } = await import('@helm/protocol/network');
  const { startRelay } = await import('@helm/relay');

  createNetwork({ name: 'test', port: PORT });
  const hub = await startRelay({ port: PORT, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => hub.stop());

  // What `helm open` puts in the fragment.
  const ok = await login({ local: localKey(), label: 'this machine' });
  assert.equal(ok.status, 200);
  const issued = await ok.json();
  assert.ok(issued.token, 'the local key should issue a normal device token');
  assert.equal(issued.local, true);

  // That token is an ordinary device token: it works on the API.
  const net = await fetch(`http://127.0.0.1:${PORT}/api/network`, {
    headers: { authorization: `Bearer ${issued.token}` },
  });
  assert.equal(net.status, 200);

  // Anyone arriving through Caddy is on loopback too, and has no key.
  const anonymous = await login({ label: 'someone on the internet' });
  assert.equal(anonymous.status, 401);

  const guessed = await login({ local: 'not-the-key', label: 'someone on the internet' });
  assert.equal(guessed.status, 401);

  // A key of a different length must not shortcut the comparison either.
  const short = await login({ local: 'x', label: 'someone on the internet' });
  assert.equal(short.status, 401);

  // The pairing password still works, and is still what a phone uses.
  const paired = await login({ password: hub.password, label: 'phone' });
  assert.equal(paired.status, 200);
  assert.equal((await paired.json()).local, undefined);
});

test('this machine keeps one browser credential, not one per page load', async (t) => {
  const PORT3 = PORT + 2;
  const dir3 = mkdtempSync(join(tmpdir(), 'helm-local-once-'));
  process.env.HELM_DIR = dir3;
  t.after(() => rmSync(dir3, { recursive: true, force: true }));

  const N = await import('@helm/protocol/network');
  const { startRelay } = await import('@helm/relay');
  N.createNetwork({ name: 'laptop', port: PORT3 });
  const hub = await startRelay({ port: PORT3, host: '127.0.0.1', dbFile: join(dir3, 'hub.sqlite') });
  t.after(() => hub.stop());

  const signIn = (label) =>
    login({ local: N.localKey(), label }, PORT3).then((r) => r.json());

  // Three page loads with empty storage: a new browser profile, a cleared
  // site, a tab whose token this hub had just cut. Each used to leave another
  // permanent device behind - sixteen of them accumulated in three days.
  const first = await signIn('this machine');
  const second = await signIn('Linux Chrome');
  const third = await signIn('web');

  assert.equal(second.deviceId, first.deviceId);
  assert.equal(third.deviceId, first.deviceId);
  assert.equal(Object.keys(N.loadNetwork().devices).length, 1);

  // Each answer is a working token, not just the same id.
  for (const issued of [first, second, third]) {
    const res = await fetch(`http://127.0.0.1:${PORT3}/api/network`, {
      headers: { authorization: `Bearer ${issued.token}` },
    });
    assert.equal(res.status, 200);
  }

  // Removing it is not a lockout: the next load issues a fresh one, which is
  // what lets the owner prune without cutting themselves off their own box.
  N.revoke(N.loadNetwork(), first.deviceId);
  const after = await signIn('this machine');
  assert.notEqual(after.deviceId, first.deviceId);
  assert.equal(Object.keys(N.loadNetwork().devices).length, 1);

  // ...and the removed one stays removed.
  const dead = await fetch(`http://127.0.0.1:${PORT3}/api/network`, {
    headers: { authorization: `Bearer ${first.token}` },
  });
  assert.equal(dead.status, 401);
});

test('the page this machine serves can fetch the local key; a proxied or foreign request cannot', async (t) => {
  const PORT2 = PORT + 1;

  const { createNetwork, localKey } = await import('@helm/protocol/network');
  const { startRelay } = await import('@helm/relay');

  createNetwork({ name: 'test2', port: PORT2 });
  const hub = await startRelay({ port: PORT2, host: '127.0.0.1' });
  t.after(() => hub.stop());

  const local = (headers = {}) =>
    fetch(`http://127.0.0.1:${PORT2}/api/auth/local`, { method: 'POST', headers });

  // The app asking on its own behalf: loopback, loopback host, no cross-site
  // marker.
  const ok = await local();
  assert.equal(ok.status, 200);
  const { local: key } = await ok.json();
  assert.equal(key, localKey());
  // ...and the answer completes an ordinary login.
  const issued = await login({ local: key, label: 'desktop app' }, PORT2);
  assert.equal(issued.status, 200);
  assert.ok((await issued.json()).token);

  // What Caddy hands the hub for a request from the internet: the socket is
  // loopback but the Host is the public name. fetch() will not let a caller
  // set Host, so this one goes out on a raw socket.
  const proxied = await new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1', port: PORT2, path: '/api/auth/local', method: 'POST',
      headers: { host: 'public.example.com' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(proxied, 403);

  // DNS rebinding: a name that merely *starts* like a loopback one, pointed
  // at 127.0.0.1 after the page loaded, so the page is same-origin with us.
  const rebound = await new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1', port: PORT2, path: '/api/auth/local', method: 'POST',
      headers: { host: `localhost.evil.example:${PORT2}`, origin: `http://localhost.evil.example:${PORT2}`, 'sec-fetch-site': 'same-origin' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(rebound, 403);
  const prefixed = await new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1', port: PORT2, path: '/api/auth/local', method: 'POST',
      headers: { host: `127.0.0.1.nip.example:${PORT2}` },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(prefixed, 403);

  // A foreign website's fetch declares itself.
  const foreign = await local({ 'sec-fetch-site': 'cross-site' });
  assert.equal(foreign.status, 403);

  // And anything that is not the page's POST hits the same wall as every
  // other authenticated route.
  const anon = await fetch(`http://127.0.0.1:${PORT2}/api/auth/local`, { method: 'GET' });
  assert.equal(anon.status, 401);
});
