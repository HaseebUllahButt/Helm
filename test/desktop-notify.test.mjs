import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopWindows } from '../apps/relay/src/desktop-notify.js';

test('a focused window on the chat keeps its alert quiet; an unfocused one does not', async () => {
  const w = createDesktopWindows({ holdMs: 50 });
  const pending = w.wait('a', { focused: true, envId: 'e1', sessionId: 's1' });
  assert.equal(w.watching('e1', 's1'), true);
  assert.equal(w.watching('e1', 's2'), false);
  w.wait('a', { focused: false, envId: 'e1', sessionId: 's1' });
  assert.equal(await pending, null, 'a newer report answers the older request');
  assert.equal(w.watching('e1', 's1'), false);
  w.forget('a');
});

test('a click reaches the waiting window, or the next one to check in', async () => {
  const w = createDesktopWindows({ holdMs: 1000 });
  const pending = w.wait('a', {});
  assert.equal(w.open({ envId: 'e1', sessionId: 's1' }), true);
  assert.deepEqual(await pending, { envId: 'e1', sessionId: 's1' });
  // Between two requests: held for the window's next one.
  assert.equal(w.open({ envId: 'e2', sessionId: 's2' }), true);
  assert.deepEqual(await w.wait('a', {}), { envId: 'e2', sessionId: 's2' });
  w.forget('a');
  assert.equal(createDesktopWindows().open({ envId: 'e', sessionId: 's' }), false, 'no window: the caller opens one');
});

test('a launcher with another name still counts when it opens the Helm window', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
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
  writeFileSync(join(dir, 'helm-app.desktop'), '[Desktop Entry]\nExec=helm-window\nStartupWMClass=helm\n');
  assert.deepEqual(findEntry(dir, profile), { exec: 'helm-window', wmClass: 'helm' }, 'Helm\'s own launcher wins');
});
