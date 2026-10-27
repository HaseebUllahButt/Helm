import type { Terminal } from '@xterm/xterm';

export function localTerminalUrl(text: string): string | null {
  const raw = text.trim();
  const port = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d+)(?:[/?#]|$)/i.exec(raw)?.[1];
  if (!port || +port < 1 || +port > 65535) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    return ['localhost', '127.0.0.1'].includes(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Join wrapped lines and keep cell positions, including wide characters. */
export function terminalLocalLinks(terminal: Terminal, y: number) {
  const buffer = terminal.buffer.active;
  let first = y - 1, last = first;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  const positions: { x: number; y: number }[] = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let column = 0; column < line.length; column++) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (const char of chars.split('')) positions.push({ x: column + 1, y: row + 1 });
      text += chars;
    }
  }
  return [...text.matchAll(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):\d+(?:[/?#][^\s<>"'`()[\]{}]*)?/gi)].flatMap(match => {
    if (match.index > 0 && /[\w./@:-]/.test(text[match.index - 1])) return [];
    if (/^[\w@:-]|^\.\w/.test(text.slice(match.index + match[0].length))) return [];
    const label = match[0].replace(/[.,;!]+$/, ''), url = localTerminalUrl(label);
    const start = positions[match.index], end = positions[match.index + label.length - 1];
    return url && start && end && start.y <= y && end.y >= y ? [{ text: label, url, range: { start, end } }] : [];
  });
}
