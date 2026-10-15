// A thread's browser tabs in a real Chromium window on this machine's screen,
// beside Helm. The agent drives the tabs through Chromium's own channel, so
// it never moves the owner's mouse or types on their keyboard; the owner
// just uses the window.
import { existsSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

/** A screen to open a window on: always on a Mac or Windows, a display on Linux. */
export const canOpenWindow = (env = process.env, platform = process.platform) =>
  platform === 'darwin' || platform === 'win32' || !!(env.WAYLAND_DISPLAY || env.DISPLAY);

// The owner's own Chromium looks and feels like their browser; Playwright's
// build is the fallback when none is installed or it will not start.
const systemChromium = () => process.env.HELM_WINDOW_CHROMIUM || [
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

/**
 * One Chromium per thread, with its own profile folder, so its tabs are tabs
 * in one window and its sign-ins outlive the window. `name` is the window's
 * app id: a window manager rule on "helm-browser" keeps it from taking focus
 * (niri: `window-rule { match app-id=r#"^helm-browser"# open-focused false }`).
 */
export async function launchWindow(profileDir, { name = 'helm-browser' } = {}) {
  const { chromium } = await import('playwright');
  const args = ['--no-first-run', '--no-default-browser-check', '--disk-cache-size=33554432', `--class=${name}`];
  if (process.platform === 'linux') args.push('--ozone-platform-hint=auto');
  const running = await attachWindow(chromium, profileDir);
  if (running) return running;
  const system = systemChromium();
  if (system) { try { return await startWindow(chromium, system, profileDir, args); } catch { /* Playwright's way below */ } }
  // No "controlled by automated test software" bar: it is the owner's window.
  // Chromium's own sandbox stays on, so no "--no-sandbox" warning bar either;
  // only a machine where the sandbox cannot start goes without it. A window
  // started this way closes when Helm does.
  const options = { headless: false, viewport: null, acceptDownloads: true, chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'], args, timeout: 15000 };
  const attempts = [...(system ? [{ executablePath: system }, { executablePath: system, chromiumSandbox: false }] : []), {}, { chromiumSandbox: false }];
  let failure;
  for (const extra of attempts) {
    try { return await chromium.launchPersistentContext(profileDir, { ...options, ...extra }); } catch (error) { failure = error; }
  }
  throw failure;
}

const PORT_FILE = 'DevToolsActivePort';

/** Is a live Chromium using this profile? Chromium's lock names its process. */
function profileInUse(profileDir) {
  if (process.platform === 'win32') return true;
  let target; try { target = readlinkSync(join(profileDir, 'SingletonLock')); } catch { return false; }
  const pid = Number(target.split('-').pop());
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** A window Helm started is open, maybe from before Helm restarted. */
export const windowOpen = (profileDir) => profileInUse(profileDir) && existsSync(join(profileDir, PORT_FILE));

/** Helm's end of a window it started; letting go leaves the window open. */
async function connectWindow(chromium, port, timeout) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout });
  const context = browser.contexts()[0];
  if (!context) { await browser.close().catch(() => {}); throw new Error('Chromium has no window'); }
  context.helmDetach = () => browser.close();
  return context;
}

/** The window is still open from before Helm restarted: take it back, tabs and all. */
async function attachWindow(chromium, profileDir) {
  if (!profileInUse(profileDir)) return null;
  let port; try { port = Number(readFileSync(join(profileDir, PORT_FILE), 'utf8').split('\n')[0]); } catch { return null; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try { const context = await connectWindow(chromium, port, 3000); context.helmAttached = true; return context; } catch { return null; }
}

/**
 * Chromium as its own program, not a child of Helm (on Linux in its own
 * systemd scope), so restarting Helm never closes the window. Helm talks to
 * it on a port only this machine can reach, written in the profile folder.
 */
async function startWindow(chromium, executable, profileDir, args) {
  rmSync(join(profileDir, PORT_FILE), { force: true });
  const argv = [`--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', ...args, 'about:blank'];
  const scoped = process.platform === 'linux' && !process.env.HELM_NO_SERVICE && ['/usr/bin/systemd-run', '/bin/systemd-run'].find(existsSync);
  for (const [command, list] of [...(scoped ? [[scoped, ['--user', '--scope', '--collect', '--quiet', executable, ...argv]]] : []), [executable, argv]]) {
    const child = spawn(command, list, { detached: true, stdio: 'ignore' });
    let exited = false; child.on('error', () => { exited = true; }); child.on('exit', () => { exited = true; }); child.unref();
    for (const until = Date.now() + 15000; Date.now() < until && !exited && !existsSync(join(profileDir, PORT_FILE));) await new Promise(done => setTimeout(done, 100));
    let port; try { port = Number(readFileSync(join(profileDir, PORT_FILE), 'utf8').split('\n')[0]); } catch { /* did not start */ }
    if (port) return connectWindow(chromium, port, 15000);
    if (!exited) { try { process.kill(child.pid); } catch { /* gone */ } throw new Error('Chromium did not open a window'); }
  }
  throw new Error('Chromium did not open a window');
}

/** A tab Helm opens with no address shows Chromium's New Tab page, not about:blank. */
export const NEW_TAB = 'chrome://newtab/';

export const windowProfile = (directory, sessionId) => join(directory, sessionId, 'window');
/** Each thread's window has its own app id, so Show window finds the right one. */
export const windowName = (sessionId) => `helm-browser-${String(sessionId).replace(/[^\w-]/g, '').slice(0, 40)}`;

/**
 * Give a thread's window the keyboard, when the owner asked to see it. Only
 * niri needs telling (its rule keeps these windows from taking focus by
 * themselves); elsewhere bringing the tab forward is enough.
 */
export async function focusWindow(name, { env = process.env, run = promisify(execFile) } = {}) {
  if (!/niri/i.test(env.XDG_CURRENT_DESKTOP || '') && !env.NIRI_SOCKET) return false;
  try {
    const { stdout } = await run('niri', ['msg', '-j', 'windows'], { timeout: 3000 });
    const window = JSON.parse(stdout).find(w => w.app_id === name);
    if (!window) return false;
    await run('niri', ['msg', 'action', 'focus-window', '--id', String(window.id)], { timeout: 3000 });
    return true;
  } catch { return false; }
}

/**
 * Runs in every page of a window: tells Helm when the owner clicks, types or
 * scrolls, at most a few times a second, and draws the agent's cursor.
 * Agent input arrives the same way, so Helm ignores reports made while one
 * of the agent's actions is running.
 */
export const WINDOW_PAGE_SCRIPT = `(() => {
  if (window.__helmWindow) return; window.__helmWindow = true;
  let last = 0;
  const said = () => { const now = Date.now(); if (now - last < 250) return; last = now; try { window.__helmOwnerInput?.(); } catch {} };
  for (const kind of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(kind, said, { capture: true, passive: true });
})();`;

/**
 * The agent's cursor and what it is doing, drawn over the page; never catches
 * a click. The arrow stays where the agent last acted; its label and outline
 * fade. Strict pages (LinkedIn) filter HTML strings and inline <style>, so the
 * parts are built one by one and styled with a built stylesheet.
 */
export function drawPointer({ x, y, label, note, guide, box }) {
  const id = '__helm_pointer';
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement('div'); host.id = id;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const css = `
      .c{position:fixed;width:30px;height:30px;transform:translate(-4px,-3px);transition:left .18s ease,top .18s ease,opacity .3s;filter:drop-shadow(0 1px 2px rgb(0 0 0/.45))}
      .l{position:fixed;transform:translate(24px,22px);max-width:300px;padding:4px 10px;border-radius:999px;background:#6d5efc;color:#fff;font:500 13px/1.4 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:left .18s ease,top .18s ease,opacity .3s}
      .l.g{white-space:normal;border-radius:10px;background:#f5a524;color:#1a1300}
      .b{position:fixed;border:2px solid #6d5efc;border-radius:6px;transition:all .18s ease,opacity .3s}
      .b.g{border-color:#f5a524;box-shadow:0 0 0 4px rgb(245 165 36/.25)}
      .h{opacity:0}`;
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; }
    catch { const style = document.createElement('style'); style.textContent = css; root.append(style); }
    const svgNs = 'http://www.w3.org/2000/svg';
    const frame = document.createElement('div'); frame.className = 'b h';
    const arrow = document.createElementNS(svgNs, 'svg'); arrow.setAttribute('class', 'c h'); arrow.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(svgNs, 'path');
    for (const [name, value] of [['d', 'M4 2l15 9-7 1.5L8.5 20z'], ['fill', '#6d5efc'], ['stroke', '#fff'], ['stroke-width', '1.6'], ['stroke-linejoin', 'round']]) path.setAttribute(name, value);
    arrow.append(path);
    const words = document.createElement('div'); words.className = 'l h';
    root.append(frame, arrow, words);
    document.documentElement.appendChild(host);
  }
  const root = host.shadowRoot, cursor = root.querySelector('.c'), tag = root.querySelector('.l'), frame = root.querySelector('.b');
  cursor.style.left = tag.style.left = `${x}px`; cursor.style.top = tag.style.top = `${y}px`;
  const words = [label, note].filter(Boolean).join(' · ');
  tag.textContent = words; tag.classList.toggle('g', !!guide);
  frame.classList.toggle('g', !!guide);
  if (box) Object.assign(frame.style, { left: `${box.x - 3}px`, top: `${box.y - 3}px`, width: `${box.width + 6}px`, height: `${box.height + 6}px` });
  for (const el of [cursor, tag]) el.classList.remove('h');
  tag.classList.toggle('h', !words); frame.classList.toggle('h', !box);
  clearTimeout(window.__helmPointerTimer);
  window.__helmPointerTimer = setTimeout(() => { for (const el of [tag, frame]) el.classList.add('h'); }, guide ? 60000 : 2500);
}

export function clearPointer() { const host = document.getElementById('__helm_pointer'); if (host) for (const el of host.shadowRoot.querySelectorAll('.c,.l,.b')) el.classList.add('h'); }
