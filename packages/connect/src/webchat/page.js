// Code that runs inside the web chat page. Each function is sent to the tab
// as source text, so it must not use anything outside its own body.
//
// They read only these fields of a site file (sites/*.js):
//   editor          the box the question is typed into
//   send, stop      the send button, and the stop button shown while it answers
//   reply           one answer; the last one is the newest
//   replyText       the text part inside an answer (null: the whole answer)
//   busy            optional: present while an answer is still being written
//   modelButton     the model picker button; its text names the model
//   modelItems      the choices in the open model picker
//   temporaryButton optional: the button that turns on a temporary chat
//   temporaryOn     optional: present while a temporary chat is on
//   temporaryParam  optional: the address holds this while a temporary chat is on
//   signIn          a sign-in link or button: the profile is signed out
//   signInPath      optional: an address path that is the sign-in page

/** What the page shows now. */
export function state(site) {
  const one = (sel) => (sel ? document.querySelector(sel) : null);
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const button = one(site.modelButton);
  // The shown name; the button's spoken label only when it shows none.
  const label = button ? (button.innerText || button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() : '';
  const replies = site.reply ? document.querySelectorAll(site.reply).length : 0;
  const temporary = !!(one(site.temporaryOn) || (site.temporaryParam && location.href.includes(site.temporaryParam)));
  return {
    url: location.href,
    ready: visible(one(site.editor)),
    signedOut: !!one(site.signIn) || (!!site.signInPath && new RegExp(site.signInPath).test(location.pathname)),
    replies,
    model: label,
    temporary,
    canTurnOnTemporary: visible(one(site.temporaryButton)),
  };
}

/** Click the temporary chat button, if the site has one. */
export function temporaryOn(site) {
  const b = site.temporaryButton ? document.querySelector(site.temporaryButton) : null;
  if (b) b.click();
  return !!b;
}

/**
 * Choose a model in the picker by the name it shows. A choice whose first
 * line is the name wins over one that only contains it.
 */
export async function pickModel(site, name) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(name);
  const button = site.modelButton ? document.querySelector(site.modelButton) : null;
  if (!button) return { ok: false, reason: 'no-picker', options: [] };
  const label = () => norm([button.innerText, button.getAttribute('aria-label')].filter(Boolean).join(' '));
  if (label().includes(want)) return { ok: true, changed: false };
  button.click();
  let items = [];
  for (let i = 0; i < 20 && !items.length; i++) {
    await wait(150);
    items = [...document.querySelectorAll(site.modelItems)].filter((el) => el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }
  const first = (el) => norm(String(el.innerText || el.textContent).split('\n').find((l) => l.trim()) || '');
  const hit = items.find((el) => first(el) === want) || items.find((el) => first(el).includes(want)) || items.find((el) => norm(el.innerText || el.textContent).includes(want));
  const options = items.map(first).filter(Boolean);
  if (!hit) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.body.click();
    return { ok: false, reason: 'not-found', options };
  }
  hit.click();
  for (let i = 0; i < 20; i++) {
    await wait(150);
    if (label().includes(want)) return { ok: true, changed: true };
  }
  return { ok: false, reason: 'not-applied', options };
}

/** Add a piece of the question to the page. Many pieces keep each call small. */
export function addText(_site, { piece, first }) {
  if (first) window.__helmWebchatText = '';
  window.__helmWebchatText = (window.__helmWebchatText || '') + piece;
  return window.__helmWebchatText.length;
}

/** Put the whole question in the editor, in place of what it held. */
export function fillEditor(site) {
  const text = window.__helmWebchatText || '';
  const ed = document.querySelector(site.editor);
  if (!ed) return { ok: false, reason: 'no-editor' };
  ed.focus();
  if (ed instanceof HTMLTextAreaElement || ed instanceof HTMLInputElement) {
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ed), 'value').set;
    set.call(ed, text);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    if (!document.execCommand('insertText', false, text)) {
      ed.textContent = text;
      ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }
  const now = (ed.value ?? ed.innerText ?? '').replace(/\s+/g, ' ').trim();
  const start = text.replace(/\s+/g, ' ').trim().slice(0, 40);
  return { ok: now.includes(start), length: now.length };
}

/** Press send once the site lets it. */
export async function pressSend(site) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 30; i++) {
    const b = document.querySelector(site.send);
    if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') { b.click(); return { ok: true }; }
    await wait(100);
  }
  return { ok: false };
}

/** The newest answer, and whether the site still writes it. */
export function readReply(site) {
  const all = site.reply ? document.querySelectorAll(site.reply) : [];
  const last = all.length ? all[all.length - 1] : null;
  const part = last && site.replyText ? last.querySelector(site.replyText) || last : last;
  return {
    n: all.length,
    text: part ? String(part.innerText ?? part.textContent ?? '').trim() : '',
    busy: !!(site.stop && document.querySelector(site.stop)) || !!(site.busy && document.querySelector(site.busy)),
    url: location.href,
  };
}

/** Press stop, if an answer is being written. */
export function pressStop(site) {
  const b = site.stop ? document.querySelector(site.stop) : null;
  if (b) b.click();
  return !!b;
}

/** `fn(site, arg)` as one expression a tab can run. */
export const call = (fn, site, arg) => `(${fn})(${JSON.stringify(site)}, ${JSON.stringify(arg ?? null)})`;
