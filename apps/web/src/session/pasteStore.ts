/**
 * Big pastes once went into the box as a token - "pasted text 1 · 3,412
 * chars" - and came back whole on send. The owner wants the real text in the
 * box, so pastes are no longer folded. Drafts saved before that can still
 * hold a token, so a send still puts its text back. Held in localStorage as
 * well as memory: a draft that survives a reload must not send the token as
 * if it were the message.
 */
const KEY = 'helm.pastes';
const TOKEN = /⟦pasted text \d+ · [\d,]+ chars⟧/g;

const load = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const save = (m: Record<string, string>) => {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* full: it lives in memory for this visit */ }
};
const memory: Record<string, string> = {};

/** Store `text` and return the token that stands in for it (as older drafts hold). */
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
