/**
 * Big pastes, kept out of the message box.
 *
 * A log or a file pasted into the composer is a wall of text that pushes the
 * box off the screen and makes it slow to type in. It goes in as a short
 * token - "pasted text 1 · 3,412 chars" - and the text itself is put back in
 * when the message is sent, so the agent receives exactly what was pasted.
 * Held in localStorage as well as memory: a draft that survives a reload must
 * not send the token as if it were the message.
 */
const KEY = 'helm.pastes';
const TOKEN = /⟦pasted text \d+ · [\d,]+ chars⟧/g;

/** Long enough to be a wall of text: a screenful on a phone is about 600 characters. */
export const PASTE_CHARS = 1500;
export const PASTE_LINES = 30;

const load = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const save = (m: Record<string, string>) => {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* full: it lives in memory for this visit */ }
};
const memory: Record<string, string> = {};

export const isBigPaste = (text: string) => text.length >= PASTE_CHARS || text.split('\n').length > PASTE_LINES;

/** Store `text` and return the token that stands in for it. */
export function stashPaste(text: string): string {
  const all = { ...load(), ...memory };
  const n = Object.keys(all).reduce((max, k) => Math.max(max, Number(/pasted text (\d+)/.exec(k)?.[1] ?? 0)), 0) + 1;
  const token = `⟦pasted text ${n} · ${text.length.toLocaleString('en-US')} chars⟧`;
  memory[token] = text;
  save({ ...load(), [token]: text });
  return token;
}

/** Put every pasted text back where its token stands. */
export function expandPastes(body: string): string {
  if (!TOKEN.test(body)) return body;
  TOKEN.lastIndex = 0;
  const all = { ...load(), ...memory };
  const used: string[] = [];
  const out = body.replace(TOKEN, (m) => { if (all[m] != null) { used.push(m); return all[m]; } return m; });
  if (used.length) {
    const kept = load();
    for (const t of used) { delete kept[t]; delete memory[t]; }
    save(kept);
  }
  return out;
}
