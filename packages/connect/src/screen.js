import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants as fsConstants, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELM_DIR } from './paths.js';
import { runAsAdmin } from './sudo.js';
import { openAppWindow } from './desktop.js';

/**
 * Remote screens: the owner sees and uses another machine's real desktop.
 *
 * The engine is screen-relay's (native/screen, Apache-2.0, copied as it
 * ships). Each machine builds it once into ~/.helm/screen, never inside the
 * checkout. It listens on this machine's 127.0.0.1 only and needs a fresh
 * 64-character key on every request; the key travels in owner-only calls
 * and then in the viewer link's fragment, so no other local page can use it.
 * The picture reaches the owner's computer as a Helm forward (forwards.js),
 * the same path as `helm forward`. The owner's device asks for both the
 * screen and the forward itself: a machine, and so an agent on it, can
 * never open another machine's screen.
 *
 * The engine is its own process group: a Helm restart does not end a screen
 * the owner is using. It stops after IDLE_MS with no viewer.
 */

export const SOURCE_DIR = fileURLToPath(new URL('../../../native/screen/', import.meta.url));
const stateDir = () => join(HELM_DIR, 'screen');
const stateFile = () => join(stateDir(), 'engine.json');
// The owner closes the window when done; a minute covers a reload or a quick reopen.
export const IDLE_MS = 60_000;
// Change it with the engine's options below, so a running engine restarts with them.
const ENGINE_OPTIONS = 2;

export const SCREEN_URL = /^http:\/\/127\.0\.0\.1:\d{2,5}\/\?name=[^#\s]*#token=[0-9a-f]{64}$/;

// Only screen-relay's own virtual desktop needs these; Helm shows the real one.
const VIRTUAL_ONLY = new Set(['Xvfb', 'xauth', 'xprop', 'xwininfo', 'xdpyinfo', 'setxkbmap', 'sway', 'Xwayland', 'foot']);
const FAMILY_COLUMN = { apt: 2, dnf: 3, pacman: 4, apk: 5 };
const INSTALL = {
  apt: 'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends',
  dnf: 'dnf install -y',
  pacman: 'pacman -S --needed --noconfirm',
  apk: 'apk add',
};

// On Wayland the engine presses keys through a kernel keyboard, so the
// desktop's own shortcuts work (niri ignores them from a Wayland virtual
// keyboard). This rule lets the signed-in person use /dev/uinput; "uaccess"
// is the same rule that gives them their sound card and camera.
export const UINPUT_RULE_FILE = '/etc/udev/rules.d/70-helm-screen.rules';
export const UINPUT_COMMAND = `printf '%s\\n' 'KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput"' > ${UINPUT_RULE_FILE}`
  + ' && (modprobe uinput || true) && udevadm control --reload-rules && udevadm trigger --action=add --name-match=uinput && udevadm settle';

/** Whether this user may make a kernel keyboard. */
export function keysReady(path = '/dev/uinput') {
  try { accessSync(path, fsConstants.W_OK); return true; } catch { return false; }
}

function run(cmd, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ code: null, out: error.message }); return; }
    const keep = (d) => { out = (out + d).slice(-32 * 1024); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, out: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** The package tool of this Linux, from /etc/os-release. */
export function packageFamily(osRelease) {
  const field = (k) => (new RegExp(`^${k}=("?)([^"\\n]*)\\1`, 'm').exec(osRelease)?.[2] ?? '').toLowerCase();
  const ids = `${field('ID')} ${field('ID_LIKE')}`;
  if (/\b(debian|ubuntu)\b/.test(ids)) return 'apt';
  if (/\b(fedora|rhel|centos)\b/.test(ids)) return 'dnf';
  if (/\barch\b/.test(ids)) return 'pacman';
  if (/\balpine\b/.test(ids)) return 'apk';
  return null;
}

/** The system packages the engine build needs for one backend. */
export function packagesFor(backend, family, tsv) {
  const column = FAMILY_COLUMN[family];
  if (column == null) return [];
  const names = new Set();
  for (const line of tsv.split('\n')) {
    const cells = line.split('\t');
    if (cells.length < 6 || (cells[0] !== 'core' && cells[0] !== backend) || VIRTUAL_ONLY.has(cells[1])) continue;
    for (const name of cells[column].split(/\s+/)) if (name && name !== '-') names.add(name);
  }
  return [...names];
}

export function installCommand(family, packages) {
  return INSTALL[family] && packages.length ? `${INSTALL[family]} ${packages.join(' ')}` : null;
}

/**
 * The desktop the owner is signed in to. A user service often starts
 * before the desktop, so its own environment may lack the display: the
 * user manager's environment (systemctl --user) has it.
 */
export async function findDisplay({ env = process.env, platform = process.platform, uid = process.getuid?.(), session = null } = {}) {
  if (platform !== 'linux') {
    return { error: `Helm shows screens of Linux machines only for now. This machine runs ${platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform}.` };
  }
  if (!session) {
    session = {};
    const r = await run('systemctl', ['--user', 'show-environment'], { timeoutMs: 5000 });
    if (r.code === 0) for (const line of r.out.split('\n')) {
      const cut = line.indexOf('=');
      if (cut > 0) session[line.slice(0, cut)] = line.slice(cut + 1);
    }
  }
  const pick = (k) => session[k] || env[k] || '';
  const runtime = pick('XDG_RUNTIME_DIR') || `/run/user/${uid}`;
  const wayland = pick('WAYLAND_DISPLAY');
  const desktop = pick('XDG_CURRENT_DESKTOP');
  if (wayland && existsSync(join(runtime, wayland))) {
    // These do not offer the wlroots screen copy that the engine uses.
    if (/gnome|kde|plasma|cosmic/i.test(desktop)) {
      return { error: `${desktop} on Wayland does not let Helm see the screen. Sign in to an X11 session, or use niri, sway or Hyprland.` };
    }
    return { backend: 'wayland', display: wayland, desktop, env: { WAYLAND_DISPLAY: wayland, XDG_RUNTIME_DIR: runtime } };
  }
  const x = pick('DISPLAY');
  if (x) {
    const xauth = pick('XAUTHORITY');
    return { backend: 'x11', display: x, desktop, env: { DISPLAY: x, XDG_RUNTIME_DIR: runtime, ...(xauth ? { XAUTHORITY: xauth } : {}) } };
  }
  return { error: 'Nobody is signed in to a desktop on this machine.' };
}

/** A hash of the engine source: a new source builds a new engine. */
export function sourceHash(dir = SOURCE_DIR) {
  const hash = createHash('sha256');
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = join(rel, name);
      if (statSync(join(dir, path)).isDirectory()) walk(path);
      else hash.update(path).update('\0').update(readFileSync(join(dir, path)));
    }
  };
  hash.update(readFileSync(join(dir, 'Makefile')));
  walk('src');
  return hash.digest('hex').slice(0, 16);
}

