import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

/**
 * Remote screens (packages/connect/src/screen.js): what each machine works
 * out for itself before it starts the screen-relay engine. The engine itself
 * needs a real desktop and is tried on real machines.
 */

const base = mkdtempSync(join(tmpdir(), 'helm-screen-'));
process.env.HELM_DIR = join(base, 'helm');
const {
  packageFamily, findDisplay, screenForwardId, SCREEN_URL, Screens,
} = await import('../packages/connect/src/screen.js');
test.after(() => rmSync(base, { recursive: true, force: true }));

test('the package tool comes from os-release, its ID or ID_LIKE', () => {
  assert.equal(packageFamily('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n'), 'apt');
  assert.equal(packageFamily('NAME="Omarchy"\nID=omarchy\nID_LIKE="arch"\n'), 'pacman');
  assert.equal(packageFamily('ID=cachyos\nID_LIKE=arch\n'), 'pacman');
  assert.equal(packageFamily('ID="fedora"\n'), 'dnf');
  assert.equal(packageFamily('ID=alpine\n'), 'apk');
  assert.equal(packageFamily('ID=nixos\n'), null);
});

test('the display comes from the user manager, which knows the desktop', async () => {
  const runtime = join(base, 'run');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'wayland-1'), '');
  const niri = await findDisplay({ platform: 'linux', env: {}, session: { WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: runtime, XDG_CURRENT_DESKTOP: 'niri', DISPLAY: ':0' } });
  assert.deepEqual(niri.env, { WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: runtime });
  assert.equal(niri.backend, 'wayland');
  // A stale WAYLAND_DISPLAY with no socket: the X display is the one there.
  const x = await findDisplay({ platform: 'linux', env: { XAUTHORITY: '/tmp/a' }, session: { WAYLAND_DISPLAY: 'wayland-9', XDG_RUNTIME_DIR: runtime, DISPLAY: ':1' } });
  assert.equal(x.backend, 'x11');
  assert.deepEqual(x.env, { DISPLAY: ':1', XDG_RUNTIME_DIR: runtime, XAUTHORITY: '/tmp/a' });
  const gnome = await findDisplay({ platform: 'linux', env: {}, session: { WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: runtime, XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' } });
  assert.match(gnome.error, /does not let Helm see the screen/);
  const none = await findDisplay({ platform: 'linux', env: {}, session: {} });
  assert.match(none.error, /No desktop is open/);
  assert.equal(none.reason, 'no-desktop');
  assert.equal(gnome.reason, 'desktop-kind');
  assert.equal((await findDisplay({ platform: 'darwin' })).reason, 'platform');
  assert.match((await findDisplay({ platform: 'win32' })).error, /Linux machines only for now.*Windows/);
});

test('the app and the machine name the same forward', async () => {
  const bytes = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('screen:laptop:why')));
  const web = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  assert.equal(screenForwardId('laptop', 'why'), web);
  assert.match(web, /^[0-9a-f]{16}$/);
  assert.notEqual(screenForwardId('why', 'laptop'), web);
});

test('only a viewer link of this machine opens a window', () => {
  const token = 'a'.repeat(64);
  assert.ok(SCREEN_URL.test(`http://127.0.0.1:45781/?name=Laptop#token=${token}`));
  assert.ok(!SCREEN_URL.test(`http://evil.example:45781/?name=Laptop#token=${token}`));
  assert.ok(!SCREEN_URL.test(`http://127.0.0.1:45781/?name=Laptop#token=short`));
  assert.ok(!SCREEN_URL.test(`file:///etc/passwd#token=${token}`));
  assert.ok(!SCREEN_URL.test(`http://127.0.0.1:45781/?name=a b#token=${token}`));
  assert.ok(!SCREEN_URL.test(`http://127.0.0.1:45781/x --flag#token=${token}`));
});

test('the window call refuses any link but a screen link', async () => {
  const screens = new Screens({ network: () => ({ self: 'x', machines: {} }), forwards: { list: () => [] } });
  await assert.rejects(screens.window({ url: 'http://127.0.0.1:1/?name=x#token=bad' }), /not a screen link/);
  await assert.rejects(screens.window({ url: 'https://example.com/' }), /not a screen link/);
  assert.ok(!existsSync(join(process.env.HELM_DIR, 'screen', 'engine.json')));
});
