import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
  packageFamily, packagesFor, installCommand, findDisplay, connectionsTo, screenForwardId, sourceHash, SCREEN_URL, SOURCE_DIR, Screens, keysReady, UINPUT_COMMAND, UINPUT_RULE_FILE,
} = await import('../packages/connect/src/screen.js');
test.after(() => rmSync(base, { recursive: true, force: true }));

const tsv = readFileSync(join(SOURCE_DIR, 'packages.tsv'), 'utf8');

test('the package tool comes from os-release, its ID or ID_LIKE', () => {
  assert.equal(packageFamily('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n'), 'apt');
  assert.equal(packageFamily('NAME="Omarchy"\nID=omarchy\nID_LIKE="arch"\n'), 'pacman');
  assert.equal(packageFamily('ID=cachyos\nID_LIKE=arch\n'), 'pacman');
  assert.equal(packageFamily('ID="fedora"\n'), 'dnf');
  assert.equal(packageFamily('ID=alpine\n'), 'apk');
  assert.equal(packageFamily('ID=nixos\n'), null);
});

test('a real desktop needs the build libraries, not a virtual desktop', () => {
  const arch = packagesFor('wayland', 'pacman', tsv);
  for (const name of ['base-devel', 'x264', 'libwebsockets', 'wayland', 'wayland-protocols', 'libxkbcommon']) assert.ok(arch.includes(name), name);
  for (const name of ['sway', 'foot', 'xorg-xwayland']) assert.ok(!arch.includes(name), name);
  const ubuntu = packagesFor('x11', 'apt', tsv);
  for (const name of ['build-essential', 'libx264-dev', 'libwebsockets-dev', 'libxtst-dev', 'libxdamage-dev']) assert.ok(ubuntu.includes(name), name);
  for (const name of ['xvfb', 'xfce4-session', 'thunar', 'libwayland-dev']) assert.ok(!ubuntu.includes(name), name);
  assert.equal(new Set(ubuntu).size, ubuntu.length);
  assert.deepEqual(packagesFor('x11', null, tsv), []);
  assert.equal(installCommand('pacman', ['x264', 'libwebsockets']), 'pacman -S --needed --noconfirm x264 libwebsockets');
  assert.match(installCommand('apt', ['libx264-dev']), /^DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libx264-dev$/);
  assert.equal(installCommand(null, ['x']), null);
  assert.equal(installCommand('apt', []), null);
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

test('a viewer counts as an open connection to the engine port', () => {
  const tables = {
    '/proc/net/tcp': [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:B2C5 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1',
      '   1: 0100007F:B2C5 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 2 1',
      '   2: 0100007F:9C40 0100007F:B2C5 01 00000000:00000000 00:00000000 00000000  1000        0 3 1',
    ].join('\n'),
  };
  const read = (f) => { if (!(f in tables)) throw new Error('none'); return tables[f]; };
  assert.equal(connectionsTo(0xB2C5, read), 1);
  assert.equal(connectionsTo(0x1234, read), 0);
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

test('the engine source hash changes with the source only', () => {
  assert.match(sourceHash(), /^[0-9a-f]{16}$/);
  assert.equal(sourceHash(), sourceHash());
});

test('the window call refuses any link but a screen link', async () => {
  const screens = new Screens({ network: () => ({ self: 'x', machines: {} }), forwards: { list: () => [] } });
  await assert.rejects(screens.window({ url: 'http://127.0.0.1:1/?name=x#token=bad' }), /not a screen link/);
  await assert.rejects(screens.window({ url: 'https://example.com/' }), /not a screen link/);
  assert.ok(!existsSync(join(process.env.HELM_DIR, 'screen', 'engine.json')));
});

test('desktop shortcuts need a kernel keyboard this account may use', () => {
  const dev = join(base, 'uinput');
  writeFileSync(dev, '', { mode: 0o600 });
  assert.equal(keysReady(dev), true);
  assert.equal(keysReady(join(base, 'none')), false);
  // The rule gives the device to the signed-in person only, and loads it now.
  assert.ok(UINPUT_COMMAND.startsWith(`printf '%s\\n' 'KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess"`));
  assert.match(UINPUT_RULE_FILE, /^\/etc\/udev\/rules\.d\/(?:[0-6]\d|7[0-2])-/, "uaccess works only before 73-seat-late");
  assert.match(UINPUT_COMMAND, /udevadm trigger --action=add --name-match=uinput/);
});

test('the engine paces by the viewer, not by the tunnel on its own machine', async () => {
  const { engineArgs } = await import('../packages/connect/src/screen.js');
  const args = engineArgs({ port: 4000, tokenFile: '/t', backend: 'wayland', viewerDir: '/v' });
  // Without it the engine reads its loopback TCP numbers and sends 2-3 frames per round trip.
  assert.ok(args.includes('--behind-tls-proxy'));
  assert.equal(args[args.indexOf('--bitrate-max') + 1], '16000000');
});

test('screens open in their own profile that may fill the display and take the keys', async () => {
  const { seedScreenProfile, SCREEN_SITE } = await import('../packages/connect/src/desktop.js');
  const dir = join(base, 'screen-window');
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify({ keep: 1, profile: { name: 'x', content_settings: { exceptions: { keyboard_lock: { 'https://a.example:443,*': { setting: 2 } } } } } }));
  assert.equal(seedScreenProfile(dir), true);
  const prefs = JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(SCREEN_SITE, 'http://127.0.0.1:*,*');
  for (const name of ['automatic_fullscreen', 'keyboard_lock', 'brave_webcompat_keyboard']) {
    assert.deepEqual(prefs.profile.content_settings.exceptions[name][SCREEN_SITE], { setting: 1 }, name);
  }
  // What was there stays.
  assert.equal(prefs.keep, 1);
  assert.equal(prefs.profile.name, 'x');
  assert.deepEqual(prefs.profile.content_settings.exceptions.keyboard_lock['https://a.example:443,*'], { setting: 2 });
  assert.equal(prefs.browser.custom_chrome_frame, false);
});
