import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beginTransferActivity, hasActiveTransfers } from '@helm/protocol/transfer-activity';

const root = mkdtempSync(join(tmpdir(), 'helm-transfer-leases-'));
test.after(() => rmSync(root, { force: true, recursive: true }));

test('updates remain blocked until every transfer has released its lease', () => {
  const dir = join(root, 'overlap');
  const first = beginTransferActivity(dir), second = beginTransferActivity(dir);
  assert.equal(hasActiveTransfers(dir), true);
  first(); first();
  assert.equal(hasActiveTransfers(dir), true);
  second();
  assert.equal(hasActiveTransfers(dir), false);
});

test('crashed and stale transfers do not block updates forever', () => {
  const dir = join(root, 'stale');
  const release = beginTransferActivity(dir);
  assert.equal(hasActiveTransfers(dir, Date.now() + 60_000), false);
  assert.deepEqual(readdirSync(dir), []);
  release();
  writeFileSync(join(dir, '2147483647-123456789012345678901234'), '');
  assert.equal(hasActiveTransfers(dir), false);
  assert.deepEqual(readdirSync(dir), []);
});
