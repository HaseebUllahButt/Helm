import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, restoreBackup } from '../packages/connect/src/backup.js';
import { assertRestoreReviewed, REVIEW_FILE } from '../packages/connect/src/restore-guard.js';

test('encrypted offline backup keeps removals and receipts; restore cannot start saved work', t => {
  const root = mkdtempSync(join(tmpdir(), 'helm-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), archive = join(root, 'saved.helm');
  mkdirSync(source); mkdirSync(join(source, 'send-receipts'));
  const revoked = '{"revoked":{"removed-device":123}}';
  const receipt = '{"phase":"done","receipt":{"jobId":"already-done"}}';
  writeFileSync(join(source, 'network.json'), revoked);
  writeFileSync(join(source, 'send-receipts', 'completed.json'), receipt);
  writeFileSync(join(source, 'schedules.json'), '[{"pending":true}]');
  writeFileSync(join(source, 'hub.sqlite'), Buffer.from([0, 255, 37, 80]));
  const password = Buffer.from('private test secret with enough bytes');
  assert.throws(() => createBackup({ source, destination: archive, password }), /Stop all writers/);
  createBackup({ source, destination: archive, password, offline: true });
  const bytes = readFileSync(archive);
  assert.equal(bytes.includes(Buffer.from('removed-device')), false);
  assert.throws(() => restoreBackup({ archive, destination: join(root, 'wrong'), password: Buffer.from('wrong secret long enough') }), /Cannot open/);
  assert.equal(existsSync(join(root, 'wrong')), false);
  const result = restoreBackup({ archive, destination: join(root, 'restore'), password });
  assert.equal(result.blocked, true);
  assert.equal(readFileSync(join(result.data, 'network.json'), 'utf8'), revoked);
  assert.equal(readFileSync(join(result.data, 'send-receipts/completed.json'), 'utf8'), receipt);
  assert.deepEqual(readFileSync(join(result.data, 'hub.sqlite')), Buffer.from([0, 255, 37, 80]));
  assert.throws(() => assertRestoreReviewed(result.directory), /blocked for review/);
  assert.throws(() => assertRestoreReviewed(result.data), /blocked for review/);
  assert.throws(() => restoreBackup({ archive, destination: result.directory, password }), /new empty/);
  assert.throws(() => restoreBackup({ archive, destination: source, password }), /new empty/);
  bytes[bytes.length - 1] ^= 1; writeFileSync(join(root, 'damaged'), bytes);
  assert.throws(() => restoreBackup({ archive: join(root, 'damaged'), destination: join(root, 'damage'), password }), /Cannot open/);
  assert.equal(existsSync(join(root, 'damage')), false);
  symlinkSync(join(source, 'network.json'), join(source, 'link'));
  assert.throws(() => createBackup({ source, destination: join(root, 'link-backup'), password, offline: true }), /regular files/);
  rmSync(join(source, 'link'));
  writeFileSync(join(source, REVIEW_FILE), 'invalid marker');
  assert.throws(() => assertRestoreReviewed(source), /blocked for review/);
});

test('an encrypted backup cannot write outside its restore folder', async t => {
  const { createCipheriv, randomBytes, scryptSync } = await import('node:crypto');
  const root = mkdtempSync(join(tmpdir(), 'helm-backup-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const password = Buffer.from('private path test secret');
  const salt = randomBytes(16), iv = randomBytes(12), magic = Buffer.from('HELMBK01');
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
  cipher.setAAD(magic);
  const body = Buffer.from(JSON.stringify({ format: 1, entries: [{ path: '../escaped', kind: 'file', data: 'aGk=' }] }));
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  const archive = join(root, 'unsafe.helm');
  writeFileSync(archive, Buffer.concat([magic, salt, iv, cipher.getAuthTag(), encrypted]));
  assert.throws(() => restoreBackup({ archive, destination: join(root, 'restore'), password }), /unsafe file record/);
  assert.equal(existsSync(join(root, 'escaped')), false);
  assert.equal(existsSync(join(root, 'restore')), false);
});


test('a failed archive write leaves no published or temporary backup', t => {
  const root = mkdtempSync(join(tmpdir(), 'helm-backup-full-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), destination = join(root, 'backup');
  mkdirSync(source); writeFileSync(join(source, 'record'), 'Keep this record');
  const password = Buffer.from('private failure test secret');
  assert.throws(() => createBackup({ source, destination, password, offline: true,
    write(file, bytes, options) {
      writeFileSync(file, bytes.subarray(0, 10), options);
      throw Object.assign(new Error('Disk is full'), { code: 'ENOSPC' });
    },
  }), /Disk is full/);
  assert.deepEqual(readdirSync(root), ['source']);
  writeFileSync(destination, 'Existing backup');
  assert.throws(() => createBackup({ source, destination, password, offline: true }), /EEXIST/);
  assert.equal(readFileSync(destination, 'utf8'), 'Existing backup');
  assert.deepEqual(readdirSync(root).sort(), ['backup', 'source']);
});
