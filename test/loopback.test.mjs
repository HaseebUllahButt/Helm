import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connectLoopback, checkSharePort } from '../packages/connect/src/loopback.js';

const root = mkdtempSync(join(tmpdir(), 'helm-loopback-'));
process.env.HELM_DIR = root;
process.env.HELM_NO_SERVICE = '1';
const N = await import('@helm/protocol/network');
N.createNetwork({ name: 'loopback-test', port: 18789 });
const { Daemon } = await import('../packages/connect/src/agent.js');
const { listShares } = await import('../packages/connect/src/shares.js');
const { T, M } = await import('@helm/protocol');
test.after(() => rmSync(root, { recursive: true, force: true }));

for (const host of ['127.0.0.1', '::1', '0.0.0.0']) {
  test(`a shared app bound to ${host} passes the probe and opens a real daemon tunnel`, async (t) => {
    const app = createServer((socket) => { socket.on('error', () => {}); socket.end('hello'); });
    await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, host, resolve); });
    t.after(() => app.close());
    const port = app.address().port;
    await checkSharePort(port);
    const daemon = new Daemon({ port: 18789, advertiseLan: false });
    t.after(() => daemon.stop());
    await daemon.dispatch(M.SHARE_ADD, { name: 'bound-app', port, replace: true });
    const frames = [];
    await new Promise((resolve) => {
      daemon.onFrame({ id: 'test-hub', send: (type, extra) => {
        frames.push({ type, ...extra });
        if (type === T.TUNNEL_CLOSE) resolve();
      } }, { t: T.TUNNEL_OPEN, sid: 'test', port });
    });
    assert.ok(frames.some((frame) => frame.type === T.TUNNEL_READY));
    assert.equal(Buffer.from(frames.find((frame) => frame.type === T.TUNNEL_DATA).data, 'base64').toString(), 'hello');
    await daemon.dispatch(M.SHARE_REMOVE, { name: 'bound-app' });
  });
}

test('a closed port reports both addresses; the CLI and app refuse to publish it', async (t) => {
  const unused = createServer();
  await new Promise((resolve) => unused.listen(0, '127.0.0.1', resolve));
  const port = unused.address().port;
  await new Promise((resolve) => unused.close(resolve));
  const message = new RegExp(`127\\.0\\.0\\.1:${port} or \\[::1\\]:${port}.*Start the app`);
  await assert.rejects(() => checkSharePort(port), message);
  const socket = connectLoopback(port);
  await new Promise((resolve) => socket.on('error', (error) => { assert.match(error.message, message); resolve(); }));
  const daemon = new Daemon({ port: 18789, advertiseLan: false });
  t.after(() => daemon.stop());
  await assert.rejects(() => daemon.dispatch(M.SHARE_ADD, { name: 'closed-app', port }), message);
  await assert.rejects(() => promisify(execFile)(process.execPath, ['packages/connect/bin/helm.js', 'share', String(port), '--name', 'closed-cli'], { env: process.env }), message);
  assert.deepEqual(listShares(), []);
});
