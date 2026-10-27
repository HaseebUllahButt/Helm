import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, accessSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HELM_DIR } from './paths.js';

/**
 * helm as a desktop application: its own window, its own icon, opening the
 * helm running on this machine.
 *
 * Installing the PWA from the browser looks like the same thing and is not.
 * A phone installs it from the VM's public address, which is right there -
 * but a computer that runs a daemon of its own then has an app whose scope is
 * the VM's origin, so opening it lands on a pairing screen and going where it
 * should means leaving that scope, which the browser marks with a grey origin
 * bar across the top. An app window pointed at this machine's own address has
 * none of that: it signs itself in with the local key and there is nothing to
 * click.
 */

/**
 * NOT `helm`. Icon lookup goes through the user's theme before it falls back
 * to hicolor, and Papirus - which a lot of people run - ships an unrelated
 * `helm.svg`. Name the icon `helm` and their launcher shows that instead, at
 * every size, however many copies of ours are installed. This name is nobody
 * else's.
 */
const ICON = 'helm-app';
const ENTRY = 'helm-app.desktop';

/** Chromium-family browsers take `--app=`; that is what gives a bare window. */
const BROWSERS = [
  'chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome',
  'brave-browser', 'brave', 'microsoft-edge-stable', 'vivaldi-stable',
];

const dataHome = () => process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
const appsDir = () => join(dataHome(), 'applications');
const iconDir = (size) => join(dataHome(), 'icons', 'hicolor', size, 'apps');
const assets = () => fileURLToPath(new URL('../../../apps/web/public/', import.meta.url));

/** Walk PATH ourselves rather than asking a shell, which would have to quote. */
const which = (bin) => {
  if (!bin) return null;
  if (bin.includes('/')) return existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const full = join(dir, bin);
    try { accessSync(full, constants.X_OK); return full; } catch { /* keep looking */ }
  }
  return null;
};

const run = (bin, args) => {
  try { execFileSync(bin, args, { stdio: 'ignore' }); return true; } catch { return false; }
};

/** The sizes we can install with no tools at all, straight from the repo. */
const SHIPPED = [['192x192', 'icon-192.png'], ['512x512', 'icon-512.png']];
/** And the ones worth generating when the machine has ImageMagick. */
const RESIZED = [16, 24, 32, 48, 64, 128, 256];

function installIcons() {
  const from = assets();
  const written = [];
  for (const [size, file] of SHIPPED) {
    const src = join(from, file);
    if (!existsSync(src)) continue;
    mkdirSync(iconDir(size), { recursive: true });
    const dest = join(iconDir(size), `${ICON}.png`);
    copyFileSync(src, dest);
    written.push(dest);
  }
  const svg = join(from, 'icon.svg');
  if (existsSync(svg)) {
    mkdirSync(iconDir('scalable'), { recursive: true });
    const dest = join(iconDir('scalable'), `${ICON}.svg`);
    copyFileSync(svg, dest);
    written.push(dest);
  }
  // A 512px source scaled down by the launcher is soft at 32px. Fix it where
  // there is something to fix it with, and do without where there is not.
  const magick = which('magick') || which('convert');
  const big = join(from, 'icon-512.png');
  if (magick && existsSync(big)) {
    for (const px of RESIZED) {
      const dir = iconDir(`${px}x${px}`);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `${ICON}.png`);
      if (run(magick, [big, '-resize', `${px}x${px}`, dest])) written.push(dest);
    }
  }
  return written;
}

/**
 * The window gets a browser profile of its own, set to "use system title bar
 * and borders". Chromium's own bar on an app window only repeated the chat's
 * name; with this, a window manager that draws no title bars (niri with
 * prefer-no-csd, Hyprland, sway) shows none, and one that does (GNOME, KDE)
 * shows its usual one. The owner's everyday browser profile is left alone.
 * Helm signs this window in with the machine's local key, so the separate
 * profile costs nothing to sign into.
 */
const windowProfile = () => join(HELM_DIR, 'app-window');

function seedWindowProfile(dir) {
  const file = join(dir, 'Default', 'Preferences');
  let prefs = {};
  try { prefs = JSON.parse(readFileSync(file, 'utf8')); } catch { /* new profile */ }
  // A choice made in the window's own settings stands.
  if (prefs?.browser?.custom_chrome_frame !== undefined) return;
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...prefs, browser: { ...prefs.browser, custom_chrome_frame: false } }));
}

/**
 * The window class a chromium app window reports, so the launcher can match
 * the window to this entry and show its icon rather than a generic one.
 * Best-effort: it is only ever cosmetic, and getting it wrong costs an icon
 * in the task switcher, not a working app.
 */
const wmClass = (url, profile) => `chrome-${new URL(url).hostname}__-${profile}`;

/**
 * Write the launcher. Returns what it did, so the caller can say it.
 * @param {{ url: string, browser?: string, profile?: string }} opts
 */
