import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-transfer-check-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_NO_SERVICE = '1';
delete process.env.INVOCATION_ID;

test.after(() => rmSync(root, { recursive: true, force: true }));

const CT = await import('../packages/connect/src/code-transfer.js');
const TC = await import('../packages/connect/src/transfer-check.js');

let seq = 0;
const dir = (name) => {
  const d = join(root, `fixture-${seq++}-${name}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const find = (report, code) => report.checks.find((c) => c.code === code);
const allText = (value) => JSON.stringify(value)
  + (Array.isArray(value.checks) ? TC.readinessLines(value).join('\n') : '')
  + (Array.isArray(value.warnings) ? TC.preflightLines(value).join('\n') : '');

test('preflight classifies env files, secrets and risky omissions', () => {
  const src = dir('env');
  writeFileSync(join(src, 'app.js'), 'x');
  writeFileSync(join(src, '.env'), 'LEAKME=topsecret-value\n');
  writeFileSync(join(src, 'credentials.json'), '{"LEAKME":"nested"}');
  writeFileSync(join(src, '.env.template'), 'LEAKME=\n');

  const plain = TC.transferPreflight(CT.createCodeSnapshot(src));
  assert.equal(plain.files, 2);
  assert.equal(plain.envFiles.length, 1);
  assert.deepEqual(plain.envFiles, ['.env.template']);
  assert.equal(plain.requiresAcknowledgement, true);
  assert.ok(plain.warnings.some((w) => w.code === 'env-omitted' && w.path === '.env'));
  assert.ok(plain.warnings.some((w) => w.code === 'secret-omitted' && w.path === 'credentials.json'));
  assert.ok(plain.warnings.some((w) => w.code === 'filename-policy'));
  assert.equal(allText(plain).includes('topsecret-value'), false);
  assert.equal(allText(plain).includes('nested'), false);

  const withEnv = TC.transferPreflight(CT.createCodeSnapshot(src, { includeEnv: true }));
  assert.ok(withEnv.envFiles.includes('.env'));
  assert.ok(withEnv.envFiles.includes('.env.template'));
  assert.equal(withEnv.warnings.some((w) => w.code === 'env-omitted'), false);
  assert.equal(withEnv.requiresAcknowledgement, true);
});

test('symlinks and a truncated manifest require acknowledgement', () => {
  const src = dir('links');
  writeFileSync(join(src, 'a.txt'), 'x');
  const outside = dir('outside');
  writeFileSync(join(outside, 'b.txt'), 'y');
  symlinkSync(join(outside, 'b.txt'), join(src, 'linked.txt'));

  const report = TC.transferPreflight(CT.createCodeSnapshot(src));
  assert.ok(report.warnings.some(
    (w) => w.code === 'symlink-omitted' && w.path === 'linked.txt'));
  assert.equal(report.requiresAcknowledgement, true);

  const truncated = TC.transferPreflight({
    files: [], skipped: 9,
    skippedEntries: [{ path: 'a-link', reason: 'symlink' }],
  });
  assert.equal(truncated.omittedEntries, 8);
  assert.ok(truncated.warnings.some((w) => w.code === 'manifest-truncated'));
  assert.equal(truncated.requiresAcknowledgement, true);

  const unlistedGenerated = TC.transferPreflight({ files: [], skipped: 0, skippedEntries: [] });
  assert.equal(unlistedGenerated.requiresAcknowledgement, false);
});

test('malformed and oversized manifests warn without echoing contents', async () => {
  const src = dir('bad-manifest');
  writeFileSync(join(src, 'package.json'), 'not json LEAKME-VALUE {');
  const report = await TC.inspectTransferReadiness(src);
  assert.equal(find(report, 'manifest-unreadable').status, 'warning');
  assert.equal(allText(report).includes('LEAKME-VALUE'), false);

  const big = dir('big-manifest');
  writeFileSync(join(big, 'package.json'), `{"pad":"${'x'.repeat(70 * 1024)}"}`);
  const oversized = await TC.inspectTransferReadiness(big);
  assert.equal(find(oversized, 'manifest-unreadable').status, 'warning');
});

test('the inspector never follows symlinks and never opens env files', async () => {
  const src = dir('no-follow');
  const outside = dir('outside-pkg');
  writeFileSync(join(outside, 'package.json'), JSON.stringify({ dependencies: { x: '1' } }));
  symlinkSync(outside, join(src, 'linked-dir'));
  const manifestTarget = join(outside, 'manifest-target.json');
  writeFileSync(manifestTarget, JSON.stringify({ dependencies: { x: '1' } }));
  symlinkSync(manifestTarget, join(src, 'package.json'));
  writeFileSync(join(src, '.env'), 'LEAKME=inspection-marker\n');
  symlinkSync('no-such-target', join(src, 'dangling'));

  const report = await TC.inspectTransferReadiness(src);
  assert.equal(report.status, 'unverified');
  assert.equal(find(report, 'missing-dependencies'), undefined);
  assert.equal(allText(report).includes('inspection-marker'), false);
});

test('the inspector reports but never executes a manifest', async () => {
  const src = dir('no-exec');
  writeFileSync(join(src, 'package.json'), JSON.stringify({
    scripts: { postinstall: 'touch INSPECTOR-RAN' },
    dependencies: { x: '1' },
  }));
  const report = await TC.inspectTransferReadiness(src);
  assert.equal(existsSync(join(src, 'INSPECTOR-RAN')), false);
  assert.equal(allText(report).includes('INSPECTOR-RAN'), false);
  assert.ok(find(report, 'runtime-not-verified'));
});

test('a folder that is not there, or is a symlink, fails instead of following', async () => {
  const missing = await TC.inspectTransferReadiness(join(root, 'definitely-absent'));
  assert.equal(find(missing, 'folder-unreadable').status, 'fail');
  assert.equal(missing.status, 'needs-setup');

  const real = dir('real');
  const link = join(root, 'folder-link');
  symlinkSync(real, link);
  const report = await TC.inspectTransferReadiness(link);
  assert.equal(find(report, 'folder-symlink').status, 'fail');
});

test('the handoff manifest supplies skipped entries, bounded and sanitized', async () => {
  const src = dir('marker');
  mkdirSync(join(src, '.helm'), { recursive: true });
  writeFileSync(join(src, '.helm', 'handoff.json'), JSON.stringify({
    version: 1, handoffId: 'a'.repeat(24), skipped: 7,
    skippedEntries: [{ path: '.env', reason: 'secret-name' }, { bogus: true }],
  }));
  const marker = TC.readHandoffSkipped(src);
  assert.equal(marker.skipped, 7);
  assert.equal(marker.skippedEntries.length, 1);
  assert.equal(marker.malformed, false);

  writeFileSync(join(src, '.helm', 'handoff.json'), 'not json');
  assert.equal(TC.readHandoffSkipped(src).malformed, true);

  const plain = dir('no-marker');
  assert.equal(TC.readHandoffSkipped(plain), null);

  const linked = dir('linked-marker');
  const target = dir('marker-target');
  writeFileSync(join(target, 'handoff.json'), JSON.stringify({ skipped: 3 }));
  mkdirSync(join(linked, '.helm'), { recursive: true });
  symlinkSync(join(target, 'handoff.json'), join(linked, '.helm', 'handoff.json'));
  assert.equal(TC.readHandoffSkipped(linked), null);
});
