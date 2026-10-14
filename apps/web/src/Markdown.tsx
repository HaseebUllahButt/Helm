import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { render, loadHighlighting, hasHighlighting } from './md';

/**
 * Agent prose as prose. The transcript is markdown - headings, lists, fenced
 * code - and rendering it is the difference between a chat you can read on a
 * phone and a wall of asterisks.
 *
 * Formatting ships with the chat. Only syntax highlighting is lazy: a slow
 * connection or a missing chunk must never expose raw Markdown to the reader.
 */

/** Warm the chunk while the machine list is being read, not when it is needed. */
const idle = (fn: () => void) =>
  ('requestIdleCallback' in globalThis
    ? (globalThis as any).requestIdleCallback(fn, { timeout: 2000 })
    : setTimeout(fn, 200));
idle(loadHighlighting);

function useHighlighting() {
  const [ready, setReady] = useState(hasHighlighting);
  useEffect(() => {
    let mounted = true;
    loadHighlighting().then(() => { if (mounted) setReady(hasHighlighting()); });
    return () => { mounted = false; };
  }, []);
  return ready;
}

/**
 * Where a streaming reply's settled part ends: the last blank line that is
 * not inside a code fence. Everything before it is finished markdown that
 * the next token cannot change.
 */
function settledEnd(text: string): number {
  let fence: string | null = null, end = 0, at = 0;
  for (const line of text.split('\n')) {
    const delimiter = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
    } else if (!fence && !line.trim() && at > 0) end = at;
    at += line.length + 1;
  }
  return end;
}

export const Markdown = memo(function Markdown({ text, className = '', live = false }: { text: string; className?: string; live?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const highlighted = useHighlighting();
  // While a reply streams it is re-rendered as text arrives, and a whole
  // parse (marked, highlight.js, DOMPurify) of a long reply is tens of ms on
  // a phone - a saturated main thread for as long as the reply lasts. The
  // settled blocks are parsed once and kept; only the growing tail is new
  // work each step. A finished message goes back to one whole parse.
  const cut = live ? settledEnd(text) : 0;
  const head = cut ? text.slice(0, cut) : '';
  const headHtml = useMemo(() => (head ? render(head) : ''), [head, highlighted]);
  const html = useMemo(
    () => headHtml + render(cut ? text.slice(cut) : text),
    [text, cut, headHtml, highlighted],
  );

  // One delegated handler for every copy button in this message.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onClick = async (ev: Event) => {
      const btn = (ev.target as HTMLElement).closest('button[data-copy]') as HTMLButtonElement | null;
      if (!btn) return;
      const code = btn.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
      try { await navigator.clipboard.writeText(code); btn.textContent = 'copied'; }
      catch { btn.textContent = 'failed'; }
      setTimeout(() => { btn.textContent = 'copy'; }, 1500);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, []);

  return <div ref={host} className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
