import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-copy-proxy-'));
process.env.HELM_DIR = root;
const { CopyConnections } = await import('../packages/connect/src/copy-proxy.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

function socket() {
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    close() { this.readyState = 3; this.emit('close'); },
  });
}

test('idle copy sockets handle errors and leave the shared pool', async () => {
  const pool = new CopyConnections(), first = socket(), next = socket();
  assert.equal(await pool.open('hub', () => first), first);
  first.emit('error', new Error('connection reset'));
  assert.equal(pool.sockets.size, 0);
  assert.equal(await pool.open('hub', () => next), next);
  first.close();
  assert.equal(await pool.open('hub', () => assert.fail('cached socket lost')), next);
  pool.close();
});

test('a closing copy socket is not reused before its close event', async () => {
  const pool = new CopyConnections(), ws = socket();
  await pool.open('hub', () => ws);
  ws.readyState = 2;
  await assert.rejects(pool.open('hub', () => assert.fail('unexpected connect')), /closed before use/);
  assert.equal(pool.sockets.size, 0);
  pool.remember('machine', { kind: 'signal', hub: 'hub' });
  pool.close();
  assert.equal(pool.routes.size, 0);
});

test('concurrent copies share one connection attempt', async () => {
  const pool = new CopyConnections(), ws = socket();
  let finish, calls = 0;
  const connect = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = pool.open('hub', connect), second = pool.open('hub', connect);
  await Promise.resolve();
  finish(ws);
  assert.deepEqual(await Promise.all([first, second]), [ws, ws]);
  assert.equal(calls, 1);
  pool.close();
});

const { copyProxy } = await import('../packages/connect/src/copy-proxy.js');
const { codeKeyInfo, codeSigningInfo } = await import('../packages/connect/src/code-transfer.js');
const { PassThrough } = await import('node:stream');
const args = ['--machine', 'bb22', '--target-folder', '/tmp/fixture', '--relay', '--', 'bb22', 'rsync', '--server', '-s'];
function copyOptions(extra = {}) {
  const keys = { ...codeSigningInfo(), codePubkey: codeKeyInfo().codePubkey };
  return {
    network: { self: 'aa11', machines: { aa11: { id: 'aa11', ...keys }, bb22: { id: 'bb22', endpoints: [], ...keys } }, revoked: {} },
    input: new PassThrough(), output: new PassThrough(), stderr: { write() {} },
    credential: async () => 'test-token', ...extra,
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('cancel a copy during credentials without starting a late socket', async () => {
  const controller = new AbortController(), entered = deferred(), credential = deferred();
  let sockets = 0;
  const result = copyProxy(args, copyOptions({ signal: controller.signal,
    credential: () => { entered.resolve(); return credential.promise; },
    socket: () => { sockets++; return socket(); },
  }));
  await entered.promise;
  controller.abort();
  assert.equal(await result, 12);
  credential.resolve('late-token');
  await new Promise(setImmediate);
  assert.equal(sockets, 0);
});

test('a copy timeout closes a socket that opens late without sending data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const entered = deferred(), connected = deferred(), ws = socket(), closed = deferred();
  ws.send = () => assert.fail('copy started after timeout');
  ws.once('close', closed.resolve);
  const result = copyProxy(args, copyOptions({ connectBudget: 200,
    socket: () => { entered.resolve(); return connected.promise; },
  }));
  await entered.promise;
  t.mock.timers.tick(200);
  assert.equal(await result, 12);
  connected.resolve(ws);
  await closed.promise;
  assert.equal(ws.readyState, 3);
});

test('a copy timeout releases a transport waiting for its signed ready proof', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const opened = deferred(), ws = socket(), sent = [];
  ws.send = raw => { const frame = JSON.parse(raw); sent.push(frame); if (frame.t === 'tunnel.open') opened.resolve(); };
  const result = copyProxy(args, copyOptions({ connectBudget: 200, socket: async () => ws }));
  await opened.promise;
  t.mock.timers.tick(200);
  assert.equal(await result, 12);
  assert.equal(ws.readyState, 3);
  assert.equal(ws.listenerCount('message'), 0);
  assert.equal(sent.at(-1).t, 'tunnel.close');
});

test('cancelling one copy preserves a shared connection attempt for another copy', async () => {
  const pool = new CopyConnections(), first = new AbortController(), second = new AbortController();
  const entered = deferred(), credential = deferred(), opened = deferred(), ws = socket();
  ws.send = raw => { if (JSON.parse(raw).t === 'tunnel.open') opened.resolve(); };
  const options = copyOptions({ connections: pool,
    credential: () => { entered.resolve(); return credential.promise; }, socket: async () => ws,
  });
  const one = copyProxy(args, { ...options, signal: first.signal });
  await entered.promise;
  const two = copyProxy(args, { ...options, signal: second.signal });
  first.abort();
  assert.equal(await one, 12);
  credential.resolve('token');
  await opened.promise;
  second.abort();
  assert.equal(await two, 12);
  assert.equal(ws.readyState, 1);
  pool.close();
});
