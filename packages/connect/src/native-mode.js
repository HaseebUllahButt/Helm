/**
 * Which permission mode a terminal Claude is showing, read off its screen.
 *
 * Claude has no command that sets the mode: the person at the keyboard
 * presses shift+tab until the footer says the one they want
 * ("⏵⏵ accept edits on"). Helm does the same, and needs to read that footer.
 * Claude redraws only the characters that changed, skipping a run that is
 * the same as before with a cursor move, so a label cannot be matched in
 * the bytes alone: "bypass permissions" over "auto mode" can arrive as
 * "bypass p", a jump, "rmissions". This keeps just enough of a screen -
 * characters at rows and columns, counted from the top-left the way
 * Claude's frames address them - to read the rows a frame touched whole.
 */

const MAX_ROWS = 2048, MAX_COLUMNS = 4096;
const LABEL = /(manual mode|default mode|accept edits|plan mode|auto mode|bypass permissions|don.t ask) on\b/gi;

/** Helm's mode ids, as the footer words them. */
export const MODE_LABELS = {
  default: 'default', acceptEdits: 'accept edits', auto: 'auto mode', bypassPermissions: 'bypass permissions', plan: 'plan mode',
};

/** The footer's words, back to Helm's mode ids. */
export const MODE_FROM_LABEL = Object.fromEntries([...Object.entries(MODE_LABELS).map(([id, label]) => [label, id]), ["don't ask", 'dontAsk']]);

export class ModeFooter {
  #rows = new Map();
  #dirty = new Set();
  #r = 0;
  #c = 0;
  #saved = [0, 0];
  #rest = '';

  #row(r) {
    let row = this.#rows.get(r);
    if (!row) { row = []; this.#rows.set(r, row); }
    return row;
  }

  /** Bytes as the terminal received them, in order. */
  feed(text) {
    const s = this.#rest + String(text ?? '');
    this.#rest = '';
    for (let i = 0; i < s.length;) {
      this.#r = Math.min(MAX_ROWS - 1, this.#r);
      this.#c = Math.min(MAX_COLUMNS - 1, this.#c);
      const ch = s[i];
      if (ch === '\x1b') {
        const next = s[i + 1];
        if (next === undefined) { this.#rest = s.slice(i); return; }
        if (next === '[') {
          const m = /^[?>=!]?([\d;]*)[ -/]*([@-~])/.exec(s.slice(i + 2, i + 40));
          if (!m) { if (s.length - i < 40) { this.#rest = s.slice(i); return; } i += 2; continue; }
          this.#csi(m[2], m[1].split(';').map((x) => (x === '' ? null : Number(x))), s[i + 2]);
          i += 2 + m[0].length;
          continue;
        }
        if (next === ']') {
          const bel = s.indexOf('\x07', i), st = s.indexOf('\x1b\\', i);
          const end = [bel, st].filter((x) => x >= 0);
          if (!end.length) { this.#rest = s.slice(i); return; }
          const at = Math.min(...end);
          i = at + (at === st ? 2 : 1);
          continue;
        }
        if (next === '7') this.#saved = [this.#r, this.#c];
        else if (next === '8') [this.#r, this.#c] = this.#saved;
        i += '()*+'.includes(next) ? 3 : 2;
        continue;
      }
      if (ch === '\r') this.#c = 0;
      else if (ch === '\n') this.#r += 1;
      else if (ch === '\b') this.#c = Math.max(0, this.#c - 1);
      else if (ch === '\t') this.#c = (this.#c + 8) & ~7;
      else if (ch >= ' ' && ch !== '\x7f') {
        const cp = s.codePointAt(i);
        const glyph = String.fromCodePoint(cp);
        this.#row(this.#r)[this.#c] = glyph;
        this.#dirty.add(this.#r);
        this.#c += 1;
        i += glyph.length;
        continue;
      }
      i += 1;
    }
  }

  #csi(final, p, lead) {
    const n = Math.min(MAX_COLUMNS, Math.max(1, p[0] ?? 1));
    switch (final) {
      case 'H': case 'f': this.#r = Math.max(0, (p[0] ?? 1) - 1); this.#c = Math.max(0, (p[1] ?? 1) - 1); return;
      case 'A': this.#r = Math.max(0, this.#r - n); return;
      case 'B': this.#r += n; return;
      case 'C': this.#c += n; return;
      case 'D': this.#c = Math.max(0, this.#c - n); return;
      case 'E': this.#r += n; this.#c = 0; return;
      case 'F': this.#r = Math.max(0, this.#r - n); this.#c = 0; return;
      case 'G': this.#c = n - 1; return;
      case 'd': this.#r = n - 1; return;
      case 'K': {
        if (lead === '?') return;
        const row = this.#row(this.#r);
        const how = p[0] ?? 0;
        if (how === 0) row.length = Math.min(row.length, this.#c);
        else if (how === 1) for (let x = 0; x <= this.#c; x++) row[x] = undefined;
        else row.length = 0;
        this.#dirty.add(this.#r);
        return;
      }
      case 'J': {
        if (lead === '?') return;
        const how = p[0] ?? 0;
        if (how >= 2) { this.#rows.clear(); return; }
        for (const r of [...this.#rows.keys()]) if (how === 0 ? r > this.#r : r < this.#r) this.#rows.delete(r);
        return;
      }
      default: return;
    }
  }

  /** Forget which rows were drawn, so the next `label` reads only what comes after. */
  mark() { this.#dirty.clear(); }

  /**
   * The mode named on the lowest row drawn since `mark`, as Helm's id
   * vocabulary words it ('default' for "manual mode"), or null.
   */
  label() {
    for (const r of [...this.#dirty].sort((a, b) => b - a)) {
      const row = this.#rows.get(r);
      if (!row) continue;
      const line = Array.from(row, (x) => x ?? ' ').join('');
      const found = [...line.matchAll(LABEL)].at(-1)?.[1].toLowerCase();
      if (found) return found === 'manual mode' || found === 'default mode' ? 'default' : found;
    }
    return null;
  }
}
