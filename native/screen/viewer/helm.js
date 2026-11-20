// Helm's additions to the screen-relay viewer. viewer.js stays as screen-relay
// ships it; this file only uses what it exports (window.relayViewer).
//
// One clear way in and one way out, because the owner's desktop runs on
// shortcuts:
// - A card on open: "Take over" goes fullscreen and locks the keyboard, so
//   Super, Alt+Tab and the browser's own keys reach the other machine. On
//   Wayland the browser asks the desktop to let shortcuts through (niri, sway
//   and Hyprland allow it). "Only watch" sends nothing.
// - Super+Ctrl+Esc gives the keys back. niri reserves that key itself on the
//   owner's machines, so it works even when the page never sees it; leaving
//   fullscreen does the same. A bar then offers "Take over again".
// screen-relay's own toolbar stays for scaling and screenshots.
(() => {
  const params = new URLSearchParams(location.search);
  const name = params.get('name') || 'Remote';
  document.title = `${name} screen`;
  const canvas = document.getElementById('screen');
  const viewer = window.relayViewer;
  const lockable = !!navigator.keyboard?.lock;

  const el = (tag, attrs = {}, text = '') => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text) node.textContent = text;
    return node;
  };

  // The card on open, and again from the bar.
  const card = el('div', { id: 'helm-card', role: 'dialog', 'aria-label': `Use ${name}` });
  card.append(
    el('div', { class: 'helm-title' }, name),
    el('p', {}, lockable
      ? `Take over: all your keys and the mouse go to ${name}, Super shortcuts too. The window fills the screen.`
      : `Take over: your keys and the mouse go to ${name}. This browser keeps Super shortcuts; use Chrome, Edge or Brave for them.`),
  );
  const take = el('button', { type: 'button', class: 'helm-primary' }, 'Take over');
  const watch = el('button', { type: 'button', class: 'helm-ghost' }, 'Only watch');
  const actions = el('div', { class: 'helm-actions' });
  actions.append(watch, take);
  card.append(actions, el('p', { class: 'helm-quiet' }, 'To get your keys back, press Super+Ctrl+Esc.'));

  // The bar while the keys are back on this computer.
  const bar = el('div', { id: 'helm-bar', role: 'status' });
  const barText = el('span');
  const again = el('button', { type: 'button', class: 'helm-primary' }, 'Take over again');
  bar.append(barText, again);
  bar.hidden = true;

  const hint = el('div', { id: 'helm-hint', role: 'status' });
  hint.hidden = true;
  document.body.append(card, bar, hint);
  let hintTimer = 0;
  const say = (text, ms = 3500) => {
    hint.textContent = text;
    hint.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.hidden = true; }, ms);
  };

  let locked = false;
  const showBar = (text) => { barText.textContent = text; bar.hidden = false; };

  async function takeOver() {
    card.hidden = true;
    bar.hidden = true;
    viewer?.setViewOnly(false);
    if (lockable) {
      try {
        if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
        await navigator.keyboard.lock();
        locked = true;
        say(`All keys go to ${name}. Super+Ctrl+Esc gives them back.`);
      } catch {
        say(`Your keys go to ${name}. The browser kept Super shortcuts.`);
      }
    } else say(`Your keys go to ${name}.`);
    canvas?.focus();
  }

  async function giveBack(text = `Your keys work here again. You only watch ${name} now.`) {
    navigator.keyboard?.unlock?.();
    locked = false;
    // Nothing goes there until Take over again, not even a click by mistake.
    viewer?.setViewOnly(true);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    showBar(text);
  }

  take.addEventListener('click', () => { void takeOver(); });
  again.addEventListener('click', () => { void takeOver(); });
  watch.addEventListener('click', () => {
    card.hidden = true;
    viewer?.setViewOnly(true);
    showBar(`You only watch ${name}. Nothing you press goes there.`);
  });
  // Capture phase on window: before the viewer sends the key on.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape' || !e.ctrlKey || !e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (bar.hidden && card.hidden) void giveBack();
  }, true);
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement || !locked) return;
    // Left fullscreen another way (a long Esc press): the lock ends with it.
    void giveBack();
  });
  // The owner went to another window (niri's own Super+Ctrl+Esc, then a
  // workspace key): the keys are theirs again, so say so.
  window.addEventListener('blur', () => { if (locked) void giveBack(); });
  take.focus();
})();
