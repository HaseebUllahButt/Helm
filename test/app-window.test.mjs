import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAppWindow } from '../apps/relay/src/app-window.js';

// Stand-ins for Chromium: the same arguments, a process that only waits.
const fakeBrowser = (...args) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args], { stdio: 'ignore' });
const exited = (child) => new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal)));
const started = (child) => new Promise((resolve) => child.once('spawn', resolve));

test('Close ends the browser on the window profile and nothing else', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-app-window-'));
  const profile = join(dir, 'app-window');
  const browser = fakeBrowser(`--user-data-dir=${profile}`, '--app=http://127.0.0.1:8787/');
  const helper = fakeBrowser('--type=renderer', `--user-data-dir=${profile}`);
  const other = fakeBrowser(`--user-data-dir=${join(dir, 'other')}`);
  // Chromium's own way: every argument in one, joined with spaces.
  const renamed = spawn(process.execPath, ['-e', 'process.title = process.argv.slice(1).join(" "); setInterval(() => {}, 1000)', '--', `--user-data-dir=${profile}`, '--no-first-run'], { stdio: 'ignore' });
  t.after(() => { for (const child of [browser, helper, other, renamed]) child.kill(); rmSync(dir, { recursive: true, force: true }); });
  await Promise.all([browser, helper, other, renamed].map(started));

  const gone = [exited(browser), exited(renamed)];
  assert.equal(closeAppWindow(profile), 2);
  assert.deepEqual(await Promise.all(gone), ['SIGTERM', 'SIGTERM']);
  assert.equal(helper.exitCode, null, 'a helper process is left to its browser');
  assert.equal(other.exitCode, null, 'another profile is not Helm');
  assert.equal(closeAppWindow(profile), 0, 'nothing left to close');
});
