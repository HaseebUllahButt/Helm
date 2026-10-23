import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { selectTests } from '../scripts/test-smart.mjs';

const root = process.cwd();

test('the chooser selects this focused test for its own change', () => {
  const result = selectTests({ changed: ['scripts/test-smart.mjs'], args: [] });
  assert.equal(result.all, false);
  assert.deepEqual(result.tests, ['test/test-smart.test.mjs']);
  assert.equal(result.network, false);
});

test('normal selection follows transitive imports', () => {
  const result = selectTests({ changed: ['apps/relay/src/share.js'], args: [] });
  assert.ok(result.tests.includes('test/upgrade-input.test.mjs'));
  assert.equal(result.all, false);
});

test('near selection checks direct imports only', () => {
  const result = selectTests({ changed: ['apps/relay/src/share.js'], args: ['--near'] });
  assert.equal(result.tests.includes('test/upgrade-input.test.mjs'), false);
  assert.equal(result.all, false);
});

test('Rust reader changes select its callers and build checks without selecting every test', () => {
  const result = selectTests({ changed: ['native/log-index/src/lib.rs'], args: [] });
  assert.equal(result.all, false);
  assert.ok(result.tests.includes('test/event-file.test.mjs'));
  assert.ok(result.tests.includes('test/log-index-native.test.mjs'));
  assert.equal(result.network, true);
});

test('docs-only changes select no tests', () => {
  const result = selectTests({ changed: ['docs/example.md'], args: [] });
  assert.deepEqual(result.tests, []);
  assert.equal(result.network, false);
});

test('importing the chooser prints nothing and starts no tests', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./scripts/test-smart.mjs')"], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('the real CLI runs its selected test and exits successfully', { skip: process.env.HELM_TEST_SMART_CLI_CHILD === '1' }, () => {
  const result = spawnSync(process.execPath, ['scripts/test-smart.mjs', 'test/test-smart.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HELM_TEST_SMART_CLI_CHILD: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /1 of \d+ test files/);
});
