// A thread's browser tabs in a real Chromium window on this machine's screen,
// beside Helm, instead of pictures in the panel. The agent still drives the
// tabs through Chromium's own channel, so it never moves the owner's mouse
// or types on their keyboard; the owner just uses the window.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
 * One Chromium per windowed thread, with its own profile folder, so its tabs
 * are tabs in one window and its sign-ins outlive the window. `place` is
 * where the owner's Helm window has room beside it, when it said.
 */
export async function launchWindow(profileDir, { place } = {}) {
  const { chromium } = await import('playwright');
  const args = ['--no-first-run', '--no-default-browser-check', '--disk-cache-size=33554432'];
  if (process.platform === 'linux') args.push('--ozone-platform-hint=auto');
  if (place) args.push(`--window-position=${place.x},${place.y}`, `--window-size=${place.width},${place.height}`);
  // No "controlled by automated test software" bar: it is the owner's window.
  const options = { headless: false, viewport: null, acceptDownloads: true, ignoreDefaultArgs: ['--enable-automation'], args, timeout: 15000 };
  const system = systemChromium();
  if (system) { try { return await chromium.launchPersistentContext(profileDir, { ...options, executablePath: system }); } catch { /* try Playwright's own build */ } }
  return chromium.launchPersistentContext(profileDir, options);
}

export const windowProfile = (directory, sessionId) => join(directory, sessionId, 'window');

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

/** The agent's cursor and what it is doing, drawn over the page; never catches a click. */
export function drawPointer({ x, y, label, note, guide, box }) {
  const id = '__helm_pointer';
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement('div'); host.id = id;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .c{position:fixed;width:22px;height:22px;transform:translate(-3px,-2px);transition:left .18s ease,top .18s ease,opacity .3s;filter:drop-shadow(0 1px 2px rgb(0 0 0/.45))}
      .l{position:fixed;transform:translate(18px,16px);max-width:280px;padding:4px 9px;border-radius:999px;background:#6d5efc;color:#fff;font:500 12px/1.4 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:left .18s ease,top .18s ease,opacity .3s}
      .l.g{white-space:normal;border-radius:10px;background:#f5a524;color:#1a1300}
      .b{position:fixed;border:2px solid #6d5efc;border-radius:6px;transition:all .18s ease,opacity .3s}
      .b.g{border-color:#f5a524;box-shadow:0 0 0 4px rgb(245 165 36/.25)}
      .h{opacity:0}
    </style><div class="b h"></div><svg class="c h" viewBox="0 0 24 24"><path d="M4 2l15 9-7 1.5L8.5 20z" fill="#6d5efc" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><div class="l h"></div>`;
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
  window.__helmPointerTimer = setTimeout(() => { for (const el of [cursor, tag, frame]) el.classList.add('h'); }, guide ? 60000 : 2500);
}

export function clearPointer() { const host = document.getElementById('__helm_pointer'); if (host) for (const el of host.shadowRoot.querySelectorAll('.c,.l,.b')) el.classList.add('h'); }
