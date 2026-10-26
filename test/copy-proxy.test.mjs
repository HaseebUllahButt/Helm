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
