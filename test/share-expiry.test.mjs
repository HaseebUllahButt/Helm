import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the test's share file out of the real ~/.helm.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-shares-'));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

const { addShare, listShares, removeShare, DEFAULT_TTL_MS } = await import('../packages/connect/src/shares.js');

test('a new share ends after 3 hours by default', () => {
  const s = addShare({ name: 'spin-default', port: 3000 });
  assert.equal(DEFAULT_TTL_MS, 3 * 60 * 60 * 1000);
  assert.equal(s.expiresAt - s.createdAt, DEFAULT_TTL_MS);
  assert.ok(listShares().some((x) => x.name === 'spin-default'));
  removeShare('spin-default');
});

test('keep makes a share that does not end', () => {
  const s = addShare({ name: 'spin-kept', port: 3001, keep: true });
  assert.equal(s.expiresAt, undefined);
  assert.ok(listShares(Date.now() + 10 * DEFAULT_TTL_MS).some((x) => x.name === 'spin-kept'));
  removeShare('spin-kept');
});

test('an ended share is no longer listed, so its port cannot be reached', () => {
  addShare({ name: 'spin-old', port: 3002, ttlMs: 1000 });
  const later = Date.now() + 5000;
  assert.equal(listShares(later).some((x) => x.name === 'spin-old'), false);
  removeShare('spin-old');
});
