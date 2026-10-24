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

test('the chooser selects this focused test for its own change', () => {
  const result = selectTests({ changed: ['scripts/test-smart.mjs'], args: [] });
  assert.deepEqual(result.tests, ['test/test-smart.test.mjs']);
  assert.deepEqual(result.gaps, []);
});

test('a source file maps to tests by its own name', () => {
  assert.deepEqual(testNames(F.usageScreen), ['usage']);
  assert.deepEqual(testNames(F.claudeDriver), ['claude', 'driver-claude']);
  assert.deepEqual(testNames(F.protocol), ['protocol']);
  assert.deepEqual(selectTests({ changed: [F.claudeDriver], args: [] }).tests, ['test/driver-claude.test.mjs']);
});

test('the same name in another layer does not pick a test', () => {
  // test/usage.test.mjs checks the usage package, not the web screen.
  const result = selectTests({ changed: [F.usageScreen], args: [] });
  assert.deepEqual(result.tests, ['test/browser/usage.test.mjs']);
});

test('a longer test name belongs to a file it imports', () => {
  const result = selectTests({ changed: [F.discover], args: [] });
  assert.ok(result.tests.includes('test/discover-wrapper.test.mjs'));
});

test('the recorded usage and terminal fixes pick a few tests and list the rest', () => {
  // The old chooser picked 142 and 165 test files for these.
  const usage = selectTests({ changed: F.usageFix, args: [] });
  assert.deepEqual(usage.tests, ['test/browser/usage.test.mjs']);
  assert.deepEqual(usage.gaps, [F.agent, F.pricing]);
  assert.ok(usage.gapImporters.get(F.pricing).includes('test/cost-accounting.test.mjs'));
  const terminal = selectTests({ changed: F.terminalFix, args: [] });
  assert.deepEqual(terminal.tests.sort(), ['test/browser/global-keys.test.mjs', 'test/session-driver.test.mjs', 'test/terminal-browser.test.mjs']);
  assert.ok(terminal.gaps.includes(F.protocol));
  assert.equal(terminal.network, true);
});

test('wide selection still follows imports when asked for', () => {
  const plain = selectTests({ changed: [F.relayShare], args: [] });
  assert.equal(plain.tests.includes('test/upgrade-input.test.mjs'), false);
  const wide = selectTests({ changed: [F.relayShare], args: ['--wide'] });
  assert.ok(wide.tests.includes('test/upgrade-input.test.mjs'));
  const near = selectTests({ changed: [F.relayShare], args: ['--near'] });
  assert.equal(near.tests.includes('test/upgrade-input.test.mjs'), false);
});

test('shared setup is listed, not expanded to every test', () => {
  const result = selectTests({ changed: ['package-lock.json', 'test/helpers.mjs'], args: [] });
  assert.deepEqual(result.tests, []);
  assert.deepEqual(result.shared, ['package-lock.json', 'test/helpers.mjs']);
});

test('Rust reader changes select the native reader test', () => {
  const result = selectTests({ changed: [F.rustReader], args: [] });
  assert.ok(result.tests.includes('test/log-index-native.test.mjs'));
  assert.ok(result.tests.length <= 3, result.tests.join(' '));
});

test('docs-only changes select no tests', () => {
  const result = selectTests({ changed: ['docs/example.md'], args: [] });
  assert.deepEqual(result.tests, []);
  assert.equal(result.network, false);
});

test('named test files run exactly as named', () => {
  const result = selectTests({ args: ['test/test-smart.test.mjs', 'test/copy.test.mjs'] });
  assert.deepEqual(result.tests, ['test/test-smart.test.mjs', 'test/copy.test.mjs']);
  assert.deepEqual(result.explicit, ['test/test-smart.test.mjs', 'test/copy.test.mjs']);
});

test('importing the chooser prints nothing and starts no tests', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./scripts/test-smart.mjs')"], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('the real CLI saves a genuine pass and reuses it only for unnamed runs', { skip: process.env.HELM_TEST_SMART_CLI_CHILD === '1' }, () => {
  const cache = mkdtempSync(join(tmpdir(), 'helm-check-'));
  try {
    const cli = (...args) => spawnSync(process.execPath, ['scripts/test-smart.mjs', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, HELM_CHECK_CACHE: cache },
    });
    // A run that passes saves its key; the same tree reuses it.
    const first = cli(F.lineBuffer);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /pass {2}1 test files/);
    const saved = JSON.parse(readFileSync(join(cache, 'passes.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved), ['test/line-buffer.test.mjs']);
    const again = cli(F.lineBuffer);
    assert.match(again.stdout, /Saved pass, not run again: test\/line-buffer\.test\.mjs/);
    assert.match(cli(F.lineBuffer, '--fresh').stdout, /pass {2}1 test files/);
    // A named test runs again even with a saved pass.
    assert.match(cli('test/line-buffer.test.mjs').stdout, /pass {2}1 test files/);
    // A test with a skipped case is never saved as a pass.
    const skipped = spawnSync(process.execPath, ['scripts/test-smart.mjs', 'test/test-smart.test.mjs'], {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HELM_CHECK_CACHE: cache, HELM_TEST_SMART_CLI_CHILD: '1' },
    });
    assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
    const after = JSON.parse(readFileSync(join(cache, 'passes.json'), 'utf8'));
    assert.equal(after['test/test-smart.test.mjs'], undefined);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('code, package and setting changes drop a saved pass; a failure never reuses one', { skip: process.env.HELM_TEST_SMART_CLI_CHILD === '1' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-check-repo-'));
  try {
    for (const d of ['scripts', 'test/browser', 'apps', 'packages/demo/src', 'node_modules']) mkdirSync(join(dir, d), { recursive: true });
    for (const f of ['scripts/test-smart.mjs', 'scripts/test-pass-reporter.mjs']) copyFileSync(join(root, f), join(dir, f));
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
    // On a branch, committing the same content keeps the pass.
    git('commit', '-qam', 'one');
    assert.ok(reused(cli()), 'a commit of the same content reuses the pass');
    writeFileSync(join(dir, 'packages/demo/src/extra.js'), 'export {};\n');
    assert.ok(ran(cli()), 'a new file elsewhere drops the pass');
    assert.ok(reused(cli()));
    writeFileSync(join(dir, 'node_modules/.package-lock.json'), '{"x":1}');
    assert.ok(ran(cli()), 'installed packages drop the pass');
    assert.ok(reused(cli()));
    assert.ok(ran(cli({ HELM_TEST_CHROMIUM: '/other/chromium' })), 'test settings drop the pass');
    assert.ok(ran(cli()), 'the pass for other settings is not reused');
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
