import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Notifications on this computer's own desktop, shown by Helm itself.
 *
 * The desktop app is a Chromium window, and a notification Chromium shows
 * for a page is Chromium's: its name and icon, the page's address as an extra
 * line ("127.0.0.1:8787"), and a "Settings" button that opens the browser's
 * site settings. Nothing in the page can change any of that. Shown from here
 * instead it says Helm, carries Helm's icon and only the words that matter,
 * and clicking it brings the Helm window forward on the chat that asked.
 *
 * Only on a Linux desktop where the Helm app is installed (`helm desktop`),
 * and only once that app has turned notifications on - its push
 * subscription is the switch, so "Notify this device" keeps meaning what it
 * says. Pushes to that subscription are then skipped, or every alert would
 * arrive twice.
 */

const ENTRY = 'helm-app.desktop';
const dataHome = () => process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
const entryFile = () => join(dataHome(), 'applications', ENTRY);

function readEntry() {
  try {
    const text = readFileSync(entryFile(), 'utf8');
    const get = (key) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
    return { exec: get('Exec'), wmClass: get('StartupWMClass') };
  } catch { return null; }
}

const onPath = (bin) => (process.env.PATH || '/usr/bin:/bin').split(':')
  .some((dir) => dir && existsSync(join(dir, bin)));

/**
 * A user service starts before the desktop has told systemd where the screen
 * is, and its own environment never learns. Ask the user manager, which does.
 */
let envCache = { at: 0, env: null };
function desktopEnv() {
  if (envCache.env && Date.now() - envCache.at < 60_000) return envCache.env;
  const env = { ...process.env };
  try {
    const out = execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 2000 });
    for (const line of out.split('\n')) {
      const m = /^(WAYLAND_DISPLAY|DISPLAY|NIRI_SOCKET|HYPRLAND_INSTANCE_SIGNATURE|SWAYSOCK|XDG_CURRENT_DESKTOP|DBUS_SESSION_BUS_ADDRESS)=(.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* not under systemd: our own environment is all there is */ }
  if (!env.DBUS_SESSION_BUS_ADDRESS && typeof process.getuid === 'function') {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${process.getuid()}/bus`;
  }
  envCache = { at: Date.now(), env };
  return env;
}

/** Can this machine show its own notifications at all? */
export function desktopCapable() {
  if (process.platform !== 'linux' || process.env.HELM_NO_DESKTOP_NOTIFY) return false;
  return !!readEntry() && onPath('notify-send');
}

/** The sharpest icon file we can find; the theme name if there is none. */
function iconPath() {
  for (const size of ['128x128', '256x256', '192x192', '512x512']) {
    const p = join(dataHome(), 'icons', 'hicolor', size, 'apps', 'helm-app.png');
    if (existsSync(p)) return p;
  }
  return 'helm-app';
}

const run = (bin, args, env) => {
  try { return execFileSync(bin, args, { env, encoding: 'utf8', timeout: 3000 }); } catch { return null; }
};

/**
 * Bring the Helm window to the front. Each compositor has its own way to be
 * asked; one that is not running simply fails and the next is tried.
 */
function raise(wmClass, env) {
  if (!wmClass) return false;
  if (env.NIRI_SOCKET) {
    const list = run('niri', ['msg', '--json', 'windows'], env);
    const win = list && JSON.parse(list).find((w) => w.app_id === wmClass);
    if (win) return run('niri', ['msg', 'action', 'focus-window', '--id', String(win.id)], env) !== null;
  }
  if (env.HYPRLAND_INSTANCE_SIGNATURE) {
    const list = run('hyprctl', ['clients', '-j'], env);
    const win = list && JSON.parse(list).find((w) => w.class === wmClass);
    if (win) return run('hyprctl', ['dispatch', 'focuswindow', `address:${win.address}`], env) !== null;
  }
  if (env.SWAYSOCK) {
    return run('swaymsg', [`[app_id="${wmClass}"]`, 'focus'], env) !== null;
  }
  return false;
}

/** Start the Helm app, already pointed at the chat. */
function launch(exec, hash, env) {
  const parts = exec.split(/\s+/).filter(Boolean)
    .map((arg) => (arg.startsWith('--app=') && hash ? `${arg}${hash}` : arg));
  if (!parts.length) return;
  try {
    spawn(parts[0], parts.slice(1), { env, detached: true, stdio: 'ignore' }).unref();
  } catch { /* nothing to open it with */ }
}

/**
 * @param {{ onOpen: (target: { envId: string|null, sessionId: string|null }) => boolean }} hooks
 *   `onOpen` tells an open Helm window where to go and says whether one heard.
 */
export function createDesktopNotifier({ onOpen = () => false } = {}) {
  /** tag -> { id, child }, so a repeat replaces and an answer closes. */
  const shown = new Map();

  function close(tag) {
    const n = shown.get(tag);
    if (!n) return;
    shown.delete(tag);
    if (n.id) {
      run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications',
        '--object-path', '/org/freedesktop/Notifications',
        '--method', 'org.freedesktop.Notifications.CloseNotification', String(n.id)], desktopEnv());
    }
    try { n.child?.kill(); } catch { /* already gone */ }
  }

  function show(payload) {
    if (payload.resolve) { close(payload.tag); return true; }
    const entry = readEntry();
    if (!entry) return false;
    const env = desktopEnv();
    const done = String(payload.tag ?? '').startsWith('helm-done-');
    // "Helm · " is the app name's job here; the title is what happened.
    const title = String(payload.title || 'Your agent needs you').replace(/^Helm\s*·\s*/, '');
    const previous = shown.get(payload.tag);
    const args = [
      '--app-name=Helm', `--icon=${iconPath()}`,
      '--hint=string:desktop-entry:helm-app',
      `--urgency=${done ? 'normal' : 'critical'}`,
      '--print-id', '--action=default=Open',
      ...(previous?.id ? [`--replace-id=${previous.id}`] : []),
      title, String(payload.body || ''),
    ];
    let child;
    try {
      child = spawn('notify-send', args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return false; }
    if (previous) try { previous.child?.kill(); } catch { /* gone */ }
    const record = { id: previous?.id ?? null, child };
    shown.set(payload.tag, record);
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const [id] = out.split('\n');
      if (/^\d+$/.test(id)) record.id = Number(id);
    });
    child.on('error', () => {});
    child.on('close', () => {
      if (shown.get(payload.tag) === record) shown.delete(payload.tag);
      if (!out.split('\n').slice(1).includes('default')) return;
      const target = { envId: payload.envId ?? null, sessionId: payload.sessionId ?? null };
      const told = onOpen(target);
      const raised = raise(entry.wmClass, env);
      // No Helm window anywhere: open one, already on the chat.
      if (!told && !raised) {
        launch(entry.exec, target.envId && target.sessionId ? `#open=${target.envId}/${target.sessionId}` : '', env);
      }
    });
    return true;
  }

  return { show, close };
}

