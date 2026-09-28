import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `watchNetwork` is what lets a removal typed on one machine start moving at
 * once instead of at the next 15s tick. What matters is as much what it does
 * *not* do: two machines that have just merged each other's records must not
 * keep announcing to each other, so it speaks only when the roster's
 * fingerprint really changed - not on every write of the file.
 */

const dir = mkdtempSync(join(tmpdir(), 'helm-watch-'));
process.env.HELM_DIR = dir;
process.env.HELM_NO_SERVICE = '1';

const N = await import('@helm/protocol/network');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
};
const quiet = (ms) => new Promise((r) => setTimeout(r, ms));

test('a real roster change is announced within a moment, once', async () => {
  N.createNetwork({ name: 'laptop', port: 18999 });
  const seen = [];
  const stop = N.watchNetwork((_net, hash) => seen.push(hash), { debounceMs: 30 });
  t_after(stop);

  const { id } = N.issueDevice(N.loadNetwork(), 'phone');
  assert.ok(await until(() => seen.length >= 1), 'adding a device is announced');
  const afterAdd = seen.length;

  N.revoke(N.loadNetwork(), id);
  assert.ok(await until(() => seen.length > afterAdd), 'removing it is announced too');
  assert.equal(new Set(seen).size, seen.length, 'never the same fingerprint twice in a row');
});

test('rewriting the file without changing the roster stays silent', async () => {
  const seen = [];
  const stop = N.watchNetwork((_n, h) => seen.push(h), { debounceMs: 30 });
  t_after(stop);

  // Same content, written again - a machine re-describing an unchanged self.
  const file = join(dir, 'network.json');
  writeFileSync(file, readFileSync(file, 'utf8'), { mode: 0o600 });
  writeFileSync(file, readFileSync(file, 'utf8'), { mode: 0o600 });
  await quiet(300);
  assert.deepEqual(seen, [], 'no announcement for a write that changed nothing');
});

test('a burst of writes is one announcement, and stopping ends it', async () => {
  const seen = [];
  const stop = N.watchNetwork((_n, h) => seen.push(h), { debounceMs: 60 });

  for (let i = 0; i < 4; i++) N.issueDevice(N.loadNetwork(), `burst-${i}`);
  assert.ok(await until(() => seen.length >= 1));
  await quiet(250);
  assert.equal(seen.length, 1, 'four writes inside the debounce window are one event');

  stop();
  N.issueDevice(N.loadNetwork(), 'after-stop');
  await quiet(300);
  assert.equal(seen.length, 1, 'a stopped watcher says nothing');
});

// Tiny local helper so a failing assertion still releases its watcher.
function t_after(fn) { cleanups.push(fn); }
const cleanups = [];
test.after(() => cleanups.forEach((f) => f()));
