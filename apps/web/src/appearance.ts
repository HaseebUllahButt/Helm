import { useSyncExternalStore } from 'react';

/**
 * How this device looks: look, theme, diff colours, chat width, list density.
 *
 * Per device rather than per network, because the reasons are per device - a
 * phone read outdoors wants light, the laptop at night does not - so it lives
 * in localStorage and is applied to <html> as attributes the stylesheet keys
 * on. `system` follows the OS and keeps following it.
 */

export type Theme = 'system' | 'dark' | 'light' | 'tokyo';
/** `new` is the tiled look (mono details, an edge on the open panel, bigger
 *  phone text); `classic` is the look from before it. Same layout in both. */
export type Look = 'classic' | 'new';
export interface Appearance {
  look: Look;
  theme: Theme;
  /** `blue` swaps the green/red of a diff for blue/orange, for red-green colour blindness. */
  diff: 'green' | 'blue';
  width: 'comfortable' | 'wide';
  density: 'comfortable' | 'compact';
}

const KEY = 'helm.appearance';

/** The look in force now, for code that draws differently per look (icons,
 *  the settings list). Kept here so a change reaches every icon at once. */
let currentLook: Look = 'classic';
const lookListeners = new Set<() => void>();
const subscribeLook = (f: () => void) => { lookListeners.add(f); return () => { lookListeners.delete(f); }; };
export const useLook = (): Look => useSyncExternalStore(subscribeLook, () => currentLook);
export const DEFAULTS: Appearance = { look: 'classic', theme: 'system', diff: 'green', width: 'comfortable', density: 'comfortable' };

export function loadAppearance(): Appearance {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    // Navy was dropped on 2026-11-24; Tokyo Night is the nearest dark blue.
    const theme = v.theme === 'navy' ? 'tokyo' : v.theme;
    return {
      look: v.look === 'new' ? 'new' : 'classic',
      theme: ['system', 'dark', 'light', 'tokyo'].includes(theme) ? theme : DEFAULTS.theme,
      diff: v.diff === 'blue' ? 'blue' : 'green',
      width: v.width === 'wide' ? 'wide' : 'comfortable',
      density: v.density === 'compact' ? 'compact' : 'comfortable',
    };
  } catch { return DEFAULTS; }
}

const dark = matchMedia('(prefers-color-scheme: dark)');
/** What `system` means right now. */
const resolved = (t: Theme) => (t === 'system' ? (dark.matches ? 'dark' : 'light') : t);

export function applyAppearance(a: Appearance = loadAppearance()) {
  const root = document.documentElement;
  const theme = resolved(a.theme);
  root.dataset.theme = theme;
  root.dataset.look = a.look;
  if (a.look !== currentLook) { currentLook = a.look; lookListeners.forEach((f) => f()); }
  root.dataset.diff = a.diff;
  root.dataset.width = a.width;
  root.dataset.density = a.density;
  // The browser bar and the installed app's status area take the page's colour.
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f3f4f7' : theme === 'tokyo' ? '#16161e' : '#0a0a0a');
}

export function saveAppearance(a: Appearance) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* storage denied: it applies for this visit */ }
  applyAppearance(a);
}

/** Follow the OS while the choice is `system`. Called once at start. */
export function watchSystemTheme() {
  dark.addEventListener('change', () => { if (loadAppearance().theme === 'system') applyAppearance(); });
}
