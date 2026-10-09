import { useEffect, type RefObject } from 'react';
import { selectionClipboard, writeSelectionClipboard } from './copySelection';

/** Copy a completed selection, just as the terminal does. */
export function useCopySelection(root: RefObject<HTMLElement>) {
  useEffect(() => {
    let selecting = false;
    const selected = () => {
      const selection = window.getSelection();
      const node = root.current;
      if (!node || !selection || selection.isCollapsed) return;
      if (!node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) return;
      const target = selection.anchorNode?.parentElement;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (!selection.toString().trim()) return;
      return selectionClipboard(selection, node);
    };
    const copy = () => {
      const data = selected();
      if (data) void writeSelectionClipboard(data).catch(() => {});
    };
    const onCopy = (event: ClipboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const data = selected();
      if (!data || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', data.text);
      event.clipboardData.setData('text/html', data.html);
      event.preventDefault();
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
    document.addEventListener('copy', onCopy);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('keyup', key);
      document.removeEventListener('copy', onCopy);
    };
  }, [root]);
}
