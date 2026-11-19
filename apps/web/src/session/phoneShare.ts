/**
 * helm phone (phone.js) on the app side: the way the card reaches its
 * machine, and text the owner shares to Helm from another app.
 *
 * The card sends its answers with its own calls (`phone.give`,
 * `phone.photo`), not with `session.answer`: those are kept in browser
 * storage until they arrive, and a photo or a sign-in code must not be.
 */

type Rpc = (env: string, method: string, params: any, timeout?: number) => Promise<any>;
let current: Rpc | null = null;

/** App.tsx gives its client here when it signs in. */
export function setPhoneRpc(rpc: Rpc | null) { current = rpc; }
export function phoneRpc(): Rpc {
  if (!current) throw new Error('Helm is not connected yet. Try again.');
  return current;
}

const KEY = 'helm.phone-share';
const KEEP_MS = 15 * 60_000;
export const SHARE_EVENT = 'helm:phone-share';

/**
 * The installed app is a share target (manifest.webmanifest): Android opens
 * it as /?share-text=... when the owner shares a text message to Helm. Keep
 * the text for an open sign-in code card, and take it out of the address.
 */
export function takeSharedText(loc: Location = location) {
  let params: URLSearchParams;
  try { params = new URLSearchParams(loc.search); } catch { return; }
  const parts = ['share-title', 'share-text', 'share-url'].map((k) => params.get(k)?.trim()).filter(Boolean);
  if (!parts.length && !params.has('share-text')) return;
  for (const k of ['share-title', 'share-text', 'share-url']) params.delete(k);
  const rest = params.toString();
  try { history.replaceState(history.state, '', loc.pathname + (rest ? `?${rest}` : '') + loc.hash); } catch { /* keep the address */ }
  if (!parts.length) return;
  try { sessionStorage.setItem(KEY, JSON.stringify({ text: parts.join('\n'), at: Date.now() })); } catch { /* no storage: nothing to keep */ }
  try { window.dispatchEvent(new Event(SHARE_EVENT)); } catch { /* not in a page */ }
}

/** Text shared to Helm in the last 15 minutes, or null. */
export function sharedText(): string | null {
  try {
    const held = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (held && typeof held.text === 'string' && Date.now() - held.at < KEEP_MS) return held.text;
  } catch { /* nothing kept */ }
  return null;
}

export function forgetSharedText() {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing kept */ }
}

/**
 * The code in a pasted or shared text message. Keep it the same as
 * findCode in phone.js: the first group of 4 to 10 digits (dashes and spaces
 * inside are dropped), else a short word with a digit in it.
 */
export function findCode(text: string): string {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (/^[A-Za-z0-9-]{3,12}$/.test(t)) return t;
  const digits = /(?<![\d-])(\d[\d -]{2,12}\d)(?![\d-])/.exec(t)?.[1]?.replace(/[ -]/g, '');
  if (digits && digits.length >= 4 && digits.length <= 10) return digits;
  const word = /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4,10}\b/.exec(t)?.[0];
  return word ?? t.slice(0, 200);
}

/** What the waiting box says a chat wants. */
export const PHONE_WANTS: Record<string, string> = {
  ask: 'asks you a question', photo: 'wants a photo', location: 'wants your location', code: 'wants a sign-in code',
};
