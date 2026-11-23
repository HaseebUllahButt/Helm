import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `helm app` writes a desktop entry for the machine's own address.
// Everything lands under XDG_DATA_HOME, so this runs against a temp one and
// never touches the desktop of whoever is running the tests.
const HOME = mkdtempSync(join(tmpdir(), 'helm-desktop-'));
process.env.XDG_DATA_HOME = HOME;
process.env.HELM_DIR = join(HOME, 'helm');
test.after(() => rmSync(HOME, { recursive: true, force: true }));

const entry = () => join(HOME, 'applications', 'helm-app.desktop');

test('the app window uses its own profile, so the everyday browser is untouched', async (t) => {
  const { installApp } = await import('../packages/connect/src/desktop.js');
  if (process.platform !== 'linux') return t.skip('desktop entries are Linux-only');

  installApp({ url: 'http://127.0.0.1:8787/', browser: 'no-such-browser-9000' });
  const text = readFileSync(entry(), 'utf8');
  assert.match(text, new RegExp(`--user-data-dir=${join(HOME, 'helm', 'app-window')} `));
  const prefs = JSON.parse(readFileSync(join(HOME, 'helm', 'app-window', 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.browser.custom_chrome_frame, false, "the system title bar, never Chromium's buttons");
});

test('a start updates an old launcher, but only for the Helm it opens', async (t) => {
  const { refreshAppLauncher } = await import('../packages/connect/src/desktop.js');
  if (process.platform !== 'linux') return t.skip('desktop entries are Linux-only');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(HOME, 'applications'), { recursive: true });
  const old = '[Desktop Entry]\nExec=/usr/bin/chromium --profile-directory=Default --app=http://127.0.0.1:8787/\n';
  writeFileSync(entry(), old);
  assert.equal(refreshAppLauncher({ url: 'http://127.0.0.1:9999/' }).updated, false, 'a test copy on another port leaves it');
  assert.equal(readFileSync(entry(), 'utf8'), old);

  assert.equal(refreshAppLauncher({ url: 'http://127.0.0.1:8787/' }).updated, true);
  assert.match(readFileSync(entry(), 'utf8'), new RegExp(`^Exec=/usr/bin/chromium --user-data-dir=${join(HOME, 'helm', 'app-window')} .*--app=http://127\\.0\\.0\\.1:8787/$`, 'm'));
  assert.equal(refreshAppLauncher({ url: 'http://127.0.0.1:8787/' }).updated, false, 'once is enough');

  // A launcher reads the owner's flags file: the window must load no add-ons, Helm's own among them.
  assert.match(readFileSync(entry(), 'utf8'), /^Exec=.* --disable-extensions .*--app=/m);
  writeFileSync(entry(), `[Desktop Entry]\nExec=/usr/bin/chromium --user-data-dir=${join(HOME, 'helm', 'app-window')} --profile-directory=Default --no-first-run --app=http://127.0.0.1:8787/\n`);
  assert.equal(refreshAppLauncher({ url: 'http://127.0.0.1:8787/' }).updated, true, 'an entry without --disable-extensions is rewritten');
  assert.match(readFileSync(entry(), 'utf8'), /--disable-extensions/);
});

test('a frame change waits until the Helm window closes', async (t) => {
  const { syncWindowFrame } = await import('../packages/connect/src/desktop.js');
  if (process.platform !== 'linux') return t.skip('desktop entries are Linux-only');
  const { writeFileSync, mkdirSync, symlinkSync, unlinkSync } = await import('node:fs');
  const dir = join(process.env.HELM_DIR, 'app-window');
  const prefs = () => JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8')).browser;
  mkdirSync(join(dir, 'Default'), { recursive: true });
  // Earlier Helm set Chromium's own frame.
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({ browser: { custom_chrome_frame: true, other: 1 } }));

  // A child process stands in for the browser that holds the profile. It
  // lets go of the lock before it exits and writes its settings last.
  const { spawn } = await import('node:child_process');
  const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => browser.kill());
  symlinkSync(`machine-${browser.pid}`, join(dir, 'SingletonLock'));
  let changed;
  const done = new Promise((resolve) => { changed = resolve; });
  const r = syncWindowFrame({ onChange: changed, everyMs: 20 });
  assert.equal(r.waiting, true);
  unlinkSync(join(dir, 'SingletonLock'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prefs().custom_chrome_frame, true, 'the browser has not exited yet');
  browser.kill();
  await done;
  assert.deepEqual(prefs(), { custom_chrome_frame: false, other: 1 }, 'the system title bar, other settings kept');
  assert.equal(syncWindowFrame().waiting, false, 'nothing left to change');
});