/**
 * The Helm windows open on this computer, as the hub sees them.
 *
 * Each one keeps a request waiting here (`wait`) carrying what it is looking
 * at and whether it has focus. That is how an alert about the chat you are
 * already reading stays quiet, and how clicking an alert reaches a window
 * that is already open instead of opening a second one.
 */
export function createDesktopWindows({ holdMs = 25_000, graceMs = 5_000 } = {}) {
  /** window id -> { state, at, answer? } */
  const windows = new Map();
  let queued = null;

  const fresh = (w) => w.answer || Date.now() - w.at < graceMs;

  function wait(id, state) {
    const prev = windows.get(id);
    prev?.answer?.(null);
    return new Promise((resolve) => {
      const w = { state: state ?? {}, at: Date.now(), answer: null };
      windows.set(id, w);
      if (queued && Date.now() - queued.at < graceMs) {
        const target = queued.target;
        queued = null;
        w.at = Date.now();
        resolve(target);
        return;
      }
      const timer = setTimeout(() => finish(null), holdMs);
      timer.unref?.();
      function finish(value) {
        clearTimeout(timer);
        if (w.answer === finish) w.answer = null;
        w.at = Date.now();
        resolve(value);
      }
      w.answer = finish;
    });
  }

  /** Is a focused Helm window showing this chat right now? */
  function watching(envId, sessionId) {
    if (!sessionId) return false;
    for (const w of windows.values()) {
      if (fresh(w) && w.state.focused && w.state.envId === envId && w.state.sessionId === sessionId) return true;
    }
    return false;
  }

  /** Send one open window to a chat. True if a window took it or will. */
  function open(target) {
    const live = [...windows.values()].filter((w) => w.answer);
    if (live.length) { live[0].answer(target); return true; }
    if ([...windows.values()].some(fresh)) { queued = { target, at: Date.now() }; return true; }
    return false;
  }

  function forget(id) { windows.get(id)?.answer?.(null); windows.delete(id); }

  return { wait, watching, open, forget };
}

let shared = null;
/** One notifier and one window list per hub process. */
export function desktop() {
  if (!shared) {
    const windows = createDesktopWindows();
    const notifier = createDesktopNotifier({ onOpen: (target) => windows.open(target) });
    shared = { windows, notifier, capable: desktopCapable() };
  }
  return shared;
}
