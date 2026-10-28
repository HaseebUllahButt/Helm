/**
 * The Helm window on a Linux desktop (`helm app`) opens bare: no title bar and
 * none of Chromium's buttons. Close is the one button the owner keeps, so Helm
 * draws it in the window's top right corner and the top rows leave room for it.
 *
 * A phone's installed app is standalone too but closes from the phone itself,
 * and a window-controls-overlay window still has Chromium's own close button.
 */
export function isAppWindow(): boolean {
  if (!window.matchMedia?.('(display-mode: standalone)').matches) return false;
  if (window.matchMedia('(display-mode: window-controls-overlay)').matches) return false;
  const ua = navigator.userAgent;
  return /Linux/.test(ua) && !/Android/.test(ua);
}

export function addWindowClose(): void {
  if (!isAppWindow()) return;
  document.documentElement.classList.add('app-window');
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
  document.body.append(button);
}
