import { useEffect, type RefObject } from 'react';
import { selectionClipboard, writeSelectionClipboard } from './copySelection';

/** A short "Copied" over the page; the hook has nothing of its own to render. */
let note: HTMLDivElement | null = null;
let noteTimer: ReturnType<typeof setTimeout> | undefined;
function showCopied() {
  note ??= Object.assign(document.createElement('div'), { className: 'selection-copied', textContent: 'Copied' });
  note.setAttribute('role', 'status');
  if (!note.isConnected) document.body.append(note);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => note?.remove(), 1100);
}

/**
 * Copy a completed selection, just as the terminal does.
 *
 * A phone selects with a long press and the drag handles. The page gets no
 * pointerup for either, so on touch it copies once the selection has sat
 * still for a moment. A browser that only lets a tap write the clipboard
 * (Safari) gets it on the next touch instead.
 */
export function useCopySelection(root: RefObject<HTMLElement>) {
  useEffect(() => {
    let selecting = false;
    let touch = matchMedia('(pointer: coarse)').matches;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let last = '';
    let waiting: { text: string; html: string } | null = null;
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
    const copyTouch = () => {
      const data = selected();
      if (!data || data.text === last) return;
      last = data.text;
      writeSelectionClipboard(data).then(() => { waiting = null; showCopied(); }, () => { waiting = data; });
    };
    const changed = () => {
      clearTimeout(settle);
      if (!touch) return;
      if (window.getSelection()?.isCollapsed) { last = ''; return; }
      settle = setTimeout(copyTouch, 450);
    };
    const touched = () => {
      if (!waiting) return;
      const data = waiting;
      waiting = null;
      void writeSelectionClipboard(data).then(showCopied, () => {});
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
      touch = event.pointerType === 'touch';
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
    document.addEventListener('selectionchange', changed);
    document.addEventListener('touchend', touched);
    return () => {
      clearTimeout(settle);
      document.removeEventListener('selectionchange', changed);
      document.removeEventListener('touchend', touched);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('keyup', key);
      document.removeEventListener('copy', onCopy);
    };
  }, [root]);
}
