import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The owner's preferences reach every machine: an edit made on the laptop
// reaches the VM's hub at once, and an edit made on the VM reaches the laptop
// when it next offers its fingerprint, the way a machine that was off catches
// up. Two private machines, each with its own HELM_DIR; nothing of the
// owner's is touched. Needs a real daemon, which needs herdr.

const root = mkdtempSync(join(tmpdir(), 'helm-owner-sync-'));
const A = join(root, 'A');
const B = join(root, 'B');
const PA = 18993;
const PB = 18994;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.HELM_DIR = B;
process.env.HELM_DB = join(B, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(B, 'ssh');
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_PROCS_SOCKET = join(B, 'procs.sock');
process.env.HELM_TERMINALS_SOCKET = join(B, 'terminals.sock');
process.env.HELM_NATIVE_SOCKET = join(B, 'native.sock');

let herdrRunning = false;
try {
  herdrRunning = /status:\s*running/.test(
    execFileSync(process.env.HELM_HERDR_BIN || 'herdr', ['status'], { timeout: 5000 }).toString()
  );
} catch { /* not installed */ }

const until = async (check, ms) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(200);
  return check();
};

test('an edit on one machine reaches the other, both ways', {
  skip: !herdrRunning && 'herdr is not running',
  timeout: 90_000,
}, async (t) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hubA = spawn(process.execPath, ['test/hub.mjs', String(PA), 'new'], {
    env: { ...process.env, HELM_DIR: A, HELM_DB: join(A, 'hub.sqlite'), NAME: 'vm' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  t.after(() => hubA.kill());
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PA}/api/health`)).ok) break; } catch { /* starting */ }
    await sleep(100);
  }

  const netA = JSON.parse(readFileSync(join(A, 'network.json'), 'utf8'));
  const N = await import('@helm/protocol/network');
  const machines = { ...netA.machines };
  machines[netA.self] = { ...machines[netA.self], endpoints: [`http://127.0.0.1:${PA}`] };
  N.joinNetwork({ id: netA.id, key: netA.key, name: 'laptop', port: PB, machines, devices: {}, revoked: {} });

  const { startRelay } = await import('@helm/relay');
  const hubB = await startRelay({ port: PB, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => hubB.stop());
  const { Daemon } = await import('../packages/connect/src/agent.js');
  const { M } = await import('@helm/protocol');
  const O = await import('../packages/protocol/owner.js');
  const daemon = new Daemon({ name: 'laptop', port: PB, advertiseLan: false });
  await daemon.start();
  t.after(() => daemon.stop());
  const linked = () => daemon.live.some((l) => l.url.includes(String(PA)));
  assert.ok(await until(linked, 10_000), 'the laptop dials the VM');

  // Edited in the app on the laptop: the VM has it within seconds.
  const fileA = join(A, 'owner.json');
  const saved = await daemon.dispatch(M.OWNER_SET, { lines: ['Plain English', 'Ask before pushing'] });
  assert.equal(saved.record.where, 'laptop');
  const atA = () => existsSync(fileA) && JSON.parse(readFileSync(fileA, 'utf8'));
  assert.ok(await until(() => atA()?.lines?.includes('Ask before pushing'), 6_000), 'the VM learns the edit at once');
  assert.equal(O.ownerHash(atA()), O.ownerHash(O.loadOwner()));

  // Edited on the VM while nobody tells the laptop: the laptop's next
  // fingerprint (every 15s, and on every reconnect) brings it over.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    const O = await import('./packages/protocol/owner.js');
    O.editOwner({ lines: ['Plain English', 'Short replies'] }, { where: 'vm', why: 'Edited in the app' });`],
  { env: { ...process.env, HELM_DIR: A } });
  assert.ok(await until(() => O.loadOwner().lines.includes('Short replies'), 25_000), 'the laptop catches up');
  assert.equal(O.loadOwner().where, 'vm');
  const brief = daemon.sessions.delegationBrief();
  assert.match(brief, /\[Helm owner: What the owner wants from every agent:\n- Plain English\n- Short replies\]/);
});
