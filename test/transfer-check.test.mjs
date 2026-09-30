import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
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
const codes = (report) => report.checks.map((c) => c.code);
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

test('generated directories are informational and never gate the send', () => {
  const src = dir('generated');
  writeFileSync(join(src, 'a.txt'), 'x');
  for (const d of ['node_modules', 'dist', '.git', '.venv', '.next', 'target', 'build']) {
    mkdirSync(join(src, d));
  }
  const report = TC.transferPreflight(CT.createCodeSnapshot(src));
  assert.equal(report.requiresAcknowledgement, false);
  const setup = report.warnings.filter((w) => w.code === 'generated-setup');
  assert.ok(setup.some((w) => /dependencies/i.test(w.message)));
  assert.ok(setup.some((w) => /git history/i.test(w.message)));
  assert.ok(setup.some((w) => /build output/i.test(w.message)));
  assert.ok(setup.some((w) => /python environment/i.test(w.message)));
});

test('node engine ranges verify, fail and defer honestly', async () => {
  const src = dir('engines');
  writeFileSync(join(src, 'package.json'), JSON.stringify({
    engines: { node: '>=22' },
  }));
  const ok = await TC.inspectTransferReadiness(src, { nodeVersion: '22.5.0' });
  assert.equal(find(ok, 'node-version').status, 'pass');
  const old = await TC.inspectTransferReadiness(src, { nodeVersion: '20.0.0' });
  assert.equal(find(old, 'node-version').status, 'fail');
  assert.equal(old.status, 'needs-setup');

  writeFileSync(join(src, 'package.json'), JSON.stringify({
    engines: { node: '^20 || >=22' },
  }));
  const ranged = await TC.inspectTransferReadiness(src, { nodeVersion: '22.5.0' });
  assert.equal(find(ranged, 'node-version-unverified').status, 'warning');
  assert.equal(find(ranged, 'node-version'), undefined);
});

