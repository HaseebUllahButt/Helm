/**
 * Keys that make an installed app behave like a browser tab.
 *
 * In the installed app's own window Chrome hands these to the page first, so
 * swallowing them stops Ctrl+N opening a second Helm window, Ctrl+P printing
 * the page, Ctrl+S saving it as HTML and so on. In an ordinary browser tab
 * Chrome keeps Ctrl+N/T/W for itself and never asks; nothing here can change
 * that. F1 is here because it opens the browser's help in a new window.
 * Ctrl+N is not dead: the app's own handler turns it into "new chat".
 *
 * Left alone on purpose: copy/paste/undo, Ctrl+F and F3 (finding text in a
 * long chat is useful), Ctrl+R (the way out of a stuck screen), zoom, Ctrl+W/Q
 * (closing an app window is what apps do), and devtools.
 */
const CTRL_KEYS = new Set(['n', 't', 'p', 's', 'o', 'u', 'h', 'j', 'd', 'l', 'e']);
const CTRL_SHIFT_KEYS = new Set(['n', 't', 'b', 'd', 'o', 'delete', 'a']);

export function isBrowserKey(e: KeyboardEvent): boolean {
  if (e.altKey && e.key === 'Home') return true;
  if (e.key === 'F1' || e.key === 'F7') return true;
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
  // A link in a chat would load the page in Helm's own window and Helm would
  // be gone. Links to the web open in the browser instead; links that only
  // point back at this address (an agent's `src/app.ts`) go nowhere, since
  // what they would show is a second Helm. Ctrl/Shift/middle clicks and links
  // that name their own target already open somewhere else and are left alone.
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, win.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    e.preventDefault();
    if (url.origin !== win.location.origin) win.open(url.href, '_blank', 'noopener,noreferrer');
  };
  // A file dropped anywhere but the message box is opened by the browser in
  // place of Helm. The message box takes its own drops before this sees them;
  // text dragged into a text field still lands there.
  const editable = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, [contenteditable="true"], .xterm');
  const onDrag = (e: DragEvent) => {
    if (e.defaultPrevented) return;
    const files = Array.from(e.dataTransfer?.types ?? []).includes('Files');
    if (!files && editable(e.target)) return;
    e.preventDefault();
    if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('contextmenu', onMenu);
  win.addEventListener('click', onClick);
  win.addEventListener('dragover', onDrag);
  win.addEventListener('drop', onDrag);
  return () => {
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('contextmenu', onMenu);
    win.removeEventListener('click', onClick);
    win.removeEventListener('dragover', onDrag);
    win.removeEventListener('drop', onDrag);
  };
}
