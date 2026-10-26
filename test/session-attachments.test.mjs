import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveUploads } from '../packages/connect/src/session-attachments.js';

test('files with the same saved name retain their own bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'helm-attachment-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ['report.txt', 'report.txt', '../report.txt', '.report.txt'].map((filename, index) => ({
    filename, data: Buffer.from(`Document ${index + 1}`).toString('base64'),
  }));
  const prompt = saveUploads('chat', files, root);
  const paths = [...prompt.matchAll(/^\[File: .*\]: (".*")$/gm)].map(match => JSON.parse(match[1]));
  assert.equal(new Set(paths).size, files.length);
  assert.deepEqual(paths.map(path => readFileSync(path, 'utf8')), ['Document 1', 'Document 2', 'Document 3', 'Document 4']);
});