/** Established TCP connections to a port on this machine (Linux). */
export function connectionsTo(port, read = (f) => readFileSync(f, 'utf8')) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  let count = 0;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = read(file); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cells = line.trim().split(/\s+/);
      if (cells[1]?.endsWith(`:${hex}`) && cells[3] === '01') count++;
    }
  }
  return count;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/**
 * The forward id of one machine's screen on one computer. The Helm app makes
 * the same id (apps/web/src/screen.ts), so stop() finds the forward.
 */
export const screenForwardId = (source, target) => createHash('sha256').update(`screen:${source}:${target}`).digest('hex').slice(0, 16);

/** What the engine starts with. Change ENGINE_OPTIONS with it. */
export function engineArgs({ port, tokenFile, backend, viewerDir }) {
  return [
    '--bind', '127.0.0.1', '--port', String(port), '--token-file', tokenFile,
    // The engine writes to Helm's tunnel on this machine's loopback. Its
    // TCP numbers then show a link of a few microseconds, so it let only
    // two or three pictures travel at once: about 3 a second on a 360 ms
    // path (measured 2026-11-23). --behind-tls-proxy makes it ignore those
    // numbers and pace by the viewer's own acknowledgements, which come
    // back over the real path (flow.hpp, "without transport").
    '--behind-tls-proxy',
    // A cap still keeps a slow link from filling with one big burst.
    '--fps', '60', '--bitrate-min', '500000', '--bitrate-start', '3000000', '--bitrate-max', '16000000',
    '--backend', backend, '--viewer-dir', viewerDir,
  ];
}

export class Screens {
  #building = null;
  #sweep = null;
  #idleSince = null;

  /**
   * @param {object} o
   * @param {() => object} o.network   the roster
   * @param {object} o.forwards  this machine's Forwards
   */
  constructor({ network, forwards, log = () => {}, now = Date.now, idleMs = IDLE_MS, source = SOURCE_DIR, canPressKeys = keysReady } = {}) {
    this.network = network;
    this.keysReady = () => canPressKeys();
    this.forwards = forwards;
    this.log = log;
    this.now = now;
    this.idleMs = idleMs;
    this.source = source;
  }

  begin() {
    this.#sweep = setInterval(() => { void this.#checkIdle(); }, 10_000);
    this.#sweep.unref?.();
  }

  close() { clearInterval(this.#sweep); }

  #state() {
    try {
      const s = JSON.parse(readFileSync(stateFile(), 'utf8'));
      return Number.isInteger(s?.pid) && Number.isInteger(s?.port) && /^[0-9a-f]{64}$/.test(s?.token ?? '') ? s : null;
    } catch { return null; }
  }

  #running() {
    const s = this.#state();
    return s && alive(s.pid) ? s : null;
  }

