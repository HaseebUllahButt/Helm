/**
 * How this device looks: theme, diff colours, chat width, list density.
 *
 * Per device rather than per network, because the reasons are per device - a
 * phone read outdoors wants light, the laptop at night does not - so it lives
 * in localStorage and is applied to <html> as attributes the stylesheet keys
 * on. `system` follows the OS and keeps following it.
 */

export type Theme = 'system' | 'dark' | 'light';
export interface Appearance {
  theme: Theme;
  /** `blue` swaps the green/red of a diff for blue/orange, for red-green colour blindness. */
  diff: 'green' | 'blue';
  width: 'comfortable' | 'wide';
  density: 'comfortable' | 'compact';
}

const KEY = 'helm.appearance';
export const DEFAULTS: Appearance = { theme: 'system', diff: 'green', width: 'comfortable', density: 'comfortable' };

export function loadAppearance(): Appearance {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      theme: ['system', 'dark', 'light'].includes(v.theme) ? v.theme : DEFAULTS.theme,
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
  root.dataset.diff = a.diff;
  root.dataset.width = a.width;
  root.dataset.density = a.density;
  // The browser bar and the installed app's status area take the page's colour.
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f6f6f4' : '#0a0a0b');
}

export function saveAppearance(a: Appearance) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* storage denied: it applies for this visit */ }
  applyAppearance(a);
}

/** Follow the OS while the choice is `system`. Called once at start. */
export function watchSystemTheme() {
  dark.addEventListener('change', () => { if (loadAppearance().theme === 'system') applyAppearance(); });
}
