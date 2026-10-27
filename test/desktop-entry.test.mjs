import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `helm app` writes a desktop entry and icons for the machine's own address.
// Everything lands under XDG_DATA_HOME, so this runs against a temp one and
// never touches the desktop of whoever is running the tests.
const HOME = mkdtempSync(join(tmpdir(), 'helm-desktop-'));
process.env.XDG_DATA_HOME = HOME;
process.env.HELM_DIR = join(HOME, 'helm');
test.after(() => rmSync(HOME, { recursive: true, force: true }));

const entry = () => join(HOME, 'applications', 'helm-app.desktop');

test('the entry points at this machine and names an icon nobody else claims', async (t) => {
  const { installApp } = await import('../packages/connect/src/desktop.js');
  if (process.platform !== 'linux') return t.skip('desktop entries are Linux-only');

  const r = installApp({ url: 'http://127.0.0.1:8787/' });
  const text = readFileSync(entry(), 'utf8');

  assert.match(text, /^Name=helm$/m);
  assert.match(text, /^Exec=.*http:\/\/127\.0\.0\.1:8787\//m);
  // Not `Icon=helm`: the user's icon theme is searched before hicolor, and
  // Papirus ships an unrelated helm.svg that would win every time.
  assert.match(text, /^Icon=helm-app$/m);
  assert.doesNotMatch(text, /^Icon=helm$/m);

  // The icon has to exist at a size the launcher will look for, under that
  // same name, or the entry falls back to a generic square.
  assert.ok(r.icons > 0, 'some icons were installed');
  const sizes = readdirSync(join(HOME, 'icons', 'hicolor'));
  assert.ok(sizes.includes('512x512'), 'a large raster icon');
  assert.ok(existsSync(join(HOME, 'icons', 'hicolor', '512x512', 'apps', 'helm-app.png')));
});

test('a windowed entry only claims to be one when it can be', async (t) => {
  const { installApp } = await import('../packages/connect/src/desktop.js');
  if (process.platform !== 'linux') return t.skip('desktop entries are Linux-only');

  // A browser that is not there cannot give a bare window; the entry still
  // opens the address rather than failing.
  const r = installApp({ url: 'http://127.0.0.1:8787/', browser: 'no-such-browser-9000' });
  const text = readFileSync(entry(), 'utf8');
  assert.equal(r.browser, 'no-such-browser-9000');
  assert.match(text, /^Exec=no-such-browser-9000 .*--app=http:/m);
  assert.match(text, /^StartupWMClass=chrome-127\.0\.0\.1__-Default$/m);
  // Its own profile, set to the system title bar, so a tiling desktop shows
  // no bar repeating the chat's name; the everyday browser profile is untouched.
  assert.match(text, new RegExp(`--user-data-dir=${join(HOME, 'helm', 'app-window')} `));
  const prefs = JSON.parse(readFileSync(join(HOME, 'helm', 'app-window', 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.browser.custom_chrome_frame, false);
});

test('removing it takes the icons with it', async (t) => {
  const { installApp, removeApp } = await import('../packages/connect/src/desktop.js');
  if (process.platform !== 'linux') return t.skip('desktop entries are Linux-only');

  installApp({ url: 'http://127.0.0.1:8787/' });
  const gone = removeApp();
  assert.equal(gone.removed, true);
  assert.ok(gone.icons > 0);
  assert.equal(existsSync(entry()), false);
  assert.equal(existsSync(join(HOME, 'icons', 'hicolor', '512x512', 'apps', 'helm-app.png')), false);
  assert.equal(removeApp().removed, false, 'removing twice is not an error');
});

test('a start puts the current logo into launcher icons, once per logo', async (t) => {
  const { refreshAppIcons } = await import('../packages/connect/src/desktop.js');
  if (process.platform !== 'linux') return t.skip('desktop entries are Linux-only');
  const { writeFileSync, mkdirSync, statSync } = await import('node:fs');
  // Chromium's own launcher for Helm's window, with its own copy of the icon.
  const apps = join(HOME, 'applications');
  mkdirSync(apps, { recursive: true });
  const window = join(process.env.HELM_DIR, 'app-window');
  writeFileSync(join(apps, 'chrome-abc-Default.desktop'), `[Desktop Entry]\nExec=/usr/bin/chromium --user-data-dir=${window} --profile-directory=Default --app=http://127.0.0.1:8787/\nIcon=chrome-abc-Default\n`);
  writeFileSync(join(apps, 'chrome-other-Default.desktop'), '[Desktop Entry]\nExec=/usr/bin/chromium --app=https://example.com/\nIcon=chrome-other-Default\n');
  const icon = (name) => join(HOME, 'icons', 'hicolor', '48x48', 'apps', `${name}.png`);
  mkdirSync(join(HOME, 'icons', 'hicolor', '48x48', 'apps'), { recursive: true });
  writeFileSync(icon('chrome-abc-Default'), 'old logo');
  writeFileSync(icon('chrome-other-Default'), 'not ours');

  const first = refreshAppIcons();
  assert.ok(first.refreshed > 0);
  assert.notEqual(readFileSync(icon('chrome-abc-Default'), 'utf8'), 'old logo', "Helm's launcher shows the current logo");
  assert.ok(statSync(icon('chrome-abc-Default')).size > 100);
  assert.equal(readFileSync(icon('chrome-other-Default'), 'utf8'), 'not ours', 'other web apps keep their icons');
  assert.equal(refreshAppIcons().refreshed, 0, 'the same logo is not drawn again');
});
