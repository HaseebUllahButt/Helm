import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'helm-bundle-'));
process.env.HELM_DIR = join(root, 'state');
mkdirSync(process.env.HELM_DIR);
const { makeBundle } = await import('../packages/connect/src/update.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('parallel update downloads use separate temporary bundles', async t => {
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'file'), 'test'); git(['add', '.']); git(['commit', '-qm', 'test']);
  const head = git(['rev-parse', 'HEAD']);
  t.mock.method(Date, 'now', () => 100_000);
  const bundles = await Promise.all(Array.from({ length: 4 }, () => makeBundle({}, repo)));
  for (let i = 0; i < bundles.length; i++) {
    assert.equal(bundles[i].head, head);
    const file = join(root, `result-${i}.bundle`);
    writeFileSync(file, Buffer.from(bundles[i].bundle, 'base64'));
    assert.equal(git(['bundle', 'list-heads', file]), `${head} HEAD`);
  }
  assert.deepEqual(readdirSync(process.env.HELM_DIR), []);
});
