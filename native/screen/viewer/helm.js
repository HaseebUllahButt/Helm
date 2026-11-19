// Helm's additions to the screen-relay viewer. viewer.js stays as screen-relay
// ships it; this file only uses what it exports (window.relayViewer).
//
// - The owner opens a screen to use it, so the window takes control at once.
// - Full keyboard: fullscreen plus the browser's keyboard lock, so Super, Alt+Tab
//   and the browser's own keys reach the other machine. On Wayland the browser
//   asks the desktop to let shortcuts through (niri, sway and Hyprland allow it).
// - Super+Ctrl+Esc gives the keys back. niri reserves that key itself on the
//   owner's machines, so it works even when the page never sees it.
(() => {
  const params = new URLSearchParams(location.search);
  const name = params.get('name') || 'Remote';
  document.title = `${name} screen`;
  const canvas = document.getElementById('screen');
  const actions = document.getElementById('toolbar-actions');
  const viewer = window.relayViewer;
  if (viewer && params.get('view') !== '1') viewer.setViewOnly(false);

  const hint = document.createElement('div');
  hint.id = 'helm-hint';
  hint.setAttribute('role', 'status');
  hint.hidden = true;
  document.body.append(hint);
  let hintTimer = 0;
  const say = (text, ms = 4000) => {
    hint.textContent = text;
    hint.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.hidden = true; }, ms);
  };

  const lockable = !!navigator.keyboard?.lock;
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.helm = 'keyboard';
  button.setAttribute('aria-pressed', 'false');
  const label = `Full keyboard: send all keys to ${name}`;
  button.setAttribute('aria-label', label);
  button.title = lockable ? label : 'This browser cannot send all keys. Use Chrome, Edge or Brave.';
  button.innerHTML = '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h12M6 14h12"/></svg>';
  actions?.querySelector('[data-action="fullscreen"]')?.after(button);

  let locked = false;
  const show = () => button.setAttribute('aria-pressed', String(locked));

  async function fullKeyboard(on) {
    if (on) {
      if (!lockable) { say('This browser cannot send all keys. Use Chrome, Edge or Brave.'); return; }
      try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
        await navigator.keyboard.lock();
        locked = true;
        say(`All keys go to ${name}. Press Super+Ctrl+Esc to get them back.`);
      } catch {
        say('The browser did not allow full keyboard. Click the screen, then try again.');
      }
    } else {
      navigator.keyboard?.unlock?.();
      locked = false;
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      say('Your keys work on this computer again.', 2500);
    }
    show();
    canvas?.focus();
  }

  button.addEventListener('click', () => { void fullKeyboard(!locked); });
  // Capture phase on window: before the viewer sends the key to the machine.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || !e.ctrlKey || !e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (locked || document.fullscreenElement) void fullKeyboard(false);
  }, true);
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement || !locked) return;
    // Left fullscreen another way (a long Esc press): the lock ends with it.
    navigator.keyboard?.unlock?.();
    locked = false;
    show();
  });
  canvas?.focus();
})();
