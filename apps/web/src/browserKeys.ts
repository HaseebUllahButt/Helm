/**
 * Keys that make an installed app behave like a browser tab.
 *
 * In the installed app's own window Chrome hands these to the page first, so
 * swallowing them stops Ctrl+N opening a second Helm window, Ctrl+P printing
 * the page, Ctrl+S saving it as HTML and so on. In an ordinary browser tab
 * Chrome keeps Ctrl+N/T/W for itself and never asks; nothing here can change
 * that. Ctrl+N is not dead: the app's own handler turns it into "new chat".
 *
 * Left alone on purpose: copy/paste/undo, Ctrl+F and F3 (finding text in a
 * long chat is useful), Ctrl+R (the way out of a stuck screen), zoom, Ctrl+W/Q
 * (closing an app window is what apps do), and devtools.
 */
const CTRL_KEYS = new Set(['n', 't', 'p', 's', 'o', 'u', 'h', 'j', 'd', 'l', 'e']);
const CTRL_SHIFT_KEYS = new Set(['n', 't', 'b', 'd', 'o', 'delete', 'a']);

export function isBrowserKey(e: KeyboardEvent): boolean {
  if (e.altKey && e.key === 'Home') return true;
  if (e.key === 'F7') return true;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey) return false;
  const key = e.key.toLowerCase();
  return e.shiftKey ? CTRL_SHIFT_KEYS.has(key) : CTRL_KEYS.has(key);
}

/**
 * A terminal owns every Ctrl key (Ctrl+D ends input, Ctrl+U clears the line).
 * xterm cancels the browser's default for the keys it handles, so leaving
 * them alone here loses nothing.
 */
const ownsKey = (target: EventTarget | null) => !!(target as HTMLElement | null)?.closest?.('.xterm');

export function blockBrowserKeys(win: Window = window) {
  const onKey = (e: KeyboardEvent) => {
    if (!isBrowserKey(e) || ownsKey(e.target)) return;
    // preventDefault only: the app's own handlers still see the key, which
    // is how Ctrl+N becomes "new chat".
    e.preventDefault();
  };
  // Right-click on the app's own buttons and bars brings up Back, Reload,
  // Save as and Print - a browser's menu, not an app's. The conversation,
  // links, images, inputs, the terminal and any selection keep it.
  const onMenu = (e: MouseEvent) => {
    const el = e.target as HTMLElement | null;
    if (win.getSelection()?.toString()) return;
    if (el?.closest?.('input, textarea, [contenteditable="true"], a[href], img, pre, code, .xterm, .timeline')) return;
    e.preventDefault();
  };
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('contextmenu', onMenu);
  return () => {
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('contextmenu', onMenu);
  };
}
