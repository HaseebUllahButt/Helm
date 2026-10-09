import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cleanCopyFolder, validateCopyServerArgs, createCopyCipher } from '../packages/connect/src/copy-transport.js';

test('copy receiver permits only absolute destinations and receiving rsync arguments', () => {
  assert.equal(cleanCopyFolder('/tmp/a b'), '/tmp/a b');
  for (const folder of ['/', '/tmp/..', 'relative', '/tmp/x\ncommand']) assert.throws(() => cleanCopyFolder(folder));
  assert.deepEqual(validateCopyServerArgs(['--server', '-slogDtpre.iLsfxCIvu']), ['--server', '-slogDtpre.iLsfxCIvu']);
  for (const args of [['--sender', '-s'], ['--server', '-s', '/tmp'], ['--server', '-s;sh'], ['--server', '--daemon']]) {
    assert.throws(() => validateCopyServerArgs(args));
  }
});

test('copy packets authenticate both directions, reject replay and reject tampering', () => {
  const a = generateKeyPairSync('x25519'), b = generateKeyPairSync('x25519');
  const pub = k => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const salt = randomBytes(32).toString('base64url'), id = randomBytes(12).toString('hex');
  const source = createCopyCipher(a.privateKey, pub(b), salt, id, 'source');
  const target = createCopyCipher(b.privateKey, pub(a), salt, id, 'target');
  const packet = source.seal({ type: 'data', data: 'secret fixture' });
  assert.deepEqual(target.open(packet), { type: 'data', data: 'secret fixture' });
  assert.throws(() => target.open(packet), /sequence/);
  assert.deepEqual(source.open(target.seal({ type: 'exit', code: 0 })), { type: 'exit', code: 0 });
  const next = source.seal({ type: 'data', data: 'more' });
  const bytes = Buffer.from(next, 'base64'); bytes[bytes.length - 1] ^= 1;
  assert.throws(() => target.open(bytes.toString('base64')));
  assert.deepEqual(target.open(next), { type: 'data', data: 'more' });
});