test('missing dependencies and the package manager are named as setup work', async () => {
  const src = dir('deps');
  writeFileSync(join(src, 'package.json'), JSON.stringify({ dependencies: { x: '1' } }));
  const report = await TC.inspectTransferReadiness(src, { envPath: join(root, 'empty-bin') });
  assert.equal(find(report, 'missing-dependencies').status, 'warning');
  assert.equal(find(report, 'missing-package-manager').status, 'warning');
  assert.equal(report.status, 'needs-setup');

  mkdirSync(join(src, 'node_modules'));
  const installed = await TC.inspectTransferReadiness(src, { envPath: '' });
  assert.equal(find(installed, 'dependencies-present').status, 'pass');
  assert.match(find(installed, 'dependencies-present').message, /not validated/);

  const bin = join(root, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\n');
  chmodSync(join(bin, 'npm'), 0o755);
  const managed = await TC.inspectTransferReadiness(src, { envPath: bin });
  assert.equal(find(managed, 'package-manager').status, 'pass');
});

test('a declared or locked package manager is checked on PATH', async () => {
  const src = dir('manager');
  writeFileSync(join(src, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.1.0' }));
  const missing = await TC.inspectTransferReadiness(src, { envPath: '' });
  assert.match(find(missing, 'missing-package-manager').message, /'pnpm'/);

  const locked = dir('locked');
  writeFileSync(join(locked, 'package.json'), '{}');
  writeFileSync(join(locked, 'bun.lockb'), '');
  const bunReport = await TC.inspectTransferReadiness(locked, { envPath: '' });
  assert.match(find(bunReport, 'missing-package-manager').message, /'bun'/);

  writeFileSync(join(locked, 'yarn.lock'), '');
  const conflict = await TC.inspectTransferReadiness(locked, { envPath: '' });
  assert.ok(find(conflict, 'conflicting-lockfiles'));
});

test('npm lockfiles select npm, and declarations conflict honestly', async () => {
  const npmLocked = dir('npm-lock');
  writeFileSync(join(npmLocked, 'package.json'), '{}');
  writeFileSync(join(npmLocked, 'package-lock.json'), '{}');
  const npmReport = await TC.inspectTransferReadiness(npmLocked, { envPath: '' });
  assert.match(find(npmReport, 'missing-package-manager').message, /'npm'/);

  const shrink = dir('shrink');
  writeFileSync(join(shrink, 'package.json'), '{}');
  writeFileSync(join(shrink, 'npm-shrinkwrap.json'), '{}');
  const shrinkReport = await TC.inspectTransferReadiness(shrink, { envPath: '' });
  assert.match(find(shrinkReport, 'missing-package-manager').message, /'npm'/);

  const clash = dir('lock-clash');
  writeFileSync(join(clash, 'package.json'), JSON.stringify({ packageManager: 'npm@10' }));
  writeFileSync(join(clash, 'yarn.lock'), '');
  const clashReport = await TC.inspectTransferReadiness(clash, { envPath: '' });
  assert.ok(find(clashReport, 'manager-lock-conflict'));
  assert.equal(clashReport.status, 'needs-setup');

  const mixed = dir('mixed-managers');
  mkdirSync(join(mixed, 'packages', 'a'), { recursive: true });
  writeFileSync(join(mixed, 'package.json'), JSON.stringify({ packageManager: 'npm@10' }));
  writeFileSync(
    join(mixed, 'packages', 'a', 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@9' }));
  const mixedReport = await TC.inspectTransferReadiness(mixed, { envPath: '' });
  assert.ok(find(mixedReport, 'conflicting-managers'));
  assert.match(find(mixedReport, 'missing-package-manager').message, /'npm'/);
});

test('an unsupported or versioned package manager is never guessed', async () => {
  const unknown = dir('unknown-manager');
  writeFileSync(join(unknown, 'package.json'), JSON.stringify({ packageManager: 'deno@1.46.0' }));
  const report = await TC.inspectTransferReadiness(unknown, { envPath: '' });
  assert.ok(find(report, 'unsupported-manager'));
  assert.match(find(report, 'unsupported-manager').message, /not supported/);
  assert.equal(find(report, 'package-manager'), undefined);
  assert.equal(allText(report).includes('deno@1.46.0'), false);
  assert.equal(report.status, 'needs-setup');

  const versioned = dir('versioned-manager');
  writeFileSync(
    join(versioned, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.1.0' }));
  const ver = await TC.inspectTransferReadiness(versioned, { envPath: '' });
  assert.ok(find(ver, 'manager-version-unchecked'));
  assert.equal(allText(ver).includes('9.1.0'), false);
});

test('a PATH entry that is a directory is not a package manager', async () => {
  const src = dir('dir-manager');
  writeFileSync(join(src, 'package.json'), '{}');
  const bin = join(root, 'dir-bin');
  mkdirSync(join(bin, 'npm'), { recursive: true });
  chmodSync(join(bin, 'npm'), 0o755);
  const report = await TC.inspectTransferReadiness(src, { envPath: bin });
  assert.equal(find(report, 'missing-package-manager').status, 'warning');

  const shimBin = join(root, 'shim-bin');
  mkdirSync(shimBin);
  const real = join(shimBin, 'real-pnpm');
  writeFileSync(real, '#!/bin/sh\n');
  chmodSync(real, 0o755);
  symlinkSync(real, join(shimBin, 'pnpm'));
  writeFileSync(join(src, 'pnpm-lock.yaml'), '');
  const shimmed = await TC.inspectTransferReadiness(src, { envPath: shimBin });
  assert.equal(find(shimmed, 'package-manager').status, 'pass');
});

test('empty dependency maps need no install; non-object ones warn', async () => {
  const empty = dir('empty-deps');
  writeFileSync(join(empty, 'package.json'), JSON.stringify({
    dependencies: {}, devDependencies: {},
  }));
  const report = await TC.inspectTransferReadiness(empty, { envPath: '' });
  assert.equal(find(report, 'missing-dependencies'), undefined);

  const bad = dir('bad-deps');
  writeFileSync(join(bad, 'package.json'), JSON.stringify({ dependencies: 'latest' }));
  const badReport = await TC.inspectTransferReadiness(bad, { envPath: '' });
  assert.equal(find(badReport, 'manifest-config').status, 'warning');
  assert.equal(badReport.status, 'needs-setup');
  assert.equal(find(badReport, 'dependencies-present'), undefined);
});

test('inspection limits and unreadable directories are reported, not silent', async () => {
  const file = dir('not-dir');
  writeFileSync(join(file, 'plain.txt'), 'x');
  const notDir = await TC.inspectTransferReadiness(join(file, 'plain.txt'));
  assert.equal(find(notDir, 'folder-not-directory').status, 'fail');
  assert.equal(notDir.status, 'needs-setup');

  const unreadable = dir('unreadable');
  mkdirSync(join(unreadable, 'locked'));
  writeFileSync(join(unreadable, 'locked', 'package.json'), '{}');
  chmodSync(join(unreadable, 'locked'), 0o000);
  try {
    const report = await TC.inspectTransferReadiness(unreadable);
    assert.ok(find(report, 'inspection-incomplete'));
    assert.equal(report.status, 'needs-setup');
  } finally {
    chmodSync(join(unreadable, 'locked'), 0o755);
  }

  const many = dir('many-manifests');
  for (let i = 0; i < 66; i++) {
    mkdirSync(join(many, `pkg-${i}`));
    writeFileSync(join(many, `pkg-${i}`, 'package.json'), '{}');
  }
  const overflow = await TC.inspectTransferReadiness(many);
  assert.ok(find(overflow, 'inspection-incomplete'));

  const big = dir('big-tree');
  mkdirSync(join(big, 'wide'));
  for (let i = 0; i < 20_001; i++) {
    writeFileSync(join(big, 'wide', `f-${i}.txt`), '');
  }
  const truncated = await TC.inspectTransferReadiness(big);
  assert.ok(find(truncated, 'inspection-incomplete'));
  assert.equal(truncated.status, 'needs-setup');
});

test('root and workspace manifests share the root node_modules fallback', async () => {
  const src = dir('workspace');
  mkdirSync(join(src, 'packages', 'a'), { recursive: true });
  writeFileSync(join(src, 'package.json'), '{}');
  writeFileSync(
    join(src, 'packages', 'a', 'package.json'),
    JSON.stringify({ dependencies: { x: '1' } }));
  const missing = await TC.inspectTransferReadiness(src, { envPath: '' });
  assert.equal(find(missing, 'missing-dependencies').status, 'warning');

  mkdirSync(join(src, 'node_modules'));
  const shared = await TC.inspectTransferReadiness(src, { envPath: '' });
  assert.equal(find(shared, 'dependencies-present').status, 'pass');
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

test('python and rust markers warn that setup is unchecked', async () => {
  const python = dir('python');
  writeFileSync(join(python, 'requirements.txt'), 'flask');
  const py = await TC.inspectTransferReadiness(python);
  assert.equal(find(py, 'setup-not-checked').status, 'warning');
  assert.equal(py.status, 'needs-setup');

  const rust = dir('rust');
  writeFileSync(join(rust, 'Cargo.toml'), '[package]\nname = "x"\n');
  const cargo = await TC.inspectTransferReadiness(rust);
  assert.match(find(cargo, 'setup-not-checked').message, /rust/i);
});

test('a folder with nothing recognizable stays unverified, never ready', async () => {
  const src = dir('plain');
  writeFileSync(join(src, 'a.txt'), 'x');
  const report = await TC.inspectTransferReadiness(src);
  assert.equal(report.status, 'unverified');
  assert.equal(report.verified, false);
  assert.deepEqual(codes(report), ['runtime-not-verified']);
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

test('skipped manifest entries surface as unresolved setup', async () => {
  const src = dir('skipped');
  writeFileSync(join(src, 'a.txt'), 'x');
  const report = await TC.inspectTransferReadiness(src, {
    skipped: 4,
    skippedEntries: [
      { path: '.env', reason: 'secret-name' },
      { path: '.ssh', reason: 'secret-dir' },
    ],
  });
  assert.equal(report.checks.filter((c) => c.code === 'skipped-sensitive').length, 2);
  assert.ok(find(report, 'skipped-manifest-incomplete'));
  assert.equal(report.status, 'needs-setup');
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
