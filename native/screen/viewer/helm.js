// Helm's additions to the screen-relay viewer. viewer.js stays as screen-relay
// ships it; this file only uses what it exports (window.relayViewer).
//
// The window works like a virtual machine's window, because the owner's
// desktop runs on shortcuts:
// - It opens with control on: keys and the mouse go to the other machine at
//   once. No card to click first.
// - Super keys and the browser's own keys (Ctrl+W, Ctrl+T) need fullscreen
//   plus the browser's keyboard lock. On Wayland the lock asks the desktop
//   to let shortcuts through (niri, sway and Hyprland allow it). The window
//   tries at once; a browser that wants a click first gets it from the
//   first click or key press, and that click is not sent on.
// - Super+Ctrl+Esc gives the keys back. niri keeps that key for itself on
//   the owner's machines, so the page never sees it there: niri just stops
//   letting shortcuts through. When the owner comes back to the window, the
//   page locks the keyboard again, so niri lets shortcuts through again.
// - Where the page sees Super+Ctrl+Esc, or the owner leaves fullscreen, the
//   window stays in control but keeps Super keys here. A bar offers to send
//   all keys again.
// screen-relay's own toolbar stays for scaling, screenshots and Release control.
(() => {
  const params = new URLSearchParams(location.search);
  const name = params.get('name') || 'Remote';
  document.title = `${name} screen`;
  const canvas = document.getElementById('screen');
  const viewer = window.relayViewer;
  const lockable = !!navigator.keyboard?.lock;
  const controlButton = document.querySelector('[data-action="control"]');

  const el = (tag, attrs = {}, text = '') => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text) node.textContent = text;
    return node;
  };

  // The bar while Super keys stay on this computer.
  const bar = el('div', { id: 'helm-bar', role: 'status' });
  const barText = el('span');
  const again = el('button', { type: 'button', class: 'helm-primary' }, 'Send all keys');
  bar.append(barText, again);
  bar.hidden = true;

  const hint = el('div', { id: 'helm-hint', role: 'status' });
  hint.hidden = true;
  document.body.append(bar, hint);
  let hintTimer = 0;
  const say = (text, ms = 3500) => {
    hint.textContent = text;
    hint.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.hidden = true; }, ms);
  };
  const showBar = (text) => { barText.textContent = text; bar.hidden = false; };

  // wanted: the owner wants all keys there. locked: the browser holds them.
  let wanted = lockable;
  let locked = false;
  let grabbing = false;
  let swallowUp = -1;

  // gesture: a click or key asked for it. If even that fails, stop asking,
  // so later clicks reach the screen.
  async function grab({ quiet = false, gesture = false } = {}) {
    if (!lockable || grabbing) return false;
    grabbing = true;
    // "Send all keys" after the toolbar's Release control: control comes back too.
    if (controlButton?.getAttribute('aria-pressed') === 'false') viewer?.setViewOnly(false);
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      await navigator.keyboard.lock();
      locked = true;
      wanted = true;
      bar.hidden = true;
      canvas?.focus();
      if (!quiet) say(`All keys go to ${name}. Super+Ctrl+Esc gives them back.`);
      return true;
    } catch {
      if (gesture || document.fullscreenElement) {
        wanted = false;
        showBar(`The browser keeps Super keys. Other keys go to ${name}.`);
      }
      return false;
    } finally { grabbing = false; }
  }

  async function giveBack(text) {
    navigator.keyboard?.unlock?.();
    locked = false;
    wanted = false;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    showBar(text);
    canvas?.focus();
  }

  viewer?.setViewOnly(false);
  if (!lockable) say(`Your keys go to ${name}. This browser keeps Super keys; Chrome, Edge or Brave send them too.`, 6000);
  canvas?.focus();
  // Some browsers allow fullscreen with no click. Others wait for the first one.
  if (wanted) void grab();

  again.addEventListener('click', () => { void grab({ gesture: true }); });

  // Capture phase on window: these run before the viewer sends anything on.
  window.addEventListener('pointerdown', (e) => {
    if (!wanted || locked || document.fullscreenElement || e.target !== canvas) return;
    // This click only fills the screen; the layout changes under it, so it
    // would land somewhere else on the other machine.
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowUp = e.pointerId;
    void grab({ gesture: true });
  }, true);
  window.addEventListener('pointerup', (e) => {
    if (e.pointerId !== swallowUp) return;
    swallowUp = -1;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  const typing = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const keys = (e) => {
    if (e.code === 'Escape' && e.ctrlKey && e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keydown' && lockable && bar.hidden) void giveBack(`Super keys work here again. Other keys still go to ${name}.`);
      return;
    }
    if (e.type === 'keydown' && wanted && !locked && !document.fullscreenElement) void grab({ gesture: true });
    // A key pressed while a toolbar button has focus still goes to the
    // screen; Enter, Space, Tab and Esc stay with the button.
    const local = typing(e.target) || e.target?.closest?.('#helm-bar')
      || (e.target instanceof HTMLButtonElement && /^(Enter|NumpadEnter|Space|Tab|Escape)$/.test(e.code));
    if (e.target !== canvas && canvas && !local) {
      e.preventDefault();
      e.stopImmediatePropagation();
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent(e.type, {
        key: e.key, code: e.code, location: e.location, repeat: e.repeat,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        bubbles: true, cancelable: true,
      }));
    }
  };
  window.addEventListener('keydown', keys, true);
  window.addEventListener('keyup', keys, true);

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) return;
    if (locked || wanted) {
      // The owner left fullscreen (a long Esc press): the lock ends with it.
      navigator.keyboard?.unlock?.();
      locked = false;
      wanted = false;
      showBar(`Super keys work here again. Other keys still go to ${name}.`);
    }
  });
  // The owner went to another window. niri's Super+Ctrl+Esc turned off the
  // lock without telling the page, so take it again on the way back: a new
  // lock lets shortcuts through again.
  window.addEventListener('blur', () => {
    if (!locked) return;
    navigator.keyboard?.unlock?.();
    locked = false;
  });
  // The toolbar's Release control: the keys must come back here too, or the
  // lock keeps shortcuts that the viewer then drops.
  if (controlButton) new MutationObserver(() => {
    if (controlButton.getAttribute('aria-pressed') !== 'false' || !(locked || wanted)) return;
    void giveBack(`You only watch ${name}. Your keys work here.`);
  }).observe(controlButton, { attributes: true, attributeFilter: ['aria-pressed'] });
  window.addEventListener('focus', () => {
    canvas?.focus();
    if (wanted && !locked && document.fullscreenElement) void grab({ quiet: true });
  });
})();
