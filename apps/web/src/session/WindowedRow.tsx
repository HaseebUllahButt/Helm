import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

// Keep one observer per chat, rather than one per saved message. Empty rows
// keep their measured space; only nearby messages build Markdown and tools.
const observers = new WeakMap<Element, { observer: IntersectionObserver; rows: Map<Element, (visible: boolean) => void> }>();
function observe(root: Element, node: Element, changed: (visible: boolean) => void) {
  let group = observers.get(root);
  if (!group) {
    const rows = new Map<Element, (visible: boolean) => void>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) rows.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin: '1000px 0px' });
    group = { observer, rows }; observers.set(root, group);
  }
  group.rows.set(node, changed); group.observer.observe(node);
  return () => {
    group.rows.delete(node); group.observer.unobserve(node);
    if (!group.rows.size) { group.observer.disconnect(); observers.delete(root); }
  };
}

export function WindowedRow({ children, enabled, eager = false, force = false, turn, prompt = false }: {
  children: ReactNode; enabled: boolean; eager?: boolean; force?: boolean; turn?: string; prompt?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const height = useRef(180);
  const [near, setNear] = useState(!enabled || eager);
  const visible = useRef(false), above = useRef(false), pin = useRef(false), forced = useRef(force);
  const changeVisibility = useRef<(inside: boolean) => void>();
  forced.current = force;
  const shown = !enabled || near || force;
  const rendered = useRef(shown);
  rendered.current = shown;
  useLayoutEffect(() => {
    const node = box.current, root = node?.closest('.chat');
    if (!enabled || !node || !root) return;
    const change = (inside: boolean) => {
      pin.current = inside && !rendered.current && root.scrollHeight - root.scrollTop - root.clientHeight < 80;
      visible.current = inside;
      if (!inside) {
        const selection = window.getSelection();
        // Keep open tools, active controls, pictures and selected words intact.
        if (forced.current || node.contains(document.activeElement)
          || selection && !selection.isCollapsed && selection.containsNode(node, true)
          || node.querySelector('[aria-expanded="true"], details[open], iframe, video')) return;
      }
      above.current = node.getBoundingClientRect().bottom <= root.getBoundingClientRect().top;
      setNear(inside);
    };
    changeVisibility.current = change;
    return observe(root, node, change);
  }, [enabled]);
  useLayoutEffect(() => {
    const node = box.current, root = node?.closest('.chat');
    if (!shown || !node || !root) return;
    const measure = () => {
      const next = node.getBoundingClientRect().height;
      const delta = next - height.current;
      height.current = next;
      if (pin.current) root.scrollTop = root.scrollHeight;
      else if (above.current && delta) root.scrollTop += delta;
      above.current = false; pin.current = false;
    };
    measure();
    const resize = new ResizeObserver(measure); resize.observe(node);
    const selection = () => { if (!visible.current) changeVisibility.current?.(false); };
    document.addEventListener('selectionchange', selection);
    node.addEventListener('focusout', selection);
    return () => {
      resize.disconnect(); document.removeEventListener('selectionchange', selection); node.removeEventListener('focusout', selection);
    };
  }, [shown]);
  return <div ref={box} className="timeline-row" data-row-turn={turn} data-row-prompt={prompt || undefined}
    data-row-visible={shown || undefined} style={{ display: 'flow-root', ...(shown ? {} : { height: height.current }) }}>
    {shown ? children : null}
  </div>;
}

/** Read one older page only when the reader moves toward the top. */
export function useEarlierOnScroll(box: RefObject<HTMLElement>, earlier: boolean, loading: boolean,
  read?: () => void | Promise<void>) {
  const current = useRef({ earlier, loading, read });
  current.current = { earlier, loading, read };
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    let top = node.scrollTop, touch = 0, pending = false, gesture = false;
    const request = () => {
      const state = current.current;
      if (pending || !state.earlier || state.loading || !state.read || node.scrollTop > node.clientHeight) return;
      pending = true; gesture = false;
      void Promise.resolve(state.read()).finally(() => { pending = false; });
    };
    const scroll = () => { const before = top; top = node.scrollTop; if (gesture && top < before - 1) request(); };
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) { gesture = true; request(); } };
    const pointer = () => { gesture = true; };
    const key = (event: KeyboardEvent) => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) gesture = true; };
    const start = (event: TouchEvent) => { gesture = true; touch = event.touches[0]?.clientY ?? 0; };
    const move = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY ?? touch;
      if (next > touch + 5) request();
      touch = next;
    };
    node.addEventListener('scroll', scroll, { passive: true });
    node.addEventListener('pointerdown', pointer, { passive: true });
    node.addEventListener('keydown', key);
    node.addEventListener('wheel', wheel, { passive: true });
    node.addEventListener('touchstart', start, { passive: true });
    node.addEventListener('touchmove', move, { passive: true });
    return () => {
      node.removeEventListener('scroll', scroll); node.removeEventListener('wheel', wheel);
      node.removeEventListener('pointerdown', pointer); node.removeEventListener('keydown', key);
      node.removeEventListener('touchstart', start); node.removeEventListener('touchmove', move);
    };
  }, [box]);
}
