import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../packages/connect/bin/helm.js', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'helm-transfer-cli-'));
const HELM_DIR = join(root, 'helm');

test.after(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
const helm = (args, env = {}) => {
  const childEnv = {
    ...process.env,
    ...env,
    HELM_DIR,
    HELM_DB: join(root, 'hub.sqlite'),
    HELM_SSH_DIR: join(root, 'ssh'),
    HELM_NO_SERVICE: '1',
  };
  delete childEnv.INVOCATION_ID;
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', timeout: 30_000, env: childEnv,
  });
};
const dir = (name) => {
  const d = join(root, `cli-${seq++}-${name}`);
  mkdirSync(d, { recursive: true });
  return d;
};

test('a dry run reports what a send would carry without a network or a grant', () => {
  const src = dir('dry');
  writeFileSync(join(src, 'app.js'), 'x');
  writeFileSync(join(src, '.env'), 'LEAKME=cli-value\n');

  const run = helm(['send', 'target', src, '--dry-run']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1 file/);
  assert.match(run.stdout, /--include-env/);
  assert.equal(run.stdout.includes('cli-value'), false);
  assert.equal(run.stderr.includes('cli-value'), false);
  assert.equal(existsSync(join(HELM_DIR, 'network.json')), false);
  assert.equal(existsSync(join(HELM_DIR, 'code_x25519')), false);
  assert.equal(existsSync(join(HELM_DIR, 'code_ed25519')), false);

  const withEnv = helm(['send', 'target', src, '--dry-run', '--include-env']);
  assert.equal(withEnv.status, 0, withEnv.stderr);
  assert.match(withEnv.stdout, /1 \.env file/);
});

test('send refuses unknown flags and missing flag values', () => {
  const src = dir('flags');
  writeFileSync(join(src, 'a.txt'), 'x');

  const typo = helm(['send', 'target', src, '--grnat', 'tok']);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /unknown flag --grnat/);

  const missingValue = helm(['send', 'target', src, '--grant']);
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /--grant needs a value/);

  const missingTargetValue = helm(['send', 'target', src, '--target-folder']);
  assert.equal(missingTargetValue.status, 1);
  assert.match(missingTargetValue.stderr, /--target-folder needs a value/);

  const short = helm(['send', 'target', src, '-g', 'tok']);
  assert.equal(short.status, 1);
  assert.match(short.stderr, /unknown flag -g/);

  const extra = helm(['send', 'target', src, 'extra-arg', '--dry-run']);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /unexpected argument/);

  const emptyValue = helm(['send', 'target', src, '--grant', '']);
  assert.equal(emptyValue.status, 1);
  assert.match(emptyValue.stderr, /--grant needs a value/);

  const duplicate = helm(['send', 'target', src, '--grant', 'one', '--grant', 'two']);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /--grant was given more than once/);
});

test('a risky omission refuses before any network or grant is touched', () => {
  const src = dir('gate');
  writeFileSync(join(src, 'app.js'), 'x');
  writeFileSync(join(src, '.env'), 'LEAKME=another-value\n');

  const refused = helm(['send', 'target', src, '--grant', 'unused-grant']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--allow-skipped/);
  assert.match(refused.stderr, /--include-env/);
  assert.equal(refused.stderr.includes('not in a network'), false);
  assert.equal(existsSync(join(HELM_DIR, 'network.json')), false);

  const past = helm(['send', 'target', src, '--grant', 'unused-grant', '--allow-skipped']);
  assert.equal(past.status, 1);
  assert.match(past.stderr, /not in a network/);
});

test('verify inspects statically and never runs what it finds', () => {
  const folder = dir('verify');
  writeFileSync(join(folder, 'package.json'), JSON.stringify({
    dependencies: { x: '1' },
    scripts: { postinstall: 'touch VERIFY-RAN' },
  }));
  writeFileSync(join(folder, '.env'), 'LEAKME=verify-marker\n');

  const run = helm(['verify', folder]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /target readiness: needs-setup/);
  assert.match(run.stdout, /runtime-not-verified|not verified/);
  assert.equal(existsSync(join(folder, 'VERIFY-RAN')), false);
  assert.equal(run.stdout.includes('verify-marker'), false);
  assert.equal(run.stderr.includes('verify-marker'), false);
});

test('verify -- runs exactly what the owner named and reports honestly', () => {
  const folder = dir('explicit');
  writeFileSync(join(folder, 'a.txt'), 'x');

  const missing = helm(['verify', folder, '--']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /needs a program/);

  const bad = helm(['verify', folder, '--bogus']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown flag/);

  const shortFlag = helm(['verify', folder, '-x']);
  assert.equal(shortFlag.status, 1);
  assert.match(shortFlag.stderr, /unknown flag -x/);

  const twoFolders = helm(['verify', folder, folder]);
  assert.equal(twoFolders.status, 1);
  assert.match(twoFolders.stderr, /usage: helm verify/);

  const ok = helm([
    'verify', folder, '--',
    process.execPath, '-e',
    "require('node:fs').writeFileSync('check-marker.txt', 'ok')",
  ]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /explicit check passed/);
  assert.equal(existsSync(join(folder, 'check-marker.txt')), true);

  const failed = helm(['verify', folder, '--', process.execPath, '-e', 'process.exit(7)']);
  assert.equal(failed.status, 7);
  assert.match(failed.stderr, /status 7/);

  const unspawnable = helm(['verify', folder, '--', 'definitely-not-a-real-helm-check-xyz']);
  assert.notEqual(unspawnable.status, 0);
});
