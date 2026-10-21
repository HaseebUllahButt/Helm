import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  // The last line is still being written: a reply that stops right after a
  // line break must not count the empty line after it, or the settled part
  // shrinks again with the next word.
  for (const line of text.split('\n').slice(0, -1)) {
    const delimiter = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
    } else if (!fence && !line.trim() && at > 0) end = at;
    at += line.length + 1;
  }
  return end;
}

/** Sanitised HTML as nodes, ready to add to the box. */
const parse = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content;
};

export const Markdown = memo(function Markdown({ text, className = '', live = false }: { text: string; className?: string; live?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const highlighted = useHighlighting();
  // A finished message is one whole parse, written once.
  const html = useMemo(() => (live ? '' : render(text)), [text, live, highlighted]);
  // What the box holds now: a finished message's HTML, or for a live reply
  // the settled text already in it and how many of its nodes that made.
  const shown = useRef<{ html: string } | { settled: string; nodes: number; highlighted: boolean } | null>(null);

  // While a reply streams it is re-rendered as text arrives, and a whole
  // parse (marked, highlight.js, DOMPurify) of a long reply is tens of ms on
  // a phone - a saturated main thread for as long as the reply lasts. Each
  // settled block is parsed once, when it settles, and its nodes are then
  // left alone: only the growing end is replaced each step, so the screen
  // redraws one paragraph, not the whole reply, and a word selected higher
  // up stays selected. The box stays one flat element, so the first/last
  // child spacing and the typing caret read exactly as before.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const was = shown.current;
    if (!live) {
      if (!was || !('html' in was) || was.html !== html) { el.innerHTML = html; shown.current = { html }; }
      return;
    }
    const cut = settledEnd(text);
    // A finished message going live, another reply, or a highlighter that
    // just arrived: start the box over.
    let now = was && 'settled' in was && was.highlighted === highlighted
      && cut >= was.settled.length && text.startsWith(was.settled) ? was : null;
    if (!now) { el.textContent = ''; now = shown.current = { settled: '', nodes: 0, highlighted }; }
    while (el.childNodes.length > now.nodes) el.lastChild!.remove();
    if (cut > now.settled.length) {
      el.append(parse(render(text.slice(now.settled.length, cut))));
      now.settled = text.slice(0, cut);
      now.nodes = el.childNodes.length;
    }
    el.append(parse(render(text.slice(cut))));
  }, [text, live, html, highlighted]);

  // One delegated handler for every copy button in this message.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onClick = async (ev: Event) => {
      const btn = (ev.target as HTMLElement).closest('button[data-copy]') as HTMLButtonElement | null;
      if (!btn) return;
      const code = btn.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
      try { await navigator.clipboard.writeText(code); btn.textContent = 'Copied'; }
      catch { btn.textContent = 'Copy failed'; }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, []);

  return <div ref={host} className={`md ${className}`} />;
});
