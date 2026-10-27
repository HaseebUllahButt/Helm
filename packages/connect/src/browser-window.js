// A thread's browser tabs in a real Chromium window on this machine's screen,
// beside Helm. The agent drives the tabs through Chromium's own channel, so
// it never moves the owner's mouse or types on their keyboard; the owner
// just uses the window.
import { existsSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { browserArgs, ignoredBrowserArgs } from './browser-identity.js';

/** A screen to open a window on: always on a Mac or Windows, a display on Linux. */
export const canOpenWindow = (env = process.env, platform = process.platform) =>
  platform === 'darwin' || platform === 'win32' || !!(env.WAYLAND_DISPLAY || env.DISPLAY);

// The owner's own Chromium looks and feels like their browser; Playwright's
// build is the fallback when none is installed or it will not start.
export const systemChromium = () => [
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
  const { chromium } = await import('patchright-core');
  // No component downloads: each chat's profile would fetch its own ~150 MB
  // of speech, DRM and model files, and starting is slower while it does.
  const args = [...browserArgs, '--no-first-run', '--no-default-browser-check', '--disk-cache-size=33554432', '--disable-component-update', `--class=${name}`];
  if (process.platform === 'linux') args.push('--ozone-platform-hint=auto');
  const running = await attachWindow(chromium, profileDir);
  if (running) return running;
  const system = process.env.HELM_WINDOW_CHROMIUM || systemChromium();
  if (system) { try { return await startWindow(chromium, system, profileDir, args); } catch { /* Playwright's way below */ } }
  // No "controlled by automated test software" bar: it is the owner's window.
  // Chromium's own sandbox stays on, so no "--no-sandbox" warning bar either;
  // only a machine where the sandbox cannot start goes without it. A window
  // started this way closes when Helm does.
  const options = { headless: false, viewport: null, acceptDownloads: true, chromiumSandbox: true, ignoreDefaultArgs: ignoredBrowserArgs, args, timeout: 15000 };
  const attempts = [...(system ? [{ executablePath: system }, { executablePath: system, chromiumSandbox: false }] : []), {}, { chromiumSandbox: false }];
  let failure;
  for (const extra of attempts) {
    try { const context = await chromium.launchPersistentContext(profileDir, { ...options, ...extra }); context.helmPatched = true; return context; } catch (error) { failure = error; }
  }
  throw failure;
}

const PORT_FILE = 'DevToolsActivePort';

/**
 * The live Chromium using this profile, if any. Chromium's lock names its
 * host and process. A lock left by a crash can name a process number that
 * another program has since been given, so the process must be Chromium
 * started on this profile.
 */
export function profilePid(profileDir) {
  let target; try { target = readlinkSync(join(profileDir, 'SingletonLock')); } catch { return null; }
  const cut = target.lastIndexOf('-'), pid = Number(target.slice(cut + 1));
  if (cut < 1 || target.slice(0, cut) !== hostname() || !Number.isInteger(pid) || pid < 1) return null;
  return runsProfile(pid, profileDir) ? pid : null;
}

// Chromium rewrites its command line as one string, so look for the flag
// followed by a space or the end.
function runsProfile(pid, profileDir) {
  let command;
  try {
    command = process.platform === 'linux' ? readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
      : execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
  } catch { return false; }
  command = `${command.trimEnd()} `;
  return [profileDir, resolve(profileDir)].some(dir => command.includes(`--user-data-dir=${dir} `));
}
const profileInUse = (profileDir) => process.platform === 'win32' || !!profilePid(profileDir);

/** Close a window Helm started for a chat that is gone, and wait for it to exit. */
export async function stopWindow(profileDir) {
  const pid = process.platform === 'win32' ? null : profilePid(profileDir);
  if (!pid) return false;
  try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  for (const until = Date.now() + 5000; Date.now() < until && profilePid(profileDir);) await new Promise(done => setTimeout(done, 100));
  return true;
}

// Remove component downloads and graphics files. Keep cached site files and
// compiled scripts, so reopening a chat does not fetch and compile them again.
const REFETCHED = ['component_crx_cache', 'WasmTtsEngine', 'WidevineCdm', 'OnDeviceHeadSuggestModel', 'OptimizationHints', 'ActorSafetyLists',
  'hyphen-data', 'ZxcvbnData', 'GPUPersistentCache', 'GrShaderCache', 'ShaderCache', 'BrowserMetrics', 'BrowserMetrics-spare.pma',
  'Default/GPUCache', 'Default/DawnGraphiteCache', 'Default/DawnWebGPUCache'];

/** Free a closed window's disk space. A window that is open is left alone. */
export async function trimProfile(profileDir) {
  if (!existsSync(profileDir) || profileInUse(profileDir)) return false;
  await Promise.all(REFETCHED.map(name => rm(join(profileDir, name), { recursive: true, force: true }).catch(() => {})));
  return true;
}

/** A window Helm started is open, maybe from before Helm restarted. */
export const windowOpen = (profileDir) => profileInUse(profileDir) && existsSync(join(profileDir, PORT_FILE));

/** Helm's end of a window it started; letting go leaves the window open. */
async function connectWindow(chromium, port, timeout) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout });
  const context = browser.contexts()[0];
  if (!context) { await browser.close().catch(() => {}); throw new Error('Chromium has no window'); }
  context.helmDetach = () => browser.close();
  context.helmPatched = true;
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
  // Open the first window at the requested page, after its logins and input
  // hooks are ready. An unused New Tab page also makes the driver set up a
  // second page before it can start the one the owner asked for.
  const argv = [`--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-startup-window', ...args];
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
/** Each chat's window has its own app id for desktop window rules. */
export const windowName = (sessionId) => `helm-browser-${String(sessionId).replace(/[^\w-]/g, '').slice(0, 40)}`;

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
