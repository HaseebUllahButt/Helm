import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A revocation typed on a laptop (`helm remove`) has to reach the VM's hub,
// even though the laptop's daemon is the one dialling out and the VM never
// dials the laptop. The daemon offers a roster hash every tick; when the hub
// answers with a roster that teaches the daemon nothing, the daemon still has
// to send its own, or the two sides disagree forever - and the removed phone
// keeps working on the VM.
//
// Needs a real daemon, which needs herdr. Skipped when herdr is not running.

const root = mkdtempSync(join(tmpdir(), 'helm-gossip-'));
const A = join(root, 'A');
const B = join(root, 'B');
const PA = 18991;
const PB = 18992;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.HELM_DIR = B;
process.env.HELM_DB = join(B, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(B, 'ssh');
process.env.HELM_NO_SERVICE = '1';

let herdrRunning = false;
try {
  herdrRunning = /status:\s*running/.test(
    execFileSync(process.env.HELM_HERDR_BIN || 'herdr', ['status'], { timeout: 5000 }).toString()
  );
} catch { /* not installed */ }

test('a revocation made on a dialling-out machine reaches the hub it dials', {
  skip: !herdrRunning && 'herdr is not running',
  timeout: 120_000,
}, async (t) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Hub A: the "VM", in its own process so it has its own HELM_DIR.
  const hubA = spawn(process.execPath, ['test/hub.mjs', String(PA), 'new'], {
    env: { ...process.env, HELM_DIR: A, HELM_DB: join(A, 'hub.sqlite'), NAME: 'vm' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  t.after(() => hubA.kill());
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PA}/api/health`)).ok) break; } catch { /* starting */ }
    await sleep(100);
  }

  // Machine B: the "laptop", joined with A's key and knowing A's address.
  const netA = JSON.parse(readFileSync(join(A, 'network.json'), 'utf8'));
  const N = await import('@helm/protocol/network');
  const machines = { ...netA.machines };
  machines[netA.self] = { ...machines[netA.self], endpoints: [`http://127.0.0.1:${PA}`] };
  N.joinNetwork({
    id: netA.id, key: netA.key, name: 'laptop', port: PB, machines, devices: {}, revoked: {},
  });

  const { startRelay } = await import('@helm/relay');
  const hubB = await startRelay({ port: PB, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => hubB.stop());
  const { Daemon } = await import('../packages/connect/src/agent.js');
  const daemon = new Daemon({ name: 'laptop', port: PB, advertiseLan: false });
  await daemon.start();
  t.after(() => daemon.stop());

  const tokenA = N.machineToken(netA);
  const onlineAtA = async () => {
    const res = await fetch(`http://127.0.0.1:${PA}/api/network`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    return (await res.json()).machines.filter((m) => m.online).length;
  };
  for (let i = 0; i < 50 && (await onlineAtA()) < 1; i++) await sleep(100);
  assert.equal(await onlineAtA(), 1, 'the laptop daemon must be attached to hub A');

  // A phone pairs on A. Written into A's roster the way /api/auth/login does.
  const device = JSON.parse(execFileSync(process.env.execPath || 'node', ['-e', `
    import('@helm/protocol/network').then((N) => {
      console.log(JSON.stringify(N.issueDevice(N.loadNetwork(), 'phone')));
    });`], { env: { ...process.env, HELM_DIR: A } }).toString());
  const phoneOnA = async () => (await fetch(`http://127.0.0.1:${PA}/api/network`, {
    headers: { authorization: `Bearer ${device.token}` },
  })).status;
  assert.equal(await phoneOnA(), 200);

  // B learns the device from A on its next tick (15s).
  for (let i = 0; i < 80 && !N.loadNetwork().devices[device.id]; i++) await sleep(250);
  assert.ok(N.loadNetwork().devices[device.id], 'B should learn the device from A');

  // `helm remove` on B.
  N.revoke(N.loadNetwork(), device.id);

  // Two full reconcile ticks is more than enough if the gossip is symmetric.
  const deadline = Date.now() + 35_000;
  let code = await phoneOnA();
  while (code !== 401 && Date.now() < deadline) { await sleep(250); code = await phoneOnA(); }
  assert.equal(code, 401, 'hub A must honour a revocation made on B within two ticks');
});
