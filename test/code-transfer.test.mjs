import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helmDir = mkdtempSync(join(tmpdir(), 'helm-code-transfer-'));
process.env.HELM_DIR = helmDir;
const work = join(process.cwd(), `.helm-code-transfer-test-${process.pid}`);
rmSync(work, { recursive: true, force: true });

test.after(() => {
  rmSync(helmDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

test('code handoff encrypts, excludes common secrets, and materializes safely', async () => {
  const { codeKeyInfo, createCodeSnapshot, materializeCode, sealCodeSnapshot } =
    await import('../packages/connect/src/code-transfer.js');
  const source = join(helmDir, 'source');
  mkdirSync(join(source, 'src'), { recursive: true });
  writeFileSync(join(source, 'src', 'main.js'), 'console.log("safe")');
  writeFileSync(join(source, '.env'), 'TOKEN=should-not-move');
  writeFileSync(join(source, 'credentials.json'), '{"token":"no"}');

  const snapshot = createCodeSnapshot(source);
  assert.deepEqual(snapshot.files.map((x) => x.path), ['src/main.js']);
  assert.equal(snapshot.skipped, 2);

  const key = codeKeyInfo();
  const envelope = sealCodeSnapshot(snapshot, key.codePubkey, 'handoff-test');
  assert.equal(JSON.stringify(envelope).includes('safe'), false, 'relay payload is ciphertext');

  const result = materializeCode(envelope, 'handoff-test', work);
  assert.equal(readFileSync(join(result.folder, 'src', 'main.js'), 'utf8'), 'console.log("safe")');
  assert.equal(result.files, 1);
  assert.equal(result.skipped, 2);
});

test('tampering with an encrypted handoff is rejected', async () => {
  const { codeKeyInfo, sealCodeSnapshot, materializeCode } =
    await import('../packages/connect/src/code-transfer.js');
  const key = codeKeyInfo();
  const envelope = sealCodeSnapshot({ v: 1, rootName: 'x', files: [] }, key.codePubkey, 'tamper-test');
  envelope.data = `${envelope.data.slice(0, -1)}${envelope.data.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => materializeCode(envelope, 'tamper-test', join(work, 'tampered')), /authenticate|handoff/i);
});
