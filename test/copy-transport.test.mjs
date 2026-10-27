import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cleanCopyFolder, validateCopyServerArgs, createCopyCipher } from '../packages/connect/src/copy-transport.js';

test('copy receiver takes absolute and home destinations and only receiving rsync arguments', () => {
  assert.equal(cleanCopyFolder('/tmp/a b'), '/tmp/a b');
  assert.equal(cleanCopyFolder('/'), '/');
  assert.equal(cleanCopyFolder('/tmp/..'), '/');
  assert.equal(cleanCopyFolder('~'), '~');
  assert.equal(cleanCopyFolder('~/dev/x'), '~/dev/x');
  for (const folder of ['relative', '/tmp/x\ncommand']) assert.throws(() => cleanCopyFolder(folder));
  assert.deepEqual(validateCopyServerArgs(['--server', '-slogDtpre.iLsfxCIvu']), ['--server', '-slogDtpre.iLsfxCIvu']);
  for (const args of [['--sender', '-s'], ['--server', '-s', '/tmp'], ['--server', '-s;sh'], ['--server', '--daemon'], ['--server', '-sKlogDtpre.iLsfxCIvu'], ['--server', '-sLb'], ['--server', '-sb']]) {
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

test('binary selection keeps ready sequence state and rejects tampering and replay in both outer formats', () => {
  const a = generateKeyPairSync('x25519'), b = generateKeyPairSync('x25519');
  const pub = key => key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const salt = randomBytes(32).toString('base64url'), id = randomBytes(12).toString('hex');
  const source = createCopyCipher(a.privateKey, pub(b), salt, id, 'source');
  const target = createCopyCipher(b.privateKey, pub(a), salt, id, 'target');
  const ready = target.seal({ type: 'ready', codec: 'binary1' });
  assert.deepEqual(source.open(ready), { type: 'ready', codec: 'binary1' });
  source.useBinary(); target.useBinary();
  const data = randomBytes(65536), encoded = source.seal({ type: 'data', data });
  assert.equal(encoded.length, data.length + 25);
  const tampered = Buffer.from(encoded); tampered[30] ^= 1;
  assert.throws(() => target.open(tampered));
  assert.deepEqual(target.open(encoded.toString('base64')).data, data);
  assert.throws(() => target.open(encoded), /sequence/);
  const ack = target.seal({ type: 'ack', bytes: data.length });
  assert.equal(ack.readBigUInt64BE(), 1n, 'the ready proof already used sequence zero');
  assert.deepEqual(source.open(ack), { type: 'ack', bytes: data.length });
  assert.throws(() => source.open(ack), /sequence/);
});

test('legacy copy mode converts source bytes into the original base64 data packet', () => {
  const a = generateKeyPairSync('x25519'), b = generateKeyPairSync('x25519');
  const pub = key => key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const salt = randomBytes(32).toString('base64url'), id = randomBytes(12).toString('hex');
  const source = createCopyCipher(a.privateKey, pub(b), salt, id, 'source');
  const target = createCopyCipher(b.privateKey, pub(a), salt, id, 'target');
  const data = randomBytes(100);
  assert.deepEqual(target.open(source.seal({ type: 'data', data })), { type: 'data', data: data.toString('base64') });
});
