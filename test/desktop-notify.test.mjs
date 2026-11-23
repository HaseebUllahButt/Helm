import test from 'node:test';
import assert from 'node:assert/strict';

test('a launcher with another name still counts when it opens the Helm window', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { findEntry } = await import('../apps/relay/src/desktop-notify.js');
  const dir = mkdtempSync(join(tmpdir(), 'helm-apps-'));
  const profile = '/home/me/.helm/app-window';
  writeFileSync(join(dir, 'other.desktop'), '[Desktop Entry]\nExec=/usr/bin/chromium --app=https://example.test/\n');
  assert.equal(findEntry(dir, profile), null, 'another app window is not Helm');
  writeFileSync(join(dir, 'chrome-abc-Default.desktop'),
    `[Desktop Entry]\nExec=/usr/bin/chromium --user-data-dir=${profile} --profile-directory=Default --app=http://127.0.0.1:8787/\nStartupWMClass=chrome-127.0.0.1__-Default\n`);
  assert.deepEqual(findEntry(dir, profile), { exec: `/usr/bin/chromium --user-data-dir=${profile} --profile-directory=Default --app=http://127.0.0.1:8787/`, wmClass: 'chrome-127.0.0.1__-Default' });
  // Chromium's own "install app" names the app by its id instead of its address.
  rmSync(join(dir, 'chrome-abc-Default.desktop'));
  writeFileSync(join(dir, 'chrome-xyz-Default.desktop'),
    `[Desktop Entry]\nExec=/usr/bin/chromium --user-data-dir=${profile} --profile-directory=Default --app-id=xyz %U\nStartupWMClass=crx_xyz\n`);
  assert.equal(findEntry(dir, profile)?.wmClass, 'crx_xyz');
  writeFileSync(join(dir, 'chrome-xyz-Default.desktop'), '[Desktop Entry]\nExec=/usr/bin/chromium --user-data-dir=/elsewhere --app-id=xyz\n');
  assert.equal(findEntry(dir, profile), null, 'an app in another browser profile is not Helm');
  writeFileSync(join(dir, 'helm-app.desktop'), '[Desktop Entry]\nExec=helm-window\nStartupWMClass=helm\n');
  assert.deepEqual(findEntry(dir, profile), { exec: 'helm-window', wmClass: 'helm' }, 'Helm\'s own launcher wins');
});

test('a program Helm starts does not keep the connections Helm holds', { skip: process.platform !== 'linux' }, async () => {
  const { spawnClean } = await import('../apps/relay/src/desktop-notify.js');
  // fd 3 stands for a socket Helm holds. The pipe ends when no process holds
  // its write end, so its end shows whether the program kept a copy.
  const heldFor = async (start) => {
    const child = start('sleep', ['3'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    const began = Date.now();
    await new Promise((resolve) => { child.stdio[3].on('end', resolve).on('close', resolve).resume(); });
    const ms = Date.now() - began;
    child.kill();
    return ms;
  };
  const { spawn } = await import('node:child_process');
  assert.ok(await heldFor(spawn) >= 2500, 'a plain start keeps the copy until the program ends');
  assert.ok(await heldFor(spawnClean) < 1500, 'the copy is closed before the program starts');
});
