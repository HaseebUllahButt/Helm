import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectTests, testNames } from '../scripts/test-smart.mjs';

const root = process.cwd();
// Source paths live in a data file, so the import scan does not count this test as using them.
const F = JSON.parse(readFileSync(join(root, 'test/fixtures/test-smart.json'), 'utf8'));

test('a source file maps to tests by its own name', () => {
  assert.deepEqual(testNames(F.usageScreen), ['usage']);
  assert.deepEqual(testNames(F.claudeDriver), ['claude', 'driver-claude']);
  assert.deepEqual(testNames(F.protocol), ['protocol']);
  assert.deepEqual(selectTests({ changed: [F.claudeDriver], args: [] }).tests, ['test/driver-claude.test.mjs']);
});

test('a failure never reuses a saved pass', { skip: process.env.HELM_TEST_SMART_CLI_CHILD === '1' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-check-repo-'));
  try {
    for (const d of ['scripts', 'test/browser', 'apps', 'packages/demo/src', 'node_modules']) mkdirSync(join(dir, d), { recursive: true });
    for (const f of ['scripts/test-smart.mjs', 'scripts/test-pass-reporter.mjs', 'scripts/test-cleanup.mjs']) copyFileSync(join(root, f), join(dir, f));
    writeFileSync(join(dir, 'test/thing.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { value } from '../packages/demo/src/thing.js';\ntest('one', () => assert.equal(value, 1));\n");
    writeFileSync(join(dir, 'packages/demo/src/thing.js'), 'export const value = 0;\n');
    writeFileSync(join(dir, 'node_modules/.package-lock.json'), '{}');
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'start'); git('checkout', '-qb', 'work');
    // The cache sits outside the tree, as node_modules/.cache is ignored in a real checkout.
    const cache = `${dir}-cache`;
    const cli = (env = {}) => spawnSync(process.execPath, ['scripts/test-smart.mjs'], {
      cwd: dir, encoding: 'utf8', timeout: 30000, env: { ...process.env, HELM_CHECK_CACHE: cache, ...env },
    });
    const ran = (r) => /pass {2}1 test files|FAIL {2}1 test files/.test(r.stdout);
    const reused = (r) => /Saved pass, not run again/.test(r.stdout);

    writeFileSync(join(dir, 'packages/demo/src/thing.js'), 'export const value = 1;\n');
    assert.ok(ran(cli()));
    assert.ok(reused(cli()), 'the same tree reuses the pass');
    // A failure removes the saved pass, and the same failing tree runs again.
    writeFileSync(join(dir, 'packages/demo/src/thing.js'), 'export const value = 2;\n');
    const failed = cli();
    assert.equal(failed.status, 1);
    assert.ok(ran(failed));
    assert.ok(ran(cli()), 'a failing tree is never reused');
    writeFileSync(join(dir, 'packages/demo/src/thing.js'), 'export const value = 1;\n');
    assert.ok(ran(cli()), 'the old pass was dropped when the test failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-cache`, { recursive: true, force: true });
  }
});
