// One question to a web chat, through Helm's browser calls. `browser` is
// the object a browser script gets (browser-script.js): tabs(), open(),
// tab(id).evaluate() and tab(id).goto().
import * as page from './page.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Small enough that an escaped piece stays under the 20,000 characters a step may send.
const PIECE = 6_000;

/** The site's host, from its home address. */
export const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

/** True when `url` is the saved conversation `conversation`. */
export function sameConversation(url, conversation) {
  if (!url || !conversation) return false;
  const clean = (u) => String(u).replace(/[?#].*$/, '').replace(/\/+$/, '');
  return clean(url) === clean(conversation);
}

/**
 * The text sent when a temporary chat is gone (its tab was closed): the
 * earlier questions and answers go first, so the site still has them.
 */
export function withHistory(question, history = []) {
  if (!history.length) return question;
  const lines = history.map(({ q, a }) => `Question: ${q}\nAnswer: ${a}`).join('\n\n');
  return `Earlier in this conversation:\n\n${lines}\n\nNow answer this:\n${question}`;
}

/**
 * Ask `question` and wait for the whole answer.
 *
 * `conversation` is the saved address of this chat's conversation, or
 * 'temporary' for a temporary chat that was started before, or null for a
 * new chat. `tabId` is the tab used last. Calls that only read the page are
 * asked again for up to `retryMs` when they fail: a Helm restart breaks a
 * call in flight, and the tab is still there after it.
 */
export async function askSite(browser, { site, question, profile = null, model = null, temporary = false, conversation = null, tabId = null,
  history = [], onProgress = () => {}, stopped = () => false, sleep = pause, timeout = 600_000, retryMs = 120_000, pollMs = 1500 }) {
  const host = hostOf(site.home);
  const label = site.label || site.id;
  const again = async (fn) => {
    const end = Date.now() + retryMs;
    for (;;) {
      try { return await fn(); } catch (error) {
        if (Date.now() >= end || stopped()) throw error;
        await sleep(2000);
      }
    }
  };
  const run = (tab, fn, arg) => browser.tab(tab).evaluate(page.call(fn, site, arg));
  const look = (tab) => again(() => run(tab, page.state));

  // 1. The tab: the one used last, else any tab of this chat on the site.
  const tabs = (await again(() => browser.tabs())) ?? [];
  let tab = tabs.find((t) => t.id === tabId) ?? tabs.find((t) => hostOf(t.url) === host) ?? null;
  const continuing = !!conversation;
  let fresh = !continuing, restarted = false;
  if (continuing) {
    const here = tab && (temporary ? hostOf(tab.url) === host && conversation === 'temporary' : sameConversation(tab.url, conversation));
    if (!here) {
      if (!temporary && conversation !== 'temporary') {
        if (tab) await browser.tab(tab.id).goto(conversation);
        else tab = (await browser.open(conversation, profile ? { profile } : {})).tab;
      } else { fresh = true; restarted = true; }
    }
  }
  if (fresh) {
    const start = temporary ? (site.temporaryUrl ?? site.home) : site.home;
    if (tab) await browser.tab(tab.id).goto(start);
    else tab = (await browser.open(start, profile ? { profile } : {})).tab;
  }
  const id = tab.id;

  // 2. Wait for the page: the editor, or a sign-in screen.
  let now = null;
  for (let i = 0; i < 60; i++) {
    now = await look(id);
    if (now.ready || now.signedOut) break;
    await sleep(500);
  }
  if (!now.ready) {
    if (now.signedOut) throw new Error(`${label} is signed out${profile ? ` in the browser profile "${profile}"` : ''}. Sign in there, then send the question again.`);
    throw new Error(`The ${label} page did not load its message box. Open ${now.url} in the browser and check it.`);
  }

  // 3. A temporary chat must be on before anything is sent.
  if (temporary && fresh) {
    // The button can show a moment after the message box.
    for (let i = 0; i < 10 && !now.temporary && site.temporaryButton && !now.canTurnOnTemporary; i++) { await sleep(500); now = await look(id); }
    if (!now.temporary && now.canTurnOnTemporary) {
      await run(id, page.temporaryOn);
      for (let i = 0; i < 10 && !now.temporary; i++) { await sleep(300); now = await look(id); }
      // The "turn on" button went away when clicked: the chat is temporary.
      if (!now.temporary && !now.canTurnOnTemporary) now.temporary = true;
    }
    if (!now.temporary) throw new Error(`Could not turn on a temporary chat in ${label}. Nothing was sent.`);
  }

  // 4. The model the account names.
  if (model) {
    const picked = await run(id, page.pickModel, model);
    if (!picked?.ok) {
      const offers = picked?.options?.length ? ` It offers: ${picked.options.join(', ')}.` : '';
      throw new Error(picked?.reason === 'no-picker'
        ? `Could not find the model picker in ${label}. Nothing was sent.`
        : `Could not choose the model "${model}" in ${label}.${offers} Nothing was sent.`);
    }
    now = await look(id);
  }

  // 5. Type and send.
  const text = restarted ? withHistory(question, history) : question;
  for (let at = 0; at < text.length || at === 0; at += PIECE) {
    await run(id, page.addText, { piece: text.slice(at, at + PIECE), first: at === 0 });
    if (!text.length) break;
  }
  const filled = await run(id, page.fillEditor);
  if (!filled?.ok) throw new Error(`Could not type the question into ${label}. Nothing was sent.`);
  const before = (await again(() => run(id, page.readReply))).n;
  const pressed = await run(id, page.pressSend);
  if (!pressed?.ok) throw new Error(`The ${label} send button did not work. Nothing was sent.`);
  let seen = null;
  for (let i = 0; i < 40; i++) {
    seen = await again(() => run(id, page.readReply));
    if (seen.n > before || seen.busy) break;
    await sleep(500);
  }
  if (!(seen.n > before || seen.busy)) throw new Error(`${label} did not take the question. Check the tab, then send again.`);
  onProgress({ sent: true, tab: id, restarted });

  // 6. Wait until the answer stops changing.
  const started = Date.now();
  let last = '', same = 0, final = seen;
  while (!stopped()) {
    if (Date.now() - started > timeout) throw Object.assign(new Error(`${label} did not finish in ${Math.round(timeout / 60000)} minutes.`), { partial: last });
    await sleep(pollMs);
    final = await again(() => run(id, page.readReply));
    if (final.n > before && final.text) {
      same = !final.busy && final.text === last ? same + 1 : 0;
      if (final.text !== last) onProgress({ text: final.text });
      last = final.text;
      if (same >= 2) break;
    }
  }
  if (stopped()) {
    await run(id, page.pressStop).catch(() => {});
    return { stopped: true, text: last, tab: id };
  }
  const after = await look(id);
  return { text: last, url: after.url, model: after.model || null, tab: id, restarted,
    conversation: temporary ? 'temporary' : (new RegExp(site.conversation).test(after.url) ? after.url : null) };
}

/** Press stop in the chat's tab on the site. */
export async function stopSite(browser, { site, tabId = null }) {
  const tabs = (await browser.tabs()) ?? [];
  const tab = tabs.find((t) => t.id === tabId) ?? tabs.find((t) => hostOf(t.url) === hostOf(site.home));
  if (!tab) return false;
  return browser.tab(tab.id).evaluate(page.call(page.pressStop, site));
}
