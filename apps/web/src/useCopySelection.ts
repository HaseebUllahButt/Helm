import { useEffect, type RefObject } from 'react';

/** Copy a completed selection, just as the terminal does. */
export function useCopySelection(root: RefObject<HTMLElement>) {
  useEffect(() => {
    let selecting = false;
    const copy = () => {
      const selection = window.getSelection();
      const node = root.current;
      if (!node || !selection || selection.isCollapsed) return;
      if (!node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) return;
      const target = selection.anchorNode?.parentElement;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const text = selection.toString();
      if (!text.trim()) return;
      navigator.clipboard?.writeText(text).catch(() => {});
    };
    const down = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      selecting = !!target && !!root.current?.contains(target)
        && !target.closest('button, a, input, textarea, select, [contenteditable="true"]');
    };
    const up = () => { if (selecting) copy(); selecting = false; };
    const key = (event: KeyboardEvent) => { if (event.key === 'Shift' || event.shiftKey) copy(); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('keyup', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('keyup', key);
    };
  }, [root]);
}
