import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { render, renderNodes, loadHighlighting, hasHighlighting } from './md';

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
 * the next token cannot change. Also where a code fence that is still open
 * starts, with its language, once its first line is complete.
 */
function settledEnd(text: string): { end: number; open: { at: number; lang: string; fence: string } | null } {
  let fence: string | null = null, end = 0, at = 0, open: { at: number; lang: string; fence: string } | null = null;
  // The last line is still being written: a reply that stops right after a
  // line break must not count the empty line after it, or the settled part
  // shrinks again with the next word.
  for (const line of text.split('\n').slice(0, -1)) {
    const delimiter = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) { fence = delimiter[1]; open = { at, lang: delimiter[2].trim().split(/\s+/)[0].toLowerCase(), fence: delimiter[1] }; }
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) { fence = null; open = null; }
    } else if (!fence && !line.trim() && at > 0) end = at;
    at += line.length + 1;
  }
  return { end, open };
}

/**
 * An open code block while it streams: the same box the renderer makes, with
 * the code as plain text. Formatting and colouring it again for every piece
 * cost a long block hundreds of ms a step; it is done once, when it closes.
 */
function liveCodeBlock(lang: string) {
  const block = document.createElement('div');
  block.className = 'codeblock';
  const head = document.createElement('div');
  head.className = 'codehead';
  const name = document.createElement('span');
  name.textContent = lang || 'text';
  const copy = document.createElement('button');
  copy.type = 'button'; copy.className = 'copy'; copy.dataset.copy = ''; copy.textContent = 'Copy';
  head.append(name, copy);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'hljs';
  pre.append(code);
  block.append(head, pre);
  return { block, code };
}

export const Markdown = memo(function Markdown({ text, className = '', live = false }: { text: string; className?: string; live?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const highlighted = useHighlighting();
  // A finished message is one whole parse, written once.
  const html = useMemo(() => (live ? '' : render(text)), [text, live, highlighted]);
  // What the box holds now: a finished message's HTML, or for a live reply
  // the settled text already in it and how many of its nodes that made.
  const shown = useRef<{ html: string } | {
    settled: string; nodes: number; highlighted: boolean;
    /** The open code block at the end, if the tail is one: what is in it so far. */
    open?: { at: number; before: string; body: string; code: HTMLElement };
  } | null>(null);

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
    const { end: cut, open } = settledEnd(text);
    // A finished message going live, another reply, or a highlighter that
    // just arrived: start the box over.
    let now = was && 'settled' in was && was.highlighted === highlighted
      && cut >= was.settled.length && text.startsWith(was.settled) ? was : null;
    if (!now) { el.textContent = ''; now = shown.current = { settled: '', nodes: 0, highlighted }; }
    if (cut > now.settled.length) {
      while (el.childNodes.length > now.nodes) el.lastChild!.remove();
      now.open = undefined;
      el.append(renderNodes(text.slice(now.settled.length, cut)));
      now.settled = text.slice(0, cut);
      now.nodes = el.childNodes.length;
    }
    // A closing fence already typed on the last line ends the block: the
    // whole-parse path below draws it as the finished block.
    const lastLine = text.slice(text.lastIndexOf('\n') + 1).trim();
    const closing = !!open && lastLine.length >= open.fence.length && lastLine === open.fence[0].repeat(lastLine.length);
    if (open && open.at >= cut && !closing) {
      const before = text.slice(cut, open.at);
      const line = text.indexOf('\n', open.at);
      const body = text.slice(line + 1);
      const held = now.open;
      // The same block, grown at the end: add only the new code.
      if (held && held.at === open.at && held.before === before && body.startsWith(held.body)) {
        if (body.length > held.body.length) held.code.append(body.slice(held.body.length));
        held.body = body;
        return;
      }
      while (el.childNodes.length > now.nodes) el.lastChild!.remove();
      if (before) el.append(renderNodes(before));
      const { block, code } = liveCodeBlock(open.lang);
      code.textContent = body;
      el.append(block);
      now.open = { at: open.at, before, body, code };
      return;
    }
    while (el.childNodes.length > now.nodes) el.lastChild!.remove();
    now.open = undefined;
    el.append(renderNodes(text.slice(cut)));
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
