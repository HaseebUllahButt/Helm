import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bulkPlan, bulkWarnings, discardPlan, progressFrom } from '../packages/connect/src/bulk-transfer.js';

const root = mkdtempSync(join(tmpdir(), 'helm-bulk-policy-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const git of [false, true]) test(`bulk --no-env excludes root and nested env files (${git ? 'git' : 'plain'} project)`, () => {
  const folder = join(root, git ? 'git' : 'plain');
  mkdirSync(join(folder, 'nested'), { recursive: true });
  mkdirSync(join(folder, 'node_modules'), { recursive: true });
  writeFileSync(join(folder, 'app.txt'), 'hello');
  writeFileSync(join(folder, 'node_modules', 'junk'), 'ignored');
  writeFileSync(join(folder, '.gitignore'), 'node_modules/\n.env.ignored\n');
  for (const path of ['.env', '.env.ignored', 'nested/.env.local', 'nested/.ENV']) writeFileSync(join(folder, path), 'TEST=throwaway');
  if (git) {
    const sh = (...args) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe' });
    sh('init', '-q'); sh('add', 'app.txt', '.gitignore', '.env');
    sh('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  }
  for (const includeEnv of [false, true]) {
    const plan = bulkPlan(folder, { includeEnv }), target = `${folder}-${includeEnv}`;
    try {
      mkdirSync(target);
      execFileSync('rsync', ['-a', ...(plan.listFile ? [`--files-from=${plan.listFile}`, '--from0', '-r'] : []),
        ...plan.excludes.flatMap(e => ['--exclude', e]), `${folder}/`, `${target}/`]);
      for (const path of ['.env', '.env.ignored', 'nested/.env.local', 'nested/.ENV']) assert.equal(existsSync(join(target, path)), includeEnv, path);
      assert.equal(existsSync(join(target, 'node_modules')), false);
      assert.equal(readFileSync(join(target, 'app.txt'), 'utf8'), 'hello');
      assert.equal(plan.envFiles.length, includeEnv ? 4 : 0);
      assert.ok(plan.files >= 2);
      const warnings = bulkWarnings(plan, includeEnv);
      assert.equal(warnings.some(w => w.code === 'env-history'), git && !includeEnv);
      if (!git) assert.equal(plan.bytes, includeEnv ? 88 : 32, 'estimate excludes dependency bytes and omitted env');
    } finally { discardPlan(plan); }
  }
});

test('copy progress reads rsync 3.5 lines with a B after the bytes, and older lines', () => {
  assert.deepEqual(progressFrom('      1,212,416B  38% 1,051,379B/s    0:00:01  \r'), { bytes: 1212416, percent: 38, rate: '1,051,379B/s' });
  assert.deepEqual(progressFrom('      1,212,416  38%    1.00MB/s    0:00:01  \r'), { bytes: 1212416, percent: 38, rate: '1.00MB/s' });
  assert.equal(progressFrom('sending incremental file list'), null);
});
