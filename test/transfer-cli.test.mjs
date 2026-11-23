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
    HELM_PROCS_SOCKET: join(root, 'procs.sock'), HELM_TERMINALS_SOCKET: join(root, 'terminals.sock'),
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
  assert.match(run.stdout, /2 files/);
  assert.match(run.stdout, /--no-env/);
  assert.equal(run.stdout.includes('cli-value'), false);
  assert.equal(run.stderr.includes('cli-value'), false);
  assert.equal(existsSync(join(HELM_DIR, 'network.json')), false);
  assert.equal(existsSync(join(HELM_DIR, 'code_x25519')), false);
  assert.equal(existsSync(join(HELM_DIR, 'code_ed25519')), false);
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
  assert.match(run.stdout, /\[warning\] Helm ran no commands\. It did not check the app, databases, services or settings on this machine\./);
  assert.equal(existsSync(join(folder, 'VERIFY-RAN')), false);
  assert.equal(run.stdout.includes('verify-marker'), false);
  assert.equal(run.stderr.includes('verify-marker'), false);
});
