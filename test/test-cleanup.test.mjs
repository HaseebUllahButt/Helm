import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { leftovers, runFolder, sweep, sweepCrashed } from '../scripts/test-cleanup.mjs';

const base = mkdtempSync(join(tmpdir(), 'helm-test-cleanup-'));
test.after(() => rmSync(base, { recursive: true, force: true }));
const linux = process.platform === 'linux';

// A program a test started and never stopped, detached like a leaked browser.
const leak = (folder) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 1000)'],
    { env: { ...process.env, TMPDIR: folder }, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.unref();
  child.stdout.once('data', () => resolve(child.pid));
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a run stops what its tests left running and removes its folder', { skip: !linux && 'reads /proc' }, async () => {
  const folder = runFolder(base);
  writeFileSync(join(folder, 'socket-stand-in'), '');
  const pid = await leak(folder);
  // Another run's program, or the owner's, is never touched.
  const other = await leak(join(base, 'not-this-run'));
  try {
    assert.deepEqual(leftovers(folder).map((p) => p.pid), [pid]);
    // It ignores a polite stop, so the sweep has to insist.
    const left = await sweep(folder, { graceMs: 200 });
    assert.deepEqual(left.map((p) => p.pid), [pid]);
    assert.match(left[0].command, /setInterval/);
    assert.equal(alive(pid), false);
    assert.equal(existsSync(folder), false);
    assert.equal(alive(other), true);
  } finally { try { process.kill(other, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {} }
});

test('the next run cleans a folder whose runner crashed, and leaves a live runner alone', async () => {
  const crashed = join(base, 'ht-999999999-abc');
  const live = join(base, `ht-${process.pid}-def`);
  mkdirSync(crashed); mkdirSync(live);
  await sweepCrashed(base);
  assert.equal(existsSync(crashed), false);
  assert.equal(existsSync(live), true);
});
