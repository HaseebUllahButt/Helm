/**
 * The Helm window on a desktop (`helm app`) is a plain app window with the
 * system title bar. A desktop that draws title bars gives it its own Close
 * button. A tiling desktop that draws none (niri, Hyprland, sway) leaves it
 * bare, so Helm draws Close in the window's top right corner and the top rows
 * leave room for it.
 *
 * A phone's installed app is standalone too but closes from the phone itself,
 * and a window-controls-overlay window still has Chromium's own close button.
 */
function isAppWindow(): boolean {
  if (!window.matchMedia?.('(display-mode: standalone)').matches) return false;
  if (window.matchMedia('(display-mode: window-controls-overlay)').matches) return false;
  return !/Android|iPhone|iPad/.test(navigator.userAgent) && window.matchMedia('(pointer: fine)').matches;
}

/**
 * True when the window has no title bar. The outer size counts the frame in
 * screen pixels and the inner size is in page pixels, so the page zoom (the
 * width ratio: a bare window has no side frame) is taken out first.
 */
export function hasNoFrame(outer: { w: number; h: number }, inner: { w: number; h: number }): boolean {
  if (!outer.w || !inner.w) return false;
  const zoom = outer.w / inner.w;
  return outer.h - inner.h * zoom < 4;
}

export function addWindowClose(): void {
  if (!isAppWindow()) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'iconbtn window-close';
  button.title = 'Close window';
  button.setAttribute('aria-label', 'Close window');
  button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  // A page may close a window it did not open only while the window has one
  // history entry, and each screen Helm opens adds one. When the window is
  // still here, Helm on this machine closes it (app-window.js in the relay).
  button.addEventListener('click', () => {
    window.close();
    setTimeout(() => { void fetch('/api/window/close', { method: 'POST' }).catch(() => {}); }, 300);
  });
  // The frame can come and go (full screen, a desktop setting), so check on
  // each resize.
  const place = () => {
    const bare = hasNoFrame({ w: window.outerWidth, h: window.outerHeight }, { w: window.innerWidth, h: window.innerHeight });
    document.documentElement.classList.toggle('app-window', bare);
    if (bare && !button.isConnected) document.body.append(button);
    if (!bare) button.remove();
  };
  window.addEventListener('resize', place);
  place();
}