  #enginePath(backend) { return join(stateDir(), `engine-${sourceHash(this.source)}-${backend}`, 'relay-engine'); }

  async #family() {
    try { return packageFamily(readFileSync('/etc/os-release', 'utf8')); } catch { return null; }
  }

  async #missing(backend) {
    const r = await run('make', ['-s', '-C', this.source, 'deps', `BACKENDS=${backend}`], { timeoutMs: 30_000 });
    if (r.code === 0) return null;
    const family = await this.#family();
    const packages = family ? packagesFor(backend, family, readFileSync(join(this.source, 'packages.tsv'), 'utf8')) : [];
    return { family, packages, command: installCommand(family, packages), said: r.out.trim().split('\n').slice(-3).join(' ') };
  }

  /** What the owner's screen menu shows for this machine. */
  async status() {
    const display = await findDisplay();
    if (display.error) return { supported: false, error: display.error };
    const built = existsSync(this.#enginePath(display.backend));
    const running = this.#running();
    const missing = built ? null : await this.#missing(display.backend);
    return {
      supported: true, backend: display.backend, display: display.display, desktop: display.desktop,
      built, running: !!running, needsSetup: !!missing || this.#needsKeys(display.backend), packages: missing?.packages ?? [],
    };
  }

  #needsKeys(backend) { return backend === 'wayland' && !this.keysReady(); }

  /** Install the system packages and the keyboard rule (owner only), then build. */
  async setup() {
    const display = await findDisplay();
    if (display.error) throw new Error(display.error);
    const missing = await this.#missing(display.backend);
    if (missing) {
      if (!missing.command) throw new Error(`Helm does not know how to install packages on this Linux. Install a C++ compiler, make, pkg-config, x264, libwebsockets and the ${display.backend} libraries, then try again.`);
      this.log(`screen: installing ${missing.packages.join(' ')}`);
      const done = await runAsAdmin(missing.command, { machine: this.#name(this.network()?.self) });
      if (done.message) throw new Error(done.message);
      if (done.code !== 0) throw new Error(`The package install failed: ${done.output.trim().split('\n').slice(-3).join(' ')}`);
      const still = await this.#missing(display.backend);
      if (still) throw new Error(`Packages are still missing after the install: ${still.said}`);
    }
    if (this.#needsKeys(display.backend)) {
      this.log('screen: letting the engine use a kernel keyboard');
      const done = await runAsAdmin(UINPUT_COMMAND, { machine: this.#name(this.network()?.self) });
      if (done.message) throw new Error(done.message);
      if (done.code !== 0) throw new Error(`Helm could not let the screen press desktop shortcuts: ${done.output.trim().split('\n').slice(-2).join(' ')}`);
      if (!this.keysReady()) throw new Error('The keyboard rule is in place, but this account still cannot use it. Sign out and in again on this machine, then try again.');
    }
    await this.#build(display.backend);
    return this.status();
  }

  #build(backend) {
    const target = this.#enginePath(backend);
    if (existsSync(target)) return Promise.resolve(target);
    this.#building ??= (async () => {
      const dir = join(stateDir(), `build-${process.pid}-${randomBytes(3).toString('hex')}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        cpSync(join(this.source, 'Makefile'), join(dir, 'Makefile'));
        cpSync(join(this.source, 'src'), join(dir, 'src'), { recursive: true });
        this.log(`screen: building the ${backend} engine`);
        const r = await run('make', ['-s', '-C', dir, `BACKENDS=${backend}`, 'relay-engine'], { timeoutMs: 10 * 60_000 });
        if (r.code !== 0) throw new Error(`The screen program did not build: ${r.out.trim().split('\n').slice(-4).join(' ')}`);
        mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
        renameSync(join(dir, 'relay-engine'), target);
        // Engines of older sources are not used again.
        for (const name of readdirSync(stateDir())) {
          if (name.startsWith('engine-') && !target.includes(`/${name}/`)) rmSync(join(stateDir(), name), { recursive: true, force: true });
        }
        return target;
      } finally {
        rmSync(dir, { recursive: true, force: true });
        this.#building = null;
      }
    })();
    return this.#building;
  }

  async #answers(port, token) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/capabilities`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  /** Start the engine on this machine's real screen, or reuse the one that runs. */
  async start({ withoutKeys = false } = {}) {
    const display = await findDisplay();
    if (display.error) return { error: display.error };
    const keys = display.backend !== 'wayland' || this.keysReady();
    if (!keys && !withoutKeys) {
      const missing = existsSync(this.#enginePath(display.backend)) ? null : await this.#missing(display.backend);
      return { needs: 'setup', keys: true, packages: missing?.packages ?? [], canInstall: !missing || !!missing.command };
    }
    const running = this.#running();
    // An engine started before the keyboard rule keeps the old keys, and one
    // started with older options keeps them too: start a new one.
    const stale = running && ((keys && running.keys === false) || running.options !== ENGINE_OPTIONS);
    if (running && !stale && running.display === display.display && await this.#answers(running.port, running.token)) {
      this.#idleSince = null;
      return { port: running.port, token: running.token, backend: running.backend };
    }
    if (running) this.#kill(running);
    if (!existsSync(this.#enginePath(display.backend))) {
      const missing = await this.#missing(display.backend);
      if (missing) return { needs: 'setup', packages: missing.packages, canInstall: !!missing.command };
      await this.#build(display.backend);
    }
    const engine = this.#enginePath(display.backend);
    const viewerDir = this.#viewer();
    const port = await freePort();
    const token = randomBytes(32).toString('hex');
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const tokenFile = join(stateDir(), 'token');
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const logFile = join(stateDir(), 'engine.log');
    const logFd = openSync(logFile, 'w', 0o600);
    let child;
    try {
      child = spawn(engine, engineArgs({ port, tokenFile, backend: display.backend, viewerDir }), { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG ?? 'C.UTF-8', ...display.env }, stdio: ['ignore', logFd, logFd], detached: true });
    } finally { closeSync(logFd); }
    child.unref();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    let caps = null;
    for (let i = 0; i < 50 && !caps; i++) {
      const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);
      if (gone) break;
      caps = await this.#answers(port, token);
    }
    if (!caps) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* it ended */ }
      let said = '';
      try { said = readFileSync(logFile, 'utf8').trim().split('\n').filter((l) => !/^\[|x264 \[info\]/.test(l)).slice(-2).join(' '); } catch { /* no log */ }
      return { error: `The screen program did not start${said ? `: ${said}` : '.'}` };
    }
    writeFileSync(stateFile(), JSON.stringify({ pid: child.pid, port, token, backend: display.backend, display: display.display, keys, options: ENGINE_OPTIONS, startedAt: this.now() }), { mode: 0o600 });
    this.#idleSince = null;
    this.log(`screen: engine on port ${port} (${display.backend} ${display.display})`);
    return { port, token, backend: display.backend, width: caps.width, height: caps.height };
  }

  /** The engine serves index.html and viewer.js only: Helm's part rides in viewer.js. */
  #viewer() {
    const dir = join(stateDir(), 'viewer');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const from = join(this.source, 'viewer');
    writeFileSync(join(dir, 'index.html'), readFileSync(join(from, 'index.html')));
    writeFileSync(join(dir, 'viewer.js'), `${readFileSync(join(from, 'viewer.js'), 'utf8')}\n${readFileSync(join(from, 'helm.js'), 'utf8')}`);
    return dir;
  }

  #kill(state) {
    try { process.kill(-state.pid, 'SIGTERM'); } catch { try { process.kill(state.pid, 'SIGTERM'); } catch { /* it ended */ } }
  }

  /** Stop the engine and the forwards that carry it. */
  async stop() {
    const running = this.#running();
    rmSync(stateFile(), { force: true });
    if (running) this.#kill(running);
    const self = this.network()?.self;
    for (const f of this.forwards?.list() ?? []) {
      if (f.side === 'out' && running && f.port === running.port && f.id === screenForwardId(self, f.peer)) {
        await this.forwards.remove(f.id, { notify: true }).catch(() => {});
      }
    }
    return { stopped: !!running };
  }

  async #checkIdle() {
    const running = this.#running();
    if (!running) { this.#idleSince = null; return; }
    if (connectionsTo(running.port) > 0) { this.#idleSince = null; return; }
    this.#idleSince ??= this.now();
    if (this.now() - this.#idleSince >= this.idleMs) {
      this.log('screen: nobody watched for a while; stopping the engine');
      this.#idleSince = null;
      await this.stop();
    }
  }

  /**
   * On the owner's computer: show a screen link in its own Helm app window.
   * Only a viewer link of this machine's loopback, so no other page opens.
   */
  async window({ url } = {}) {
    if (typeof url !== 'string' || !SCREEN_URL.test(url)) throw new Error('That is not a screen link.');
    const display = await findDisplay();
    if (display.error) return { opened: false };
    const env = { ...process.env, ...display.env };
    if (!env.DBUS_SESSION_BUS_ADDRESS && display.env.XDG_RUNTIME_DIR) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${display.env.XDG_RUNTIME_DIR}/bus`;
    return { opened: openAppWindow(url, { env }) };
  }

  #name(id) { return this.network()?.machines?.[id]?.name ?? id; }
}
