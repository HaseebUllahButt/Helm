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

/** Copy after a drag, keyboard selection or the phone's selection handles settle. */
export function useCopySelection(root: RefObject<HTMLElement>) {
  useEffect(() => {
    let dragging = false;
    let selecting = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let last = '';
    let pending = '';
    let revision = 0;
    const editable = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)
      ?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    const selected = () => {
      const selection = window.getSelection();
      const node = root.current;
      if (!node || !selection?.rangeCount || selection.isCollapsed) return;
      if (!node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) return;
      if (editable(document.activeElement) || editable(selection.anchorNode) || editable(selection.focusNode)) return;
      if (!selection.toString().trim()) return;
      return selectionClipboard(selection, node);
    };
    const copy = () => {
      const data = selected();
      if (!data) return;
      const key = JSON.stringify(data);
      if (key === last || key === pending) return;
      pending = key;
      const attempt = ++revision;
      void writeSelectionClipboard(data).then(() => {
        if (attempt !== revision) return;
        last = key;
        showCopied();
      }, () => {
        // Keep it retryable: the next touch/key can supply browser activation.
      }).finally(() => { if (attempt === revision) pending = ''; });
    };
    const changed = () => {
      clearTimeout(settle);
      // Native phone handles do not always send pointer events to the page.
      // Observe selection changes on every device, including hybrid laptops.
      if (!window.getSelection()?.toString().trim()) { last = ''; pending = ''; revision++; return; }
      if (!dragging) settle = setTimeout(copy, 450);
    };
    const onCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || editable(event.target instanceof Node ? event.target : null)) return;
      const data = selected();
      if (!data || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', data.text);
      event.clipboardData.setData('text/html', data.html);
      event.preventDefault();
    };
    const down = (event: PointerEvent) => {
      clearTimeout(settle);
      const target = event.target instanceof Element ? event.target : null;
      selecting = !!target && !!root.current?.contains(target)
        && !target.closest('button, a') && !editable(target);
      if (selecting) { last = ''; pending = ''; revision++; }
      dragging = selecting && event.pointerType === 'mouse';
    };
    const up = (event: Event) => {
      dragging = false;
      if (selecting || (event.type === 'touchend' && (event.target === document || root.current?.contains(event.target as Node)))) copy();
      selecting = false;
    };
    const cancel = () => { selecting = false; dragging = false; changed(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Shift' || event.shiftKey || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) copy();
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('keyup', key);
    document.addEventListener('copy', onCopy);
    document.addEventListener('selectionchange', changed);
    document.addEventListener('touchend', up);
    return () => {
      revision++;
      clearTimeout(settle);
      document.removeEventListener('selectionchange', changed);
      document.removeEventListener('touchend', up);
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('keyup', key);
      document.removeEventListener('copy', onCopy);
    };
  }, [root]);
}
