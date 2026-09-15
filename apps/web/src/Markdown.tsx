import { useEffect, useMemo, useRef, useState } from 'react';
import type { render as Render } from './md';

/**
 * Agent prose as prose. The transcript is markdown - headings, lists, fenced
 * code - and rendering it is the difference between a chat you can read on a
 * phone and a wall of asterisks.
 *
 * The engine that does it lives in its own chunk (see `md.ts`). Until it
 * arrives the text is shown as plain text rather than a blank space or a
 * spinner, so a slow link degrades to "readable" instead of "empty". The
 * import starts on idle the moment this module loads, which in practice
 * means the engine is ready long before a conversation is opened.
 */
let engine: { render: typeof Render } | null = null;
let pending: Promise<void> | null = null;
const waiting = new Set<() => void>();

function load() {
  if (engine || pending) return pending;
  pending = import('./md').then((m) => {
    engine = m;
    for (const notify of waiting) notify();
    waiting.clear();
  }).catch(() => { pending = null; });
  return pending;
}

/** Warm the chunk while the machine list is being read, not when it is needed. */
const idle = (fn: () => void) =>
  ('requestIdleCallback' in globalThis
    ? (globalThis as any).requestIdleCallback(fn, { timeout: 2000 })
    : setTimeout(fn, 200));
idle(load);

function useEngine() {
  const [, bump] = useState(0);
  useEffect(() => {
    if (engine) return;
    const notify = () => bump((n) => n + 1);
    waiting.add(notify);
    load();
    return () => { waiting.delete(notify); };
  }, []);
  return engine;
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const ready = useEngine();
  const html = useMemo(() => (ready ? ready.render(text) : null), [text, ready]);

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

  if (html == null) return <div ref={host} className={`md raw ${className}`}>{text}</div>;
  return <div ref={host} className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
