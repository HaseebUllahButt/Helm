/** A chunk queue keeps the same UTF-16 tail without joining it on every write. */
export class JavaScriptReplay {
  #pieces = [];
  #head = 0;
  #offset = 0;
  #length = 0;
  constructor(limit, trimLine = true) { this.limit = limit; this.trimLine = trimLine; }

  #drop(count) {
    this.#length -= count;
    while (count) {
      const available = this.#pieces[this.#head].length - this.#offset;
      if (count < available) { this.#offset += count; return; }
      count -= available;
      this.#pieces[this.#head++] = null;
      this.#offset = 0;
    }
  }

  append(text) {
    if (!text.length) return;
    this.#pieces.push(text);
    this.#length += text.length;
    if (this.#length > this.limit) {
      this.#drop(this.#length - this.limit);
      let seen = 0;
      // The previous trim keeps the first newline only when it is within 4096 units.
      for (let i = this.#head; this.trimLine && i < this.#pieces.length && seen < 4096; i++) {
        const start = i === this.#head ? this.#offset : 0;
        const part = this.#pieces[i].slice(start, start + 4096 - seen);
        const newline = part.indexOf('\n');
        if (newline >= 0) { this.#drop(seen + newline + 1); break; }
        seen += part.length;
      }
    }
    if (this.#head > this.#pieces.length / 2) {
      this.#pieces = this.#pieces.slice(this.#head);
      this.#head = 0;
    }
  }

  text() {
    const pieces = this.#pieces.slice(this.#head);
    if (pieces.length) pieces[0] = pieces[0].slice(this.#offset);
    return pieces.join('');
  }

  clear() { this.#pieces = []; this.#head = this.#offset = this.#length = 0; }
}

/** Cache replay text until the next write. No join is needed while output arrives. */
export function createReplayBuffer(limit, { trimLine = true } = {}) {
  const buffer = new JavaScriptReplay(limit, trimLine);
  let cached = null;
  return {
    append(text) { buffer.append(text); cached = null; },
    text() { return cached ??= buffer.text(); },
    clear() { buffer.clear(); cached = null; },
  };
}
