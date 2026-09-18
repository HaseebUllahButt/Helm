import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `con app` writes a desktop entry and icons for the machine's own address.
// Everything lands under XDG_DATA_HOME, so this runs against a temp one and
// never touches the desktop of whoever is running the tests.
const HOME = mkdtempSync(join(tmpdir(), 'con-desktop-'));
process.env.XDG_DATA_HOME = HOME;
test.after(() => rmSync(HOME, { recursive: true, force: true }));

const entry = () => join(HOME, 'applications', 'con-app.desktop');

test('the entry points at this machine and names an icon nobody else claims', async (t) => {
  const { installApp } = await import('../packages/connect/src/desktop.js');
  if (process.platform !== 'linux') return t.skip('desktop entries are Linux-only');

  const r = installApp({ url: 'http://127.0.0.1:8787/' });
  const text = readFileSync(entry(), 'utf8');

  assert.match(text, /^Name=con$/m);
  assert.match(text, /^Exec=.*http:\/\/127\.0\.0\.1:8787\//m);
  // Not `Icon=con`: the user's icon theme is searched before hicolor, and
  // Papirus ships an unrelated con.svg that would win every time.
  assert.match(text, /^Icon=con-app$/m);
  assert.doesNotMatch(text, /^Icon=con$/m);

  // The icon has to exist at a size the launcher will look for, under that
  // same name, or the entry falls back to a generic square.
  assert.ok(r.icons > 0, 'some icons were installed');
  const sizes = readdirSync(join(HOME, 'icons', 'hicolor'));
  assert.ok(sizes.includes('512x512'), 'a large raster icon');
  assert.ok(existsSync(join(HOME, 'icons', 'hicolor', '512x512', 'apps', 'con-app.png')));
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
});

test('removing it takes the icons with it', async (t) => {
  const { installApp, removeApp } = await import('../packages/connect/src/desktop.js');
  if (process.platform !== 'linux') return t.skip('desktop entries are Linux-only');

  installApp({ url: 'http://127.0.0.1:8787/' });
  const gone = removeApp();
  assert.equal(gone.removed, true);
  assert.ok(gone.icons > 0);
  assert.equal(existsSync(entry()), false);
  assert.equal(existsSync(join(HOME, 'icons', 'hicolor', '512x512', 'apps', 'con-app.png')), false);
  assert.equal(removeApp().removed, false, 'removing twice is not an error');
});
