import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

const root = mkdtempSync(join(tmpdir(), 'helm-share-cli-'));
Object.assign(process.env, {
  HELM_DIR: join(root, 'helm'), HELM_DB: join(root, 'hub.sqlite'),
  HELM_SSH_DIR: join(root, 'ssh'), HELM_NO_SERVICE: '1',
  HELM_PROCS_SOCKET: join(root, 'procs.sock'), HELM_TERMINALS_SOCKET: join(root, 'terminals.sock'),
  HELM_NATIVE_SOCKET: join(root, 'native.sock'),
});
const N = await import('@helm/protocol/network');
const { T, M } = await import('@helm/protocol');
const BIN = fileURLToPath(new URL('../packages/connect/bin/helm.js', import.meta.url));
const TARGET = 'bb22', OTHER = 'cc33';
test.after(() => rmSync(root, { recursive: true, force: true }));

/** A private hub answers real CLI requests as three controlled machines. */
async function fixture(t, { modern = true, collision = false, listError = false, addError = false } = {}) {
  const net = N.createNetwork({ name: 'Source' });
  net.machines[TARGET] = { id: TARGET, name: 'Target', endpoints: [], addedAt: 1, updatedAt: 1 };
  net.machines[OTHER] = { id: OTHER, name: 'Other', endpoints: [], addedAt: 1, updatedAt: 1 };
  net.machines[net.self].endpoints = [];
  const calls = [], created = [];
  const server = createServer(async (req, res) => {
    if (req.url !== N.HELLO_PATH || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const { nonce } = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ net: net.id, challenge: 'share-cli-fixture', proof: N.hubProof(net, nonce) }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', ws => ws.on('message', bytes => {
    const frame = JSON.parse(bytes);
    if (frame.t !== T.RPC) return;
    calls.push({ env: frame.env, method: frame.method });
    let result, error;
    if (frame.method === M.SHARE_LIST) {
      if (frame.env === TARGET && listError) error = 'The target refused the name check.';
      else result = {
        shares: frame.env === OTHER && collision ? [{ name: 'demo', port: 9000 }] : [],
        ...(frame.env === TARGET && modern ? { features: ['private', 'name-check'] } : {}),
      };
    } else if (frame.method === M.SHARE_ADD && frame.env === TARGET) {
      if (addError) error = 'Another machine uses this link name. Choose another name.';
      else {
        const share = { name: frame.params.name, port: frame.params.port, expiresAt: Date.now() + 60000, password: false };
        created.push(share); result = { share };
      }
    } else error = 'Unexpected request in the private fixture.';
    ws.send(JSON.stringify({ t: T.RPC_RESULT, id: frame.id, ok: !error,
      ...(error ? { error: { code: 'denied', message: error } } : { result }) }));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  net.port = server.address().port; N.saveNetwork(net);
  t.after(async () => {
    for (const ws of sockets.clients) ws.terminate();
    server.closeAllConnections();
    await Promise.all([new Promise(resolve => sockets.close(resolve)), new Promise(resolve => server.close(resolve))]);
  });
  const run = () => new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.INVOCATION_ID;
    const child = spawn(process.execPath, [BIN, 'share', '3000', '--on', 'Target', '--name', 'demo'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode == null) child.kill(); });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { run, calls, created, self: net.self };
}

test('a new remote target owns the name check without a second CLI lookup on every machine', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Target, port 3000/);
  assert.deepEqual(f.calls, [{ env: TARGET, method: M.SHARE_LIST }, { env: TARGET, method: M.SHARE_ADD }]);
  assert.deepEqual(f.created.map(share => [share.name, share.port]), [['demo', 3000]]);
});

test('an older remote target keeps the CLI collision check and creates nothing on a collision', { timeout: 10000 }, async t => {
  const f = await fixture(t, { modern: false, collision: true });
  const result = await f.run();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /already shared from Other/);
  assert.deepEqual(f.calls.filter(call => call.method === M.SHARE_LIST).map(call => call.env).sort(),
    [f.self, TARGET, OTHER].sort());
  assert.equal(f.calls.some(call => call.method === M.SHARE_ADD), false);
  assert.deepEqual(f.created, []);
});

test('an older remote target can create a link after the CLI checks every other machine', { timeout: 10000 }, async t => {
  const f = await fixture(t, { modern: false });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.filter(call => call.method === M.SHARE_LIST).map(call => call.env).sort(),
    [f.self, TARGET, OTHER].sort());
  assert.deepEqual(f.calls.at(-1), { env: TARGET, method: M.SHARE_ADD });
  assert.equal(f.created.length, 1);
});

test('a failed target name check stops the CLI before it can create a link', { timeout: 10000 }, async t => {
  const f = await fixture(t, { listError: true });
  const result = await f.run();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /target refused the name check/);
  assert.deepEqual(f.calls, [{ env: TARGET, method: M.SHARE_LIST }]);
  assert.deepEqual(f.created, []);
});

test('a new target can refuse creation without a retry or a success message', { timeout: 10000 }, async t => {
  const f = await fixture(t, { addError: true });
  const result = await f.run();
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stderr, /Another machine uses this link name/);
  assert.doesNotMatch(result.stdout, /Target, port 3000/);
  assert.deepEqual(f.calls, [{ env: TARGET, method: M.SHARE_LIST }, { env: TARGET, method: M.SHARE_ADD }]);
  assert.deepEqual(f.created, []);
});
