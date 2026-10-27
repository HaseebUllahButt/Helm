/** Collect new text once, then deliver complete lines in their original order. */
export class LineBuffer {
  #parts = [];
  #head = null;
  #lines = [];
  #at = 0;
  #pending = false;

  get tail() { return this.#parts.join(''); }

  write(chunk) {
    // Match the old loops: decode each Buffer separately. Joining its bytes
    // before decoding would change replacement characters at chunk edges.
    const text = typeof chunk === 'string' ? chunk : '' + chunk;
    if (!text) return;
    if (!this.#pending) {
      const cut = text.indexOf('\n');
      // Most provider messages arrive whole. Avoid making an array for one line.
      if (cut === text.length - 1) { this.#add(text.slice(0, cut)); return; }
      if (cut >= 0 && text.endsWith('\n')) {
        for (const line of text.slice(0, -1).split('\n')) this.#add(line);
        return;
      }
    }
    this.#pending = !text.endsWith('\n');
    let start = 0, cut;
    while ((cut = text.indexOf('\n', start)) !== -1) {
      const part = text.slice(start, cut);
      if (this.#parts.length) {
        this.#parts.push(part);
        this.#add(this.#parts.join(''));
        this.#parts = [];
      } else this.#add(part);
      start = cut + 1;
    }
    if (start < text.length) this.#parts.push(text.slice(start));
  }

  #add(line) {
    if (this.#head === null) this.#head = line;
    else this.#lines.push(line);
  }

  read() {
    const line = this.#head;
    if (line === null) return null;
    if (this.#at < this.#lines.length) {
      this.#head = this.#lines[this.#at];
      this.#lines[this.#at++] = null;
      if (this.#at === this.#lines.length) { this.#lines = []; this.#at = 0; }
    } else this.#head = null;
    return line;
  }
}