export function installApp({ url, browser, profile = 'Default' }) {
  if (platform() !== 'linux') {
    throw new Error(
      'a desktop entry is Linux-only for now - open the address in your browser ' +
      'and use its own "install" menu item');
  }
  const bin = browser ? which(browser) || browser : BROWSERS.map(which).find(Boolean);
  // Without a chromium-family browser there is no bare window to be had, but
  // an entry that opens the right address in the right browser still beats
  // remembering a port.
  const dir = windowProfile();
  if (bin) seedWindowProfile(dir);
  const exec = bin
    ? `${bin} --user-data-dir=${dir} --profile-directory=${profile} --no-first-run --app=${url}`
    : `xdg-open ${url}`;

  const entry = [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    'Name=helm',
    'GenericName=Coding agents',
    'Comment=every coding agent, one place - the helm running on this machine',
    `Exec=${exec}`,
    `Icon=${ICON}`,
    ...(bin ? [`StartupWMClass=${wmClass(url, profile)}`] : []),
    'Categories=Development;',
    'Keywords=helm;agents;claude;codex;',
    'Terminal=false',
    '',
  ].join('\n');

  mkdirSync(appsDir(), { recursive: true });
  const file = join(appsDir(), ENTRY);
  writeFileSync(file, entry, { mode: 0o644 });
  const icons = installIcons();

  // Both are caches of what we just wrote; a launcher that reads the files
  // directly does not need either, and one that does will be stale until the
  // next login without them.
  run('update-desktop-database', [appsDir()]);
  run('gtk-update-icon-cache', ['-f', '-t', join(dataHome(), 'icons', 'hicolor')]);

  return { file, icons: icons.length, browser: bin, url, windowed: !!bin };
}

/**
 * Launcher icons are copies, made once: ours at `helm app`, and Chromium's
 * own when the owner installs Helm from the app window's menu. Chromium never
 * redraws its copy, so a new logo reached the app and never the launcher.
 * Each start puts the current logo in both, once per logo.
 */
export function refreshAppIcons() {
  if (platform() !== 'linux') return { refreshed: 0 };
  const from = assets();
  const big = join(from, 'icon-512.png');
  if (!existsSync(big)) return { refreshed: 0 };
  const stamp = join(HELM_DIR, 'app-icons.stamp');
  const logo = createHash('sha256').update(readFileSync(big)).digest('hex');
  try { if (readFileSync(stamp, 'utf8') === logo) return { refreshed: 0 }; } catch { /* first start */ }

  let refreshed = existsSync(join(appsDir(), ENTRY)) ? installIcons().length : 0;
  const magick = which('magick') || which('convert');
  const svg = join(from, 'icon.svg');
  const rsvg = which('rsvg-convert');
  let entries = [];
  try { entries = readdirSync(appsDir()).filter((f) => f.startsWith('chrome-') && f.endsWith('.desktop')); } catch { /* no launchers */ }
  for (const name of entries) {
    const text = readFileSync(join(appsDir(), name), 'utf8');
    // Only apps installed from Helm's own window profile are Helm.
    if (!text.includes(`--user-data-dir=${windowProfile()} `)) continue;
    const icon = text.match(/^Icon=(.+)$/m)?.[1]?.trim();
    if (!icon || icon.includes('/')) continue;
    let sizes = [];
    try { sizes = readdirSync(join(dataHome(), 'icons', 'hicolor')).filter((s) => /^\d+x\d+$/.test(s)); } catch { /* none */ }
    for (const size of sizes) {
      const dest = join(iconDir(size), `${icon}.png`);
      if (!existsSync(dest)) continue;
      const px = size.split('x')[0];
      const drawn = (magick && run(magick, [big, '-resize', `${px}x${px}`, dest]))
        || (rsvg && existsSync(svg) && run(rsvg, ['-w', px, '-h', px, '-o', dest, svg]));
      if (!drawn) copyFileSync(big, dest);
      refreshed += 1;
    }
  }
  if (refreshed) run('gtk-update-icon-cache', ['-f', '-t', join(dataHome(), 'icons', 'hicolor')]);
  mkdirSync(HELM_DIR, { recursive: true });
  writeFileSync(stamp, logo);
  return { refreshed };
}

/** Take the launcher and its icons away again. */
export function removeApp() {
  const file = join(appsDir(), ENTRY);
  const had = existsSync(file);
  rmSync(file, { force: true });
  let icons = 0;
  for (const size of [...SHIPPED.map(([s]) => s), 'scalable', ...RESIZED.map((p) => `${p}x${p}`)]) {
    for (const ext of ['png', 'svg']) {
      const dest = join(iconDir(size), `${ICON}.${ext}`);
      if (existsSync(dest)) { rmSync(dest, { force: true }); icons += 1; }
    }
  }
  run('update-desktop-database', [appsDir()]);
  return { removed: had, icons };
}
